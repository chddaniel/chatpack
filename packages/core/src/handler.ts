/**
 * The generic Web-standard HTTP handler (M2).
 *
 * Mounts the whole Chatpack REST API on one route using only WHATWG
 * `Request`/`Response` (MVP §2) - so it runs unchanged on Next.js App Router,
 * Bun, Deno, Cloudflare Workers, or Node (via a tiny bridge, see
 * `examples/node-server`).
 *
 * Routes (relative to `basePath`, default `/api/chat`):
 *
 * | Method | Path                              | Action                       |
 * | ------ | --------------------------------- | ---------------------------- |
 * | POST   | `/conversations`                  | find-or-create a 1:1 DM      |
 * | POST   | `/conversations/group`            | create a group               |
 * | GET    | `/conversations?limit&cursor`     | list my conversations        |
 * | GET    | `/conversations/:id`              | fetch one conversation       |
 * | PATCH  | `/conversations/:id`              | rename / set visibility      |
 * | POST   | `/conversations/:id/participants` | add group members            |
 * | DELETE | `/conversations/:id/participants` | remove a member / leave      |
 * | PATCH  | `/conversations/:id/participants` | change a member's role       |
 * | POST   | `/conversations/:id/messages`     | send a message               |
 * | GET    | `/conversations/:id/messages?limit&cursor` | list messages       |
 * | GET    | `/search/messages?q&limit&cursor` | search message bodies      |
 * | POST   | `/conversations/:id/read`         | update my last-read          |
 * | PATCH  | `/messages/:id`                   | edit my message              |
 * | DELETE | `/messages/:id`                   | soft-delete my message       |
 * | POST   | `/messages/:id/reactions`         | add my reaction              |
 * | DELETE | `/messages/:id/reactions`         | remove my reaction           |
 * | POST   | `/messages/:id/forward`           | forward it to another convo  |
 * | POST   | `/conversations/:id/invites`      | mint an invite link          |
 * | GET    | `/conversations/:id/invites`      | list a group's invites       |
 * | DELETE | `/conversations/:id/invites/:code` | revoke an invite            |
 * | GET    | `/invites/:code`                  | preview what a link admits to |
 * | POST   | `/invites/:code/accept`           | redeem an invite link        |
 * | POST   | `/conversations/:id/join-requests` | ask to join a group         |
 * | GET    | `/conversations/:id/join-requests?status&limit` | moderation queue |
 * | PATCH  | `/conversations/:id/join-requests` | approve/deny a request      |
 * | GET    | `/channels?limit&cursor`          | browse public channels       |
 * | POST   | `/conversations/:id/join`         | join a public channel        |
 * | POST/DELETE | `/moderation/blocks`       | manage private user blocks   |
 * | GET    | `/moderation/blocks`              | list my blocked users        |
 * | POST/DELETE | `/moderation/mutes`        | manage conversation mutes   |
 * | GET    | `/moderation/mutes`               | list my muted conversations  |
 * | POST   | `/moderation/reports`             | submit a report              |
 * | GET/PATCH | `/moderation/reports[/:id]`   | moderate reports             |
 * | GET/POST | `/moderation/bans`              | list or create bans          |
 * | DELETE | `/moderation/bans/:id`            | revoke a ban                 |
 * | GET    | `/stream`                         | SSE: live events for me      |
 *
 * Plugins (`chatpack({ plugins: [...] })`) may add routes of their own; they
 * are consulted after core routes miss, before the 404.
 *
 * Errors are JSON: `{ "error": { "code": "...", "message": "..." } }` with
 * the status mapped from {@link ChatpackErrorCode}.
 *
 * @module
 */

import type { ChatpackApi } from "./chatpack";
import type { AuthHook } from "./config";
import { ChatpackError, type ChatpackErrorCode } from "./errors";
import type { PluginRuntime } from "./plugin";
import {
  isConversationEvent,
  isEphemeralEvent,
  isMessageEvent,
  isReactionEvent,
  type TransportEvent,
  type Transport,
} from "./transport";

/** Options for {@link createHandler} / `chat.handler()`. */
export interface HandlerOptions {
  /**
   * The path prefix the API is mounted under. Everything after it is treated
   * as a Chatpack route. Default: `"/api/chat"`.
   */
  basePath?: string;
  /**
   * How often the SSE stream sends a comment heartbeat to keep proxies from
   * closing idle connections, in milliseconds. Default: 15000. Set to 0 to
   * disable (mainly for tests).
   */
  heartbeatIntervalMs?: number;
}

/**
 * The value returned by `chat.handler()`.
 *
 * `GET`/`POST`/`PATCH`/`DELETE`/`PUT` are the same function - named so they can be
 * re-exported directly from a Next.js App Router route file. `fetch` is the
 * same function again, named for generic Web-standard servers (Bun, Deno,
 * Workers).
 */
export interface ChatpackHandler {
  GET: (request: Request) => Promise<Response>;
  POST: (request: Request) => Promise<Response>;
  PATCH: (request: Request) => Promise<Response>;
  DELETE: (request: Request) => Promise<Response>;
  PUT: (request: Request) => Promise<Response>;
  /** Generic entry point: `Bun.serve({ fetch: chat.handler().fetch })`. */
  fetch: (request: Request) => Promise<Response>;
}

