/** Configuration contracts for the framework-agnostic Chatpack client. */

import type { ChatClientPlugin } from "./plugin";

/** Fetch-compatible function used by REST requests. */
export type ChatpackFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** Minimal EventSource contract used by the realtime client and its tests. */
export interface ChatpackEventSource {
  readonly readyState: number;
  addEventListener(type: string, listener: (event: Event) => void): void;
  removeEventListener(type: string, listener: (event: Event) => void): void;
  close(): void;
  onopen: EventListener | null;
  onerror: EventListener | null;
}

/** Factory used to inject a browser or runtime-specific EventSource. */
export type EventSourceFactory = (url: string, init: EventSourceInit) => ChatpackEventSource;

/** Context supplied to dynamic REST-header functions. */
export interface ChatpackRequestContext {
  url: string;
  method: string;
}

/** Static or dynamic headers applied to REST requests. */
export type ChatpackHeaders =
  HeadersInit | ((context: ChatpackRequestContext) => HeadersInit | Promise<HeadersInit>);

/** Options for creating one framework-agnostic Chatpack client instance. */
/**
 * How the client keeps data live (`docs/decisions/0016`).
 *
 * - `auto` (default) - open the SSE stream, and fall back to polling if the
 *   stream cannot be opened or drops. Recovers to SSE when a later connect
 *   succeeds. This is what makes a serverless deploy work unconfigured.
 * - `sse` - stream only, never poll. Pre-0.4 behaviour.
 * - `poll` - poll only, never open a stream. Use when you know the platform
 *   cannot hold a connection and want to skip the failed attempt.
 */
export type ChatRealtimeMode = "auto" | "sse" | "poll";

/** Realtime transport configuration (`docs/decisions/0016`). */
export interface ChatRealtimeOptions {
  mode?: ChatRealtimeMode;
  /**
   * Poll interval in milliseconds. Defaults to 5000 and is clamped to a
   * 1000ms floor, because a tighter loop costs the server more than it buys
   * the user.
   */
  intervalMs?: number;
}

export interface ChatClientOptions<
  Plugins extends readonly ChatClientPlugin[] = readonly ChatClientPlugin[],
> {
  baseURL?: string;
  basePath?: string;
  credentials?: RequestCredentials;
  headers?: ChatpackHeaders;
  fetch?: ChatpackFetch;
  eventSource?: EventSourceFactory;
  plugins?: Plugins;
  /**
   * Realtime transport. Omit it and the client uses `auto`: SSE where it
   * works, polling where it doesn't.
   *
   * Polling refreshes durable data only - messages (including edits, deletes
   * and reactions) and the conversations list. Typing, presence and receipts
   * are ephemeral and never stored (`docs/decisions/0008`), so there is
   * nothing to poll: `useTyping` stays `null` while polling.
   */
  realtime?: ChatRealtimeOptions;
  /**
   * The signed-in user's id. Optional and **not** authentication - Chatpack
   * always trusts the server's auth hook. The cache uses it so the viewer's
   * own messages never increment `unreadCount` on the conversations list.
   * Without it, the client infers the id from the first message it sends.
   */
  userId?: string;
}
