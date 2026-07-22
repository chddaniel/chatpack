/**
 * The generic Web-standard HTTP handler (M2).
 *
 * Mounts the whole Chatpack REST API on one route using only WHATWG
 * `Request`/`Response` (MVP §2) — so it runs unchanged on Next.js App Router,
 * Bun, Deno, Cloudflare Workers, or Node (via a tiny bridge, see
 * `examples/node-server`).
 *
 * Routes (relative to `basePath`, default `/api/chat`):
 *
 * | Method | Path                              | Action                       |
 * | ------ | --------------------------------- | ---------------------------- |
 * | POST   | `/conversations`                  | find-or-create a 1:1 DM      |
 * | GET    | `/conversations?limit&cursor`     | list my conversations        |
 * | GET    | `/conversations/:id`              | fetch one conversation       |
 * | POST   | `/conversations/:id/messages`     | send a message               |
 * | GET    | `/conversations/:id/messages?limit&cursor` | list messages       |
 * | POST   | `/conversations/:id/read`         | update my last-read          |
 * | PATCH  | `/messages/:id`                   | edit my message              |
 * | DELETE | `/messages/:id`                   | soft-delete my message       |
 * | GET    | `/stream`                         | SSE: live events for me      |
 *
 * Errors are JSON: `{ "error": { "code": "...", "message": "..." } }` with
 * the status mapped from {@link ChatpackErrorCode}.
 *
 * @module
 */

import type { ChatpackApi } from "./chatpack";
import type { AuthHook } from "./config";
import { ChatpackError, type ChatpackErrorCode } from "./errors";
import type { ChatEvent, Transport } from "./transport";

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
 * `GET`/`POST`/`PATCH`/`DELETE` are the same function — named so they can be
 * re-exported directly from a Next.js App Router route file. `fetch` is the
 * same function again, named for generic Web-standard servers (Bun, Deno,
 * Workers).
 */
export interface ChatpackHandler {
  GET: (request: Request) => Promise<Response>;
  POST: (request: Request) => Promise<Response>;
  PATCH: (request: Request) => Promise<Response>;
  DELETE: (request: Request) => Promise<Response>;
  /** Generic entry point: `Bun.serve({ fetch: chat.handler().fetch })`. */
  fetch: (request: Request) => Promise<Response>;
}

/** HTTP status for each {@link ChatpackErrorCode}. */
const STATUS_BY_CODE: Record<ChatpackErrorCode, number> = {
  INVALID_INPUT: 400,
  FORBIDDEN_READ: 403,
  FORBIDDEN_WRITE: 403,
  NOT_MESSAGE_SENDER: 403,
  CONVERSATION_NOT_FOUND: 404,
  MESSAGE_NOT_FOUND: 404,
  MESSAGE_DELETED: 409,
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

function optionalMetadata(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new ChatpackError("INVALID_INPUT", `"metadata" must be a JSON object.`);
  }
  return value as Record<string, unknown>;
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
 * Format one SSE frame. The event id is `conversationId:seq` so a reconnecting
 * client's `Last-Event-ID` tells the server exactly where to gap-fill from.
 */
function sseFrame(event: ChatEvent): string {
  const id = `${event.conversationId}:${event.message.seq}`;
  return `id: ${id}\nevent: ${event.type}\ndata: ${JSON.stringify({
    type: event.type,
    conversationId: event.conversationId,
    message: event.message,
  })}\n\n`;
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
   * GET /stream — one SSE connection per client (MVP §9).
   *
   * - Live events: subscribes to the transport; server-side participation is
   *   re-checked per event via `recipientIds` (never trusted from the client).
   * - Gap-fill: `Last-Event-ID` header (or `?lastEventId=`) of the form
   *   `conversationId:seq` replays missed messages from storage before live
   *   events flow. Replayed events are `message.created` with the current
   *   snapshot — at-least-once semantics; clients dedupe by message id.
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
        });

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
          heartbeat = setInterval(() => enqueue(`: ping\n\n`), heartbeatIntervalMs);
          // Never keep a Node process alive just for heartbeats.
          if (typeof heartbeat === "object" && "unref" in heartbeat) heartbeat.unref();
        }
      },
      cancel() {
        closed = true;
        unsubscribe?.();
        if (heartbeat !== undefined) clearInterval(heartbeat);
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

    // Authenticate — the only auth touchpoint (MVP §2).
    const user = await resolveUser(request);
    if (!user || typeof user.id !== "string" || user.id === "") {
      return errorResponse(401, "UNAUTHENTICATED", "No authenticated user for this request.");
    }
    const userId = user.id;
    const method = request.method.toUpperCase();

    try {
      // GET /stream — SSE live events (M3)
      if (method === "GET" && segments.length === 1 && segments[0] === "stream") {
        return openStream(request, url, userId);
      }

      // POST /conversations — find-or-create a DM
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

      // GET /conversations — list mine
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

      // GET /conversations/:id
      if (method === "GET" && segments.length === 2 && segments[0] === "conversations") {
        const conversation = await api.getConversation({
          userId,
          conversationId: segments[1]!,
        });
        return json(200, { conversation });
      }

      // POST /conversations/:id/messages — send
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
        const message = await api.sendMessage({
          userId,
          conversationId: segments[1]!,
          body: requiredString(body["body"], "body"),
          ...(role !== undefined ? { role } : {}),
          ...(metadata !== undefined ? { metadata } : {}),
        });
        return json(201, { message });
      }

      // GET /conversations/:id/messages — history
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

      // POST /conversations/:id/read — durable read-state
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

      // PATCH /messages/:id — edit
      if (method === "PATCH" && segments.length === 2 && segments[0] === "messages") {
        const body = await readJsonBody(request);
        const message = await api.editMessage({
          userId,
          messageId: segments[1]!,
          body: requiredString(body["body"], "body"),
        });
        return json(200, { message });
      }

      // DELETE /messages/:id — soft-delete
      if (method === "DELETE" && segments.length === 2 && segments[0] === "messages") {
        const message = await api.deleteMessage({ userId, messageId: segments[1]! });
        return json(200, { message });
      }

      return errorResponse(404, "NOT_FOUND", `No route for ${method} ${url.pathname}.`);
    } catch (err) {
      if (err instanceof ChatpackError) {
        return errorResponse(STATUS_BY_CODE[err.code], err.code, err.message);
      }
      // Never leak internals — log server-side, return an opaque 500.
      console.error("chatpack: unhandled error while handling request", err);
      return errorResponse(500, "INTERNAL_ERROR", "Something went wrong.");
    }
  }

  return { GET: handle, POST: handle, PATCH: handle, DELETE: handle, fetch: handle };
}
