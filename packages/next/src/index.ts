/**
 * `@chatpack/next` — Next.js App Router integration for Chatpack.
 *
 * The Chatpack handler is already Web-standard (`Request` → `Response`), which
 * is exactly what App Router route handlers expect — so this package is a
 * deliberately thin convenience wrapper: it derives the `basePath` from your
 * route file location and returns the named exports a route file needs.
 *
 * @example
 * ```ts
 * // app/api/chat/[...chatpack]/route.ts
 * import { toNextRouteHandlers } from "@chatpack/next";
 * import { chat } from "@/lib/chat";
 *
 * export const { GET, POST, PATCH, DELETE } = toNextRouteHandlers(chat);
 * ```
 *
 * @module
 */

import type { ChatpackHandler, ChatpackInstance, HandlerOptions } from "@chatpack/core";

/** Options for {@link toNextRouteHandlers}. Same shape as core's `HandlerOptions`. */
export type NextRouteHandlerOptions = HandlerOptions;

/**
 * Produce App Router route handlers (`GET`, `POST`, `PATCH`, `DELETE`) for a
 * Chatpack instance.
 *
 * Mount them in a catch-all route so every Chatpack endpoint is served from
 * one file. The default `basePath` (`"/api/chat"`) matches the conventional
 * `app/api/chat/[...chatpack]/route.ts` location; pass `basePath` if you
 * mount elsewhere.
 */
export function toNextRouteHandlers(
  chat: ChatpackInstance,
  options: NextRouteHandlerOptions = {},
): ChatpackHandler {
  return chat.handler(options);
}