/** HTTP status for each {@link ChatpackErrorCode}. */
const STATUS_BY_CODE: Record<ChatpackErrorCode, number> = {
  SEARCH_UNSUPPORTED: 501,
  INVALID_INPUT: 400,
  FORBIDDEN_READ: 403,
  FORBIDDEN_WRITE: 403,
  NOT_MESSAGE_SENDER: 403,
  CONVERSATION_NOT_FOUND: 404,
  MESSAGE_NOT_FOUND: 404,
  MESSAGE_DELETED: 409,
  MESSAGE_REJECTED: 422,
  NOT_CONVERSATION_ADMIN: 403,
  NOT_GROUP_CONVERSATION: 409,
  LAST_ADMIN_REMAINING: 409,
  GROUP_LIMIT_EXCEEDED: 422,
  INVITES_UNSUPPORTED: 501,
  INVITE_NOT_FOUND: 404,
  // 410 Gone, not 404: the link existed and is permanently unusable, which is
  // what tells a client to ask for a new one rather than retry (ADR 0019 §9).
  INVITE_EXPIRED: 410,
  INVITE_LIMIT_EXCEEDED: 422,
  JOIN_REQUEST_NOT_FOUND: 404,
  ALREADY_PARTICIPANT: 409,
  CHANNELS_UNSUPPORTED: 501,
  // 403 Forbidden, not 404: the conversation exists and core knows it. A 404
  // would be a lie every other route would then have to keep telling to stay
  // consistent, and the caller already had the id (ADR 0020 §7).
  NOT_PUBLIC_CONVERSATION: 403,
  MODERATION_UNSUPPORTED: 501,
  USER_BANNED: 403,
  USER_NOT_FOUND: 404,
  NOT_MODERATOR: 403,
  DIRECT_INTERACTION_BLOCKED: 403,
  REPORT_NOT_FOUND: 404,
  BAN_NOT_FOUND: 404,
  // 400, not 403: the caller's own request is malformed - they named someone who
  // is not in the room - rather than being denied something they asked for
  // correctly (ADR 0023 §2).
  MENTION_NOT_PARTICIPANT: 400,
};

function json(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function errorResponse(status: number, code: string, message: string): Response {
  return json(status, { error: { code, message } });
}

async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = await request.json();
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("not an object");
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new ChatpackError("INVALID_INPUT", "Request body must be a JSON object.");
  }
}

/**
 * Like {@link readJsonBody}, but an absent or empty body means "no options".
 * Only for routes where every field is optional (group creation): there,
 * `fetch(url, { method: "POST" })` is a reasonable thing for a client to write,
 * and failing it with INVALID_INPUT would be a confusing 400. A body that *is*
 * present still has to be a JSON object.
 */
async function readOptionalJsonBody(request: Request): Promise<Record<string, unknown>> {
  let text: string;
  try {
    text = await request.text();
  } catch {
    throw new ChatpackError("INVALID_INPUT", "Request body must be a JSON object.");
  }
  if (text.trim() === "") return {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("not an object");
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new ChatpackError("INVALID_INPUT", "Request body must be a JSON object.");
  }
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new ChatpackError("INVALID_INPUT", `"${field}" must be a string.`);
  }
  return value;
}

function requiredString(value: unknown, field: string): string {
  const str = optionalString(value, field);
  if (str === undefined) {
    throw new ChatpackError("INVALID_INPUT", `"${field}" is required.`);
  }
  return str;
}

function optionalStringArray(value: unknown, field: string): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new ChatpackError("INVALID_INPUT", `"${field}" must be an array of strings.`);
  }
  return value as string[];
}

function requiredStringArray(value: unknown, field: string): string[] {
  const arr = optionalStringArray(value, field);
  if (arr === undefined) {
    throw new ChatpackError("INVALID_INPUT", `"${field}" is required.`);
  }
  return arr;
}

function optionalMetadata(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new ChatpackError("INVALID_INPUT", `"metadata" must be a JSON object.`);
  }
  return value as Record<string, unknown>;
}

function optionalNumber(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ChatpackError("INVALID_INPUT", `"${field}" must be a number.`);
  }
  return value;
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") {
    throw new ChatpackError("INVALID_INPUT", `"${field}" must be a boolean.`);
  }
  return value;
}

/**
 * Parse one of the two ADR 0020 channel enums off a request body.
 *
 * The valid-value check is duplicated in core (which is also reachable without
 * HTTP), and deliberately so: the handler's job is to reject a body it cannot
 * even shape into an api input, so `visibility: 7` never reaches the engine as
 * a number the type system was told is a union member.
 */
function optionalEnum<T extends string>(
  value: unknown,
  field: string,
  allowed: readonly T[],
): T | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new ChatpackError(
      "INVALID_INPUT",
      `"${field}" must be ${allowed.map((a) => `"${a}"`).join(" or ")}.`,
    );
  }
  return value as T;
}

const VISIBILITIES = ["private", "public"] as const;
const JOIN_POLICIES = ["open", "approval"] as const;

function optionalDate(value: unknown, field: string): Date | null | undefined {
  if (value === undefined || value === null) return value === null ? null : undefined;
  if (typeof value !== "string") {
    throw new ChatpackError("INVALID_INPUT", `"${field}" must be an ISO date string or null.`);
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new ChatpackError("INVALID_INPUT", `"${field}" must be a valid ISO date string.`);
  }
  return date;
}

function parseLimit(params: URLSearchParams): number | undefined {
  const raw = params.get("limit");
  if (raw === null) return undefined;
  const limit = Number(raw);
  if (!Number.isInteger(limit)) {
    throw new ChatpackError("INVALID_INPUT", `"limit" must be an integer, got "${raw}".`);
  }
  return limit;
}

/**
 * Format one SSE frame.
 *
 * Durable message events carry an `id:` of `conversationId:seq` so a
 * reconnecting client's `Last-Event-ID` tells the server exactly where to
 * gap-fill from. Ephemeral events carry **no** `id:` line - `EventSource`
 * never adopts them as `Last-Event-ID`, so typing/presence/receipt signals
 * can't disturb message gap-fill (`docs/decisions/0008`).
 *
 * Reaction and conversation events are durable-backed but also carry **no**
 * `id:` line: neither produces a new `seq`, so adopting one as `Last-Event-ID`
 * would poison gap-fill. Clients recover missed ones by refetching on reconnect
 * (`docs/decisions/0013`, `docs/decisions/0017`).
 */
