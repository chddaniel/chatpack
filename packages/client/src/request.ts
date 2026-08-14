/** REST request construction, response parsing, and error mapping. */

import type { ChatpackErrorCode } from "@chatpack/core";
import type { ChatpackFetch, ChatpackHeaders, ChatpackRequestContext } from "./config";
import {
  createClientError,
  failure,
  type ChatClientResult,
  type ChatpackClientErrorCode,
  success,
} from "./errors";

/** Client-specific request options layered over the Fetch API. */
export interface ClientRequestInit {
  method?: string;
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  headers?: HeadersInit;
  signal?: AbortSignal;
}

/** Internal request interface shared with client plugins. */
export interface ChatpackRequester {
  request<T>(path: string, init?: ClientRequestInit): Promise<ChatClientResult<T>>;
}

function normalizedPath(path: string): string {
  return path.startsWith("/") ? path : "/" + path;
}

/** Normalize a Chatpack route prefix while preserving the empty-root option. */
export function normalizeBasePath(basePath = "/api/chat"): string {
  const trimmed = basePath.trim();
  if (trimmed === "" || trimmed === "/") return "";
  return "/" + trimmed.replace(/^\/+|\/+$/g, "");
}

/** Build a request URL from an origin, route prefix, and resource path. */
export function buildURL(baseURL: string | undefined, basePath: string, path = ""): string {
  const prefix = (baseURL?.replace(/\/+$/g, "") ?? "") + basePath;
  const result = prefix + normalizedPath(path);
  return result === "/" ? result : result.replace(/([^:]\/)\/+/g, "$1");
}

function errorCodeForStatus(status: number): ChatpackClientErrorCode {
  if (status === 401) return "UNAUTHENTICATED";
  if (status === 404) return "NOT_FOUND";
  if (status >= 500) return "INTERNAL_ERROR";
  return "HTTP_ERROR";
}

/**
 * Every server error code, passed through verbatim. `satisfies` makes this
 * exhaustive over `ChatpackErrorCode` the way `STATUS_BY_CODE` is in core's
 * handler: when core adds a code, this fails typecheck instead of silently
 * flattening the new code to `HTTP_ERROR` (which is how the four group codes
 * and `MESSAGE_REJECTED` went missing before ADR 0017's client work).
 */
const serverErrorCodes = {
  SEARCH_UNSUPPORTED: true,
  FORBIDDEN_READ: true,
  FORBIDDEN_WRITE: true,
  CONVERSATION_NOT_FOUND: true,
  MESSAGE_NOT_FOUND: true,
  NOT_MESSAGE_SENDER: true,
  MESSAGE_DELETED: true,
  MESSAGE_REJECTED: true,
  NOT_CONVERSATION_ADMIN: true,
  NOT_GROUP_CONVERSATION: true,
  LAST_ADMIN_REMAINING: true,
  GROUP_LIMIT_EXCEEDED: true,
  INVITES_UNSUPPORTED: true,
  INVITE_NOT_FOUND: true,
  INVITE_EXPIRED: true,
  INVITE_LIMIT_EXCEEDED: true,
  JOIN_REQUEST_NOT_FOUND: true,
  ALREADY_PARTICIPANT: true,
  CHANNELS_UNSUPPORTED: true,
  NOT_PUBLIC_CONVERSATION: true,
  MODERATION_UNSUPPORTED: true,
  USER_BANNED: true,
  NOT_MODERATOR: true,
  DIRECT_INTERACTION_BLOCKED: true,
  REPORT_NOT_FOUND: true,
  BAN_NOT_FOUND: true,
  MENTION_NOT_PARTICIPANT: true,
  INVALID_INPUT: true,
} satisfies Record<ChatpackErrorCode, true>;

/** Client-side codes a proxy or gateway may also legitimately produce. */
const clientOnlyErrorCodes: Partial<Record<string, ChatpackClientErrorCode>> = {
  UNAUTHENTICATED: "UNAUTHENTICATED",
  NOT_FOUND: "NOT_FOUND",
  INTERNAL_ERROR: "INTERNAL_ERROR",
  HTTP_ERROR: "HTTP_ERROR",
};

