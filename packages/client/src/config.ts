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
}
