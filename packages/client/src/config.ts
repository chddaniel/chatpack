import type { ChatClientPlugin } from "./plugin";

export type ChatpackFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface ChatpackEventSource {
  readonly readyState: number;
  addEventListener(type: string, listener: (event: Event) => void): void;
  removeEventListener(type: string, listener: (event: Event) => void): void;
  close(): void;
  onopen: EventListener | null;
  onerror: EventListener | null;
}

export type EventSourceFactory = (url: string, init: EventSourceInit) => ChatpackEventSource;

export interface ChatpackRequestContext {
  url: string;
  method: string;
}

export type ChatpackHeaders =
  HeadersInit | ((context: ChatpackRequestContext) => HeadersInit | Promise<HeadersInit>);

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