function knownErrorCode(code: string): ChatpackClientErrorCode | undefined {
  if (Object.hasOwn(serverErrorCodes, code)) return code as ChatpackErrorCode;
  return clientOnlyErrorCodes[code];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readErrorPayload(value: unknown): { code?: string; message?: string } {
  if (!isRecord(value) || !isRecord(value.error)) return {};
  const code = typeof value.error.code === "string" ? value.error.code : undefined;
  const message = typeof value.error.message === "string" ? value.error.message : undefined;
  return {
    ...(code === undefined ? {} : { code }),
    ...(message === undefined ? {} : { message }),
  };
}

async function parseBody(response: Response): Promise<{ value: unknown; valid: boolean }> {
  const text = await response.text();
  if (text.trim() === "") return { value: undefined, valid: true };
  try {
    return { value: JSON.parse(text) as unknown, valid: true };
  } catch {
    return { value: undefined, valid: false };
  }
}

/** Create the configured JSON requester used by the client and plugins. */
export function createRequester(options: {
  baseURL?: string;
  basePath: string;
  credentials: RequestCredentials;
  headers?: ChatpackHeaders;
  fetch?: ChatpackFetch;
}): ChatpackRequester {
  const fetchImpl = options.fetch ?? globalThis.fetch?.bind(globalThis);

  return {
    async request<T>(path: string, init: ClientRequestInit = {}) {
      const method = (init.method ?? "GET").toUpperCase();
      const url = buildURL(options.baseURL, options.basePath, path);
      const context: ChatpackRequestContext = { url, method };
      const headers = new Headers(
        typeof options.headers === "function" ? await options.headers(context) : options.headers,
      );
      if (init.headers !== undefined) {
        new Headers(init.headers).forEach((value, key) => headers.set(key, value));
      }

      const requestURL = new URL(
        url,
        typeof window === "undefined" ? "http://chatpack.invalid" : window.location.origin,
      );
      for (const [key, value] of Object.entries(init.query ?? {})) {
        if (value !== undefined) requestURL.searchParams.set(key, String(value));
      }

      const hasBody = init.body !== undefined;
      if (hasBody && !headers.has("content-type")) headers.set("content-type", "application/json");
      if (fetchImpl === undefined) {
        return failure<T>(
          createClientError("NETWORK_ERROR", "No fetch implementation is available.", null),
        );
      }

      let response: Response;
      try {
        response = await fetchImpl(requestURL.toString(), {
          method,
          headers,
          credentials: options.credentials,
          ...(hasBody ? { body: JSON.stringify(init.body) } : {}),
          ...(init.signal === undefined ? {} : { signal: init.signal }),
        });
      } catch (error) {
        return failure<T>(
          createClientError("NETWORK_ERROR", "Chatpack request failed.", null, error),
        );
      }

      const body = await parseBody(response);
      if (!response.ok) {
        const payload = readErrorPayload(body.value);
        const code = payload.code ?? errorCodeForStatus(response.status);
        const knownCode = knownErrorCode(code) ?? "HTTP_ERROR";
        return failure<T>(
          createClientError(
            knownCode,
            payload.message ?? "Chatpack request failed with status " + response.status + ".",
            response.status,
          ),
        );
      }

      if (!body.valid) {
        return failure<T>(
          createClientError("INVALID_RESPONSE", "Chatpack returned invalid JSON.", response.status),
        );
      }
      if (body.value === undefined && response.status !== 204) {
        return failure<T>(
          createClientError(
            "INVALID_RESPONSE",
            "Chatpack returned an empty response.",
            response.status,
          ),
        );
      }
      return success(body.value as T);
    },
  };
}

/** Unwrap a named success envelope such as `{ conversation }` or `{ message }`. */
export function unwrapResult<T>(
  result: ChatClientResult<unknown>,
  key: string,
): ChatClientResult<T> {
  if (result.error !== null) return result;
  if (!isRecord(result.data) || !(key in result.data)) {
    return failure<T>(
      createClientError("INVALID_RESPONSE", 'Chatpack response is missing "' + key + '".', null),
    );
  }
  return success(result.data[key] as T);
}

/** A named key plus a cursor returned by a paginated REST route. */
export type ClientPageResult<Key extends string, Item> = {
  [Property in Key]: Item[];
} & { nextCursor: string | null };

/** Unwrap and validate a cursor-paginated response envelope. */
export function unwrapPageResult<Key extends string, Item>(
  result: ChatClientResult<ClientPageResult<Key, Item>>,
  key: Key,
): ChatClientResult<ClientPageResult<Key, Item>> {
  if (result.error !== null) return result;
  if (
    !isRecord(result.data) ||
    !Array.isArray(result.data[key]) ||
    (result.data.nextCursor !== null && typeof result.data.nextCursor !== "string")
  ) {
    return failure(
      createClientError(
        "INVALID_RESPONSE",
        'Chatpack response must contain an array "' + key + '" and a string or null "nextCursor".',
        null,
      ),
    );
  }
  return success({
    [key]: result.data[key] as Item[],
    nextCursor: result.data.nextCursor as string | null,
  } as ClientPageResult<Key, Item>);
}

/** Unwrap and validate the `{ ok: true }` response used by delete routes. */
export function unwrapOkResult(
  result: ChatClientResult<{ ok: true }>,
): ChatClientResult<{ ok: true }> {
  if (result.error !== null) return result;
  if (!isRecord(result.data) || result.data.ok !== true) {
    return failure(
      createClientError("INVALID_RESPONSE", 'Chatpack response is missing "ok: true".', null),
    );
  }
  return success({ ok: true });
}