function sseFrame(event: TransportEvent): string {
  if (isEphemeralEvent(event)) {
    return `event: ${event.type}\ndata: ${JSON.stringify({
      type: event.type,
      ephemeral: true,
      ...(event.conversationId !== undefined ? { conversationId: event.conversationId } : {}),
      senderId: event.senderId,
      payload: event.payload,
      at: event.at,
    })}\n\n`;
  }
  if (isConversationEvent(event)) {
    return `event: ${event.type}\ndata: ${JSON.stringify({
      type: event.type,
      conversationId: event.conversationId,
      actorId: event.actorId,
      affectedUserIds: event.affectedUserIds,
      conversation: event.conversation,
    })}\n\n`;
  }
  if (isReactionEvent(event)) {
    return `event: ${event.type}\ndata: ${JSON.stringify({
      type: event.type,
      conversationId: event.conversationId,
      actorId: event.actorId,
      emoji: event.emoji,
      message: event.message,
    })}\n\n`;
  }
  const id = `${event.conversationId}:${event.message.seq}`;
  return `id: ${id}\nevent: ${event.type}\ndata: ${JSON.stringify({
    type: event.type,
    conversationId: event.conversationId,
    message: event.message,
  })}\n\n`;
}

/**
 * Build the 401 body. The message is deliberately diagnostic: for AI-generated
 * integrations this response is often the only signal anyone looks at, so it
 * names the exact failure (bad hook return shape vs. no credentials on the
 * request) and the most common environmental cause: browsers drop
 * `SameSite=Lax` cookies inside any cross-site iframe, which is how AI app
 * builders (Lovable, v0, Bolt, Shipper, ...) embed their preview panes.
 */
function unauthenticatedResponse(request: Request, user: unknown): Response {
  let hint: string;
  if (user !== null && user !== undefined) {
    hint =
      `The auth hook returned ${typeof user === "object" ? "an object without a valid `id`" : `a ${typeof user}`}, ` +
      "but it must return `{ id: string }` (non-empty) or `null`. " +
      "A bare string or `{ userId }` is treated as unauthenticated.";
  } else if (!request.headers.get("cookie")) {
    hint =
      "The auth hook returned null and the request carried no `cookie` header. " +
      "If you expected cookie auth: the cookie was never sent. Browsers drop `SameSite=Lax` " +
      "cookies inside cross-site iframes (e.g. AI-builder preview panes) - set the " +
      "session cookie with `SameSite=None; Secure` (add `Partitioned` for Chrome). " +
      "If you expected header auth: `EventSource` cannot send custom headers - use a cookie for /stream.";
  } else {
    hint =
      "The auth hook returned null even though the request had a `cookie` header. " +
      'Check that the hook parses the raw `request.headers.get("cookie")` string ' +
      "(there is no `request.cookies` on a Web-standard Request) and that the cookie " +
      "name matches exactly.";
  }
  return errorResponse(401, "UNAUTHENTICATED", `No authenticated user for this request. ${hint}`);
}

/** Parse a `Last-Event-ID` / `lastEventId` value of the form `convId:seq`. */
function parseLastEventId(raw: string | null): { conversationId: string; seq: number } | null {
  if (!raw) return null;
  const separator = raw.lastIndexOf(":");
  if (separator <= 0) return null;
  const conversationId = raw.slice(0, separator);
  const seq = Number(raw.slice(separator + 1));
  if (!Number.isInteger(seq) || seq < 0) return null;
  return { conversationId, seq };
}

/**
 * Create the Web-standard request handler for a Chatpack API.
 *
 * Usually accessed via `chat.handler()` rather than called directly.
 */
