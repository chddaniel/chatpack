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
 *
 * Errors are JSON: `{ "error": { "code": "...", "message": "..." } }` with
 * the status mapped from {@link ChatpackErrorCode}.
 *
 * @module
 */

import type { ChatpackApi } from "./chatpack";
import type { AuthHook } from "./config";
import { ChatpackError, type ChatpackErrorCode } from "./errors";

/** Options for {@link createHandler} / `chat.handler()`. */
export interface HandlerOptions {
  /**
   * The path prefix the API is mounted under. Everything after it is treated
   * as a Chatpack route. Default: `"/api/chat"`.
   */
  basePath?: string;
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
 * Create the Web-standard request handler for a Chatpack API.
 *
 * Usually accessed via `chat.handler()` rather than called directly.
 */
export function createHandler(
  api: ChatpackApi,
  auth: AuthHook | undefined,
  options: HandlerOptions = {},
): ChatpackHandler {
  if (!auth) {
    throw new Error(
      "chatpack: an `auth` hook is required to mount the HTTP handler. " +
        "Provide one in chatpack({ auth: async (req) => ... }).",
    );
  }
  const resolveUser: AuthHook = auth;

  const basePath = (options.basePath ?? "/api/chat").replace(/\/$/, "");

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