export function createHandler(
  api: ChatpackApi,
  auth: AuthHook | undefined,
  options: HandlerOptions = {},
  transport?: Transport,
  plugins?: PluginRuntime,
  isUserBanned?: (userId: string) => Promise<boolean>,
): ChatpackHandler {
  if (!auth) {
    throw new Error(
      "chatpack: an `auth` hook is required to mount the HTTP handler. " +
        "Provide one in chatpack({ auth: async (req) => ... }).",
    );
  }
  const resolveUser: AuthHook = auth;

  const basePath = (options.basePath ?? "/api/chat").replace(/\/$/, "");
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? 15_000;

  /**
   * GET /stream - one SSE connection per client (MVP §9).
   *
   * - Live events: subscribes to the transport; server-side participation is
   *   re-checked per event via `recipientIds` (never trusted from the client).
   * - Gap-fill: `Last-Event-ID` header (or `?lastEventId=`) of the form
   *   `conversationId:seq` replays missed messages from storage before live
   *   events flow. Replayed events are `message.created` with the current
   *   snapshot - at-least-once semantics; clients dedupe by message id.
   */
  function openStream(request: Request, url: URL, userId: string): Response {
    if (!transport) {
      return errorResponse(500, "INTERNAL_ERROR", "No transport configured for streaming.");
    }
    const activeTransport = transport;
    const lastEventId = parseLastEventId(
      request.headers.get("last-event-id") ?? url.searchParams.get("lastEventId"),
    );

    const encoder = new TextEncoder();
    let unsubscribe: (() => void) | undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let closed = false;
    let banCheckInFlight = false;

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const enqueue = (text: string): void => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(text));
          } catch {
            // Consumer already gone; the cancel() callback cleans up.
          }
        };

        enqueue(`: connected\n\n`);

        // 1. Subscribe first, replay second: overlap is safe (at-least-once
        // + client dedupe by message id); a gap between replay and subscribe
        // is not.
        unsubscribe = activeTransport.subscribe((event) => {
          // Participation re-checked server-side on every publish (MVP §9).
          if (!event.recipientIds.includes(userId)) return;
          enqueue(sseFrame(event));
          // Only durable **message** events count as "delivered": ephemeral
          // events must never trigger further ephemeral events (no feedback
          // loops), and a reaction is not a message a receipt should tick.
          if (!closed && plugins?.hasPlugins && isMessageEvent(event)) {
            plugins.notifyEventDelivered(userId, event);
          }
        });

        // The stream is live: let plugins (e.g. presence) know.
        plugins?.notifyStreamOpen(userId);

        // 2. Replay anything missed since the client's last seen event.
        if (lastEventId) {
          try {
            const missed = await api.listMessagesAfter({
              userId,
              conversationId: lastEventId.conversationId,
              afterSeq: lastEventId.seq,
            });
            for (const message of missed) {
              enqueue(
                sseFrame({
                  type: "message.created",
                  conversationId: message.conversationId,
                  recipientIds: [userId],
                  message,
                }),
              );
            }
          } catch (err) {
            // A bad/foreign lastEventId must not kill the live stream.
            if (!(err instanceof ChatpackError)) {
              console.error("chatpack: gap-fill failed", err);
            }
          }
        }

        // 3. Heartbeat comments keep intermediaries from closing the socket.
        if (heartbeatIntervalMs > 0) {
          heartbeat = setInterval(() => {
            enqueue(`: ping\n\n`);
            if (!isUserBanned || banCheckInFlight || closed) return;
            banCheckInFlight = true;
            void isUserBanned(userId)
              .then((banned) => {
                if (!banned || closed) return;
                closed = true;
                unsubscribe?.();
                if (heartbeat !== undefined) clearInterval(heartbeat);
                try {
                  controller.close();
                } catch {
                  // Consumer already closed.
                }
                plugins?.notifyStreamClose(userId);
              })
              .catch((err) => console.error("chatpack: moderation ban check failed", err))
              .finally(() => {
                banCheckInFlight = false;
              });
          }, heartbeatIntervalMs);
          // Never keep a Node process alive just for heartbeats.
          if (typeof heartbeat === "object" && "unref" in heartbeat) heartbeat.unref();
        }
      },
      cancel() {
        closed = true;
        unsubscribe?.();
        if (heartbeat !== undefined) clearInterval(heartbeat);
        plugins?.notifyStreamClose(userId);
      },
    });

    return new Response(stream, {
      status: 200,
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      },
    });
  }

  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname !== basePath && !url.pathname.startsWith(`${basePath}/`)) {
      return errorResponse(404, "NOT_FOUND", `No route for ${url.pathname}.`);
    }
    const segments = url.pathname
      .slice(basePath.length)
      .split("/")
      .filter((s) => s !== "");

    const method = request.method.toUpperCase();

    try {
      // Capability routes may be claimed before auth. A null response falls
      // through to the normal authenticated request path.
      if (plugins?.hasPlugins) {
        try {
          const capabilityResponse = await plugins.handleCapabilityRequest({
            request,
            url,
            method,
            segments,
            basePath,
          });
          if (capabilityResponse !== null) return capabilityResponse;
        } catch (cause) {
          throw new Error("Capability request hook failed.", { cause });
        }
      }

      // Authenticate - the only auth touchpoint (MVP §2).
      const user = await resolveUser(request);
      if (!user || typeof user.id !== "string" || user.id === "") {
        return unauthenticatedResponse(request, user);
      }
      const userId = user.id;

      if (isUserBanned && (await isUserBanned(userId))) {
        return errorResponse(403, "USER_BANNED", `User "${userId}" has an active Chatpack ban.`);
      }

      // GET /stream - SSE live events (M3)
      if (method === "GET" && segments.length === 1 && segments[0] === "stream") {
        return openStream(request, url, userId);
      }

      // POST /conversations - find-or-create a DM
      if (method === "POST" && segments.length === 1 && segments[0] === "conversations") {
        const body = await readJsonBody(request);
        const metadata = optionalMetadata(body["metadata"]);
        const conversation = await api.getOrCreateConversation({
          userId,
          otherUserId: requiredString(body["otherUserId"], "otherUserId"),
          ...(metadata !== undefined ? { metadata } : {}),
        });
        return json(200, { conversation });
      }

      // GET /conversations - list mine
      if (method === "GET" && segments.length === 1 && segments[0] === "conversations") {
        const limit = parseLimit(url.searchParams);
        const cursor = url.searchParams.get("cursor") ?? undefined;
        const result = await api.listConversations({
          userId,
          ...(limit !== undefined ? { limit } : {}),
          ...(cursor !== undefined ? { cursor } : {}),
        });
        return json(200, result);
      }

      // POST /conversations/group - create a group (ADR 0017). Matched before
      // the /conversations/:id routes so "group" is never read as an id.
      if (
        method === "POST" &&
        segments.length === 2 &&
        segments[0] === "conversations" &&
        segments[1] === "group"
      ) {
        const body = await readOptionalJsonBody(request);
        const name = optionalString(body["name"], "name");
        const userIds = optionalStringArray(body["userIds"], "userIds");
        const metadata = optionalMetadata(body["metadata"]);
        const visibility = optionalEnum(body["visibility"], "visibility", VISIBILITIES);
        const joinPolicy = optionalEnum(body["joinPolicy"], "joinPolicy", JOIN_POLICIES);
        const conversation = await api.createGroupConversation({
          userId,
          ...(name !== undefined ? { name } : {}),
          ...(userIds !== undefined ? { userIds } : {}),
          ...(metadata !== undefined ? { metadata } : {}),
          ...(visibility !== undefined ? { visibility } : {}),
          ...(joinPolicy !== undefined ? { joinPolicy } : {}),
        });
        return json(201, { conversation });
      }

      // GET /conversations/:id
      if (method === "GET" && segments.length === 2 && segments[0] === "conversations") {
        const conversation = await api.getConversation({
          userId,
          conversationId: segments[1]!,
        });
        return json(200, { conversation });
      }

      // PATCH /conversations/:id - rename a group (ADR 0017) and/or set channel
      // visibility (ADR 0020). `name: null` clears the title, so it is nullable
      // rather than merely optional.
      if (method === "PATCH" && segments.length === 2 && segments[0] === "conversations") {
        const body = await readJsonBody(request);
        const visibility = optionalEnum(body["visibility"], "visibility", VISIBILITIES);
        const joinPolicy = optionalEnum(body["joinPolicy"], "joinPolicy", JOIN_POLICIES);
        // `name` became optional when ADR 0020 added two sibling fields, but it
        // stays required when it is the only field present - so `PATCH {}` is
        // still the same 400 it always was, and no existing caller changes.
        if (!("name" in body) && visibility === undefined && joinPolicy === undefined) {
          throw new ChatpackError("INVALID_INPUT", `"name" is required.`);
        }
        const raw = body["name"];
        if (raw !== undefined && raw !== null && typeof raw !== "string") {
          throw new ChatpackError("INVALID_INPUT", `"name" must be a string or null.`);
        }
        const conversation = await api.updateConversation({
          userId,
          conversationId: segments[1]!,
          ...("name" in body ? { name: raw as string | null } : {}),
          ...(visibility !== undefined ? { visibility } : {}),
          ...(joinPolicy !== undefined ? { joinPolicy } : {}),
        });
        return json(200, { conversation });
      }

      // POST /conversations/:id/participants - add members (ADR 0017)
      if (
        method === "POST" &&
        segments.length === 3 &&
        segments[0] === "conversations" &&
        segments[2] === "participants"
      ) {
        const body = await readJsonBody(request);
        const conversation = await api.addParticipants({
          userId,
          conversationId: segments[1]!,
          userIds: requiredStringArray(body["userIds"], "userIds"),
        });
        return json(200, { conversation });
      }

      // DELETE /conversations/:id/participants - remove a member, or leave when
      // `userId` is the caller. Body-carried like reaction removal (ADR 0017).
      if (
        method === "DELETE" &&
        segments.length === 3 &&
        segments[0] === "conversations" &&
        segments[2] === "participants"
      ) {
        const body = await readJsonBody(request);
        const conversation = await api.removeParticipant({
          userId,
          conversationId: segments[1]!,
          targetUserId: requiredString(body["userId"], "userId"),
        });
        return json(200, { conversation });
      }

      // PATCH /conversations/:id/participants - promote/demote (ADR 0017)
      if (
        method === "PATCH" &&
        segments.length === 3 &&
        segments[0] === "conversations" &&
        segments[2] === "participants"
      ) {
        const body = await readJsonBody(request);
        const role = requiredString(body["role"], "role");
        if (role !== "admin" && role !== "member") {
          throw new ChatpackError("INVALID_INPUT", `"role" must be "admin" or "member".`);
        }
        const conversation = await api.setParticipantRole({
          userId,
          conversationId: segments[1]!,
          targetUserId: requiredString(body["userId"], "userId"),
          role,
        });
        return json(200, { conversation });
      }

      // POST/DELETE /moderation/blocks - manage the caller's private blocks.
      if (
        method === "POST" &&
        segments.length === 2 &&
        segments[0] === "moderation" &&
        segments[1] === "blocks"
      ) {
        const body = await readJsonBody(request);
        const block = await api.moderation.blockUser({
          userId,
          targetUserId: requiredString(body["targetUserId"], "targetUserId"),
        });
        return json(200, { block });
      }
      if (
        method === "DELETE" &&
        segments.length === 2 &&
        segments[0] === "moderation" &&
        segments[1] === "blocks"
      ) {
        const body = await readJsonBody(request);
        await api.moderation.unblockUser({
          userId,
          targetUserId: requiredString(body["targetUserId"], "targetUserId"),
        });
        return json(200, { ok: true });
      }
      if (
        method === "GET" &&
        segments.length === 2 &&
        segments[0] === "moderation" &&
        segments[1] === "blocks"
      ) {
        const page = await api.moderation.listBlockedUsers({
          userId,
          limit: parseLimit(url.searchParams),
          ...(url.searchParams.get("cursor") === null
            ? {}
            : { cursor: url.searchParams.get("cursor")! }),
        });
        return json(200, page);
      }

      // POST/DELETE /moderation/mutes - manage the caller's mutes.
      if (
        method === "POST" &&
        segments.length === 2 &&
        segments[0] === "moderation" &&
        segments[1] === "mutes"
      ) {
        const body = await readJsonBody(request);
        const mute = await api.moderation.muteConversation({
          userId,
          conversationId: requiredString(body["conversationId"], "conversationId"),
        });
        return json(200, { mute });
      }
      if (
        method === "DELETE" &&
        segments.length === 2 &&
        segments[0] === "moderation" &&
        segments[1] === "mutes"
      ) {
        const body = await readJsonBody(request);
        await api.moderation.unmuteConversation({
          userId,
          conversationId: requiredString(body["conversationId"], "conversationId"),
        });
        return json(200, { ok: true });
      }
      if (
        method === "GET" &&
        segments.length === 2 &&
        segments[0] === "moderation" &&
        segments[1] === "mutes"
      ) {
        const page = await api.moderation.listMutedConversations({
          userId,
          limit: parseLimit(url.searchParams),
          ...(url.searchParams.get("cursor") === null
            ? {}
            : { cursor: url.searchParams.get("cursor")! }),
        });
        return json(200, page);
      }

      // POST /moderation/reports - submit a user, message, or conversation report.
      if (
        method === "POST" &&
        segments.length === 2 &&
        segments[0] === "moderation" &&
        segments[1] === "reports"
      ) {
        const body = await readJsonBody(request);
        const report = await api.moderation.report({
          userId,
          targetType: requiredString(body["targetType"], "targetType") as
            "user" | "message" | "conversation",
          targetId: requiredString(body["targetId"], "targetId"),
          reason: requiredString(body["reason"], "reason"),
        });
        return json(200, { report });
      }
      if (
        method === "GET" &&
        segments.length === 2 &&
        segments[0] === "moderation" &&
        segments[1] === "reports"
      ) {
        const status = url.searchParams.get("status");
        const targetType = url.searchParams.get("targetType");
        const reports = await api.moderation.listReports({
          userId,
          ...(status === null
            ? {}
            : { status: status as "open" | "triaged" | "resolved" | "dismissed" }),
          ...(targetType === null
            ? {}
            : { targetType: targetType as "user" | "message" | "conversation" }),
          limit: parseLimit(url.searchParams),
          ...(url.searchParams.get("cursor") === null
            ? {}
            : { cursor: url.searchParams.get("cursor")! }),
        });
        return json(200, reports);
      }
      if (segments.length === 3 && segments[0] === "moderation" && segments[1] === "reports") {
        if (method === "GET") {
          const report = await api.moderation.getReport({ userId, reportId: segments[2]! });
          return json(200, { report });
        }
        if (method === "PATCH") {
          const body = await readJsonBody(request);
          const moderatorNote =
            body["moderatorNote"] === undefined
              ? undefined
              : optionalString(body["moderatorNote"], "moderatorNote");
          const report = await api.moderation.updateReport({
            userId,
            reportId: segments[2]!,
            status: requiredString(body["status"], "status") as
              "open" | "triaged" | "resolved" | "dismissed",
            ...(moderatorNote === undefined ? {} : { moderatorNote }),
          });
          return json(200, { report });
        }
      }

      // GET/POST /moderation/bans and DELETE /moderation/bans/:id.
      if (
        method === "GET" &&
        segments.length === 2 &&
        segments[0] === "moderation" &&
        segments[1] === "bans"
      ) {
        const active = url.searchParams.get("activeOnly");
        const bans = await api.moderation.listBans({
          userId,
          ...(active === null ? {} : { activeOnly: active !== "false" }),
          limit: parseLimit(url.searchParams),
          ...(url.searchParams.get("cursor") === null
            ? {}
            : { cursor: url.searchParams.get("cursor")! }),
        });
        return json(200, bans);
      }
      if (
        method === "POST" &&
        segments.length === 2 &&
        segments[0] === "moderation" &&
        segments[1] === "bans"
      ) {
        const body = await readJsonBody(request);
        const expiresAt = optionalDate(body["expiresAt"], "expiresAt");
        const reason =
          body["reason"] === undefined ? undefined : optionalString(body["reason"], "reason");
        const ban = await api.moderation.banUser({
          userId,
          targetUserId: requiredString(body["targetUserId"], "targetUserId"),
          ...(reason === undefined ? {} : { reason }),
          ...(expiresAt === undefined ? {} : { expiresAt }),
        });
        return json(200, { ban });
      }
      if (
        method === "DELETE" &&
        segments.length === 3 &&
        segments[0] === "moderation" &&
        segments[1] === "bans"
      ) {
        const ban = await api.moderation.unbanUser({ userId, banId: segments[2]! });
        return json(200, { ban });
      }

      // POST /conversations/:id/messages - send
      if (
        method === "POST" &&
        segments.length === 3 &&
        segments[0] === "conversations" &&
        segments[2] === "messages"
      ) {
        const body = await readJsonBody(request);
        const role = optionalString(body["role"], "role");
        if (role !== undefined && role !== "user" && role !== "assistant" && role !== "system") {
          throw new ChatpackError(
            "INVALID_INPUT",
            `"role" must be "user", "assistant", or "system".`,
          );
        }
        const metadata = optionalMetadata(body["metadata"]);
        const replyToMessageId = optionalString(body["replyToMessageId"], "replyToMessageId");
        const mentions = optionalStringArray(body["mentions"], "mentions");
        const message = await api.sendMessage({
          userId,
          conversationId: segments[1]!,
          body: requiredString(body["body"], "body"),
          ...(role !== undefined ? { role } : {}),
          ...(replyToMessageId !== undefined ? { replyToMessageId } : {}),
          ...(mentions !== undefined ? { mentions } : {}),
          ...(metadata !== undefined ? { metadata } : {}),
        });
        return json(201, { message });
      }

      // GET /conversations/:id/messages - history
      if (
        method === "GET" &&
        segments.length === 3 &&
        segments[0] === "conversations" &&
        segments[2] === "messages"
      ) {
        const limit = parseLimit(url.searchParams);
        const cursor = url.searchParams.get("cursor") ?? undefined;
        const result = await api.listMessages({
          userId,
          conversationId: segments[1]!,
          ...(limit !== undefined ? { limit } : {}),
          ...(cursor !== undefined ? { cursor } : {}),
        });
        return json(200, result);
      }

      // GET /search/messages - ranked, permission-filtered search
      if (
        method === "GET" &&
        segments.length === 2 &&
        segments[0] === "search" &&
        segments[1] === "messages"
      ) {
        const limit = parseLimit(url.searchParams);
        const cursor = url.searchParams.get("cursor") ?? undefined;
        const result = await api.searchMessages({
          userId,
          query: url.searchParams.get("q") ?? "",
          ...(limit !== undefined ? { limit } : {}),
          ...(cursor !== undefined ? { cursor } : {}),
        });
        return json(200, result);
      }

      // POST /conversations/:id/read - durable read-state
      if (
        method === "POST" &&
        segments.length === 3 &&
        segments[0] === "conversations" &&
        segments[2] === "read"
      ) {
        const body = await readJsonBody(request);
        await api.markRead({
          userId,
          conversationId: segments[1]!,
          messageId: requiredString(body["messageId"], "messageId"),
        });
        return json(200, { ok: true });
      }

      // POST /messages/:id/reactions - add my reaction (idempotent)
      //
      // POST rather than the more idiomatic PUT: `chat.handler()` is
      // re-exported by method name in Next.js route files, so adding a verb
      // would 405 in every already-mounted app (`docs/decisions/0013`).
      if (
        method === "POST" &&
        segments.length === 3 &&
        segments[0] === "messages" &&
        segments[2] === "reactions"
      ) {
        const body = await readJsonBody(request);
        const message = await api.addReaction({
          userId,
          messageId: segments[1]!,
          emoji: requiredString(body["emoji"], "emoji"),
        });
        return json(200, { message });
      }

      // DELETE /messages/:id/reactions - remove my reaction (idempotent)
      //
      // The emoji travels in the body, not the path: reaction keys are
      // arbitrary strings (custom emoji ids, `:shortcodes:`) and multi-codepoint
      // emoji percent-encode into long, easily-mangled path segments.
      if (
        method === "DELETE" &&
        segments.length === 3 &&
        segments[0] === "messages" &&
        segments[2] === "reactions"
      ) {
        const body = await readJsonBody(request);
        const message = await api.removeReaction({
          userId,
          messageId: segments[1]!,
          emoji: requiredString(body["emoji"], "emoji"),
        });
        return json(200, { message });
      }

      // POST /messages/:id/forward - copy it into another conversation (ADR 0024)
      //
      // The `{ message }` returned is the NEW message in the target, not the
      // source: the caller already had the source, and the forward is what they
      // need to render. POST for the same Next.js re-export reason as above.
      if (
        method === "POST" &&
        segments.length === 3 &&
        segments[0] === "messages" &&
        segments[2] === "forward"
      ) {
        const body = await readJsonBody(request);
        const role = optionalString(body["role"], "role");
        if (role !== undefined && role !== "user" && role !== "assistant" && role !== "system") {
          throw new ChatpackError(
            "INVALID_INPUT",
            `"role" must be "user", "assistant", or "system".`,
          );
        }
        const metadata = optionalMetadata(body["metadata"]);
        const mentions = optionalStringArray(body["mentions"], "mentions");
        const message = await api.forwardMessage({
          userId,
          messageId: segments[1]!,
          toConversationId: requiredString(body["conversationId"], "conversationId"),
          ...(role !== undefined ? { role } : {}),
          ...(mentions !== undefined ? { mentions } : {}),
          ...(metadata !== undefined ? { metadata } : {}),
        });
        return json(201, { message });
      }

      // POST /conversations/:id/invites - mint an invite link (ADR 0019)
      if (
        method === "POST" &&
        segments.length === 3 &&
        segments[0] === "conversations" &&
        segments[2] === "invites"
      ) {
        // Every field is optional - an admin wanting "a link, no limits" should
        // be able to POST with no body at all.
        const body = await readOptionalJsonBody(request);
        const expiresInSeconds = optionalNumber(body["expiresInSeconds"], "expiresInSeconds");
        const maxUses = optionalNumber(body["maxUses"], "maxUses");
        const requiresApproval = optionalBoolean(body["requiresApproval"], "requiresApproval");
        const metadata = optionalMetadata(body["metadata"]);
        const invite = await api.createInvite({
          userId,
          conversationId: segments[1]!,
          ...(expiresInSeconds !== undefined ? { expiresInSeconds } : {}),
          ...(maxUses !== undefined ? { maxUses } : {}),
          ...(requiresApproval !== undefined ? { requiresApproval } : {}),
          ...(metadata !== undefined ? { metadata } : {}),
        });
        return json(201, { invite });
      }

      // GET /conversations/:id/invites - list a group's invites (ADR 0019)
      if (
        method === "GET" &&
        segments.length === 3 &&
        segments[0] === "conversations" &&
        segments[2] === "invites"
      ) {
        const invites = await api.listInvites({ userId, conversationId: segments[1]! });
        return json(200, { invites });
      }

      // DELETE /conversations/:id/invites/:code - revoke (ADR 0019)
      //
      // The code sits in the path here, unlike a reaction emoji: invite codes
      // are base64url, so there is nothing to percent-encode or mangle.
      if (
        method === "DELETE" &&
        segments.length === 4 &&
        segments[0] === "conversations" &&
        segments[2] === "invites"
      ) {
        await api.revokeInvite({
          userId,
          conversationId: segments[1]!,
          code: segments[3]!,
        });
        return json(200, { ok: true });
      }

      // POST /invites/:code/accept - redeem a link (ADR 0019). Matched before
      // GET /invites/:code by segment count, so "accept" is never read as a code.
      if (
        method === "POST" &&
        segments.length === 3 &&
        segments[0] === "invites" &&
        segments[2] === "accept"
      ) {
        const body = await readOptionalJsonBody(request);
        const message = optionalString(body["message"], "message");
        const result = await api.acceptInvite({
          userId,
          code: segments[1]!,
          ...(message !== undefined ? { message } : {}),
        });
        return json(200, result);
      }

      // GET /invites/:code - preview what a link admits you to (ADR 0019).
      // Authenticated like every route, but the only one a non-member may call -
      // so the payload deliberately carries a participant count, never ids.
      if (method === "GET" && segments.length === 2 && segments[0] === "invites") {
        const invite = await api.getInvitePreview({ userId, code: segments[1]! });
        return json(200, { invite });
      }

      // POST /conversations/:id/join-requests - ask to join (ADR 0019)
      if (
        method === "POST" &&
        segments.length === 3 &&
        segments[0] === "conversations" &&
        segments[2] === "join-requests"
      ) {
        const body = await readOptionalJsonBody(request);
        const message = optionalString(body["message"], "message");
        const joinRequest = await api.requestToJoin({
          userId,
          conversationId: segments[1]!,
          ...(message !== undefined ? { message } : {}),
        });
        return json(201, { joinRequest });
      }

      // GET /conversations/:id/join-requests - the moderation queue (ADR 0019)
      if (
        method === "GET" &&
        segments.length === 3 &&
        segments[0] === "conversations" &&
        segments[2] === "join-requests"
      ) {
        const status = url.searchParams.get("status") ?? undefined;
        if (
          status !== undefined &&
          status !== "pending" &&
          status !== "approved" &&
          status !== "denied"
        ) {
          throw new ChatpackError(
            "INVALID_INPUT",
            `"status" must be "pending", "approved" or "denied".`,
          );
        }
        const limit = parseLimit(url.searchParams);
        const joinRequests = await api.listJoinRequests({
          userId,
          conversationId: segments[1]!,
          ...(status !== undefined ? { status } : {}),
          ...(limit !== undefined ? { limit } : {}),
        });
        return json(200, { joinRequests });
      }

      // PATCH /conversations/:id/join-requests - approve or deny (ADR 0019).
      // Addressed by `userId`, not the request's own id: one pending request per
      // user per group, and an admin acting on the queue has the user in hand.
      if (
        method === "PATCH" &&
        segments.length === 3 &&
        segments[0] === "conversations" &&
        segments[2] === "join-requests"
      ) {
        const body = await readJsonBody(request);
        const decision = requiredString(body["decision"], "decision");
        if (decision !== "approve" && decision !== "deny") {
          throw new ChatpackError("INVALID_INPUT", `"decision" must be "approve" or "deny".`);
        }
        const result = await api.resolveJoinRequest({
          userId,
          conversationId: segments[1]!,
          targetUserId: requiredString(body["userId"], "userId"),
          decision,
        });
        return json(200, result);
      }

      // GET /channels - browse the public directory (ADR 0020). Its own prefix
      // rather than /conversations/public because it does not return
      // conversations: hanging previews off that prefix invites clients to
      // assume otherwise.
      if (method === "GET" && segments.length === 1 && segments[0] === "channels") {
        const limit = parseLimit(url.searchParams);
        const cursor = url.searchParams.get("cursor") ?? undefined;
        const result = await api.listPublicConversations({
          userId,
          ...(limit !== undefined ? { limit } : {}),
          ...(cursor !== undefined ? { cursor } : {}),
        });
        return json(200, result);
      }

      // POST /conversations/:id/join - self-service entry into a public channel
      // (ADR 0020). 200 rather than 201 for both outcomes: "joined" creates no
      // new addressable resource, and a `status`-discriminated body already
      // tells the client which of the two happened.
      if (
        method === "POST" &&
        segments.length === 3 &&
        segments[0] === "conversations" &&
        segments[2] === "join"
      ) {
        const body = await readOptionalJsonBody(request);
        const message = optionalString(body["message"], "message");
        const result = await api.joinConversation({
          userId,
          conversationId: segments[1]!,
          ...(message !== undefined ? { message } : {}),
        });
        return json(200, result);
      }

      // PATCH /messages/:id - edit
      if (method === "PATCH" && segments.length === 2 && segments[0] === "messages") {
        const body = await readJsonBody(request);
        // Omitting `mentions` leaves the stored set alone; sending `[]` clears it
        // (ADR 0023 §3). `null` reads as "not supplied" here, same as everywhere
        // else in this handler, so clearing needs the empty array.
        const mentions = optionalStringArray(body["mentions"], "mentions");
        const message = await api.editMessage({
          userId,
          messageId: segments[1]!,
          body: requiredString(body["body"], "body"),
          ...(mentions !== undefined ? { mentions } : {}),
        });
        return json(200, { message });
      }

      // DELETE /messages/:id - soft-delete
      if (method === "DELETE" && segments.length === 2 && segments[0] === "messages") {
        const message = await api.deleteMessage({ userId, messageId: segments[1]! });
        return json(200, { message });
      }

      // No core route matched - offer the request to plugins before the 404.
      if (plugins?.hasPlugins) {
        const pluginResponse = await plugins.handleRequest({
          request,
          url,
          method,
          segments,
          basePath,
          userId,
          user,
        });
        if (pluginResponse !== null) return pluginResponse;
      }

      return errorResponse(404, "NOT_FOUND", `No route for ${method} ${url.pathname}.`);
    } catch (err) {
      if (err instanceof ChatpackError) {
        return errorResponse(STATUS_BY_CODE[err.code], err.code, err.message);
      }
      // Never leak internals - log server-side, return an opaque 500.
      console.error("chatpack: unhandled error while handling request", err);
      return errorResponse(500, "INTERNAL_ERROR", "Something went wrong.");
    }
  }

  return { GET: handle, POST: handle, PATCH: handle, DELETE: handle, PUT: handle, fetch: handle };
}
