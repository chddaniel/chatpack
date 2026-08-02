/** Contracts for composing per-client Chatpack plugin surfaces. */
import type { ChatClientResult } from "./errors";
import type { ClientRequestInit, ChatpackRequester } from "./request";
import type { ChatRealtime, ChatpackEvent } from "./realtime";
import { createStore, type ReadonlyStore, type Store } from "./store";

/** Services available while a client plugin is being created. */
export interface ClientPluginContext {
  request<T>(path: string, init?: ClientRequestInit): Promise<ChatClientResult<T>>;
  realtime: ChatRealtime;
  createStore<T>(initialValue: T): Store<T>;
}

/** Runtime actions, state, and cleanup returned by a client plugin. */
export interface ClientPluginInstance<Actions extends object, State> {
  actions: Actions;
  state: ReadonlyStore<State>;
  dispose?: () => void;
}

/** Typed declaration for a client plugin. */
export interface ChatClientPlugin<
  Id extends string = string,
  Actions extends object = Record<never, never>,
  State = Record<never, never>,
> {
  readonly id: Id;
  readonly eventTypes: readonly string[];
  readonly create: (context: ClientPluginContext) => ClientPluginInstance<Actions, State>;
}

/** Public action and state surface contributed by one plugin. */
export type PluginSurface<Plugin extends ChatClientPlugin> =
  Plugin extends ChatClientPlugin<infer Id, infer Actions, infer State>
    ? { [Key in Id]: Actions & { state: ReadonlyStore<State> } }
    : never;

type UnionToIntersection<Value> = (Value extends unknown ? (arg: Value) => void : never) extends (
  arg: infer Intersection,
) => void
  ? Intersection
  : never;

/** Intersected action and state surfaces contributed by several plugins. */
export type PluginSurfaces<Plugins extends readonly ChatClientPlugin[]> = UnionToIntersection<
  PluginSurface<Plugins[number]>
>;

/** Creates the context passed to a client plugin factory. */
export function createPluginContext(
  requester: ChatpackRequester,
  realtime: ChatRealtime,
): ClientPluginContext {
  return {
    request: requester.request,
    realtime,
    createStore,
  };
}

/** Disposes all plugin instances owned by a client. */
export function disposePlugins(plugins: readonly { dispose?: () => void }[]): void {
  for (const plugin of plugins) plugin.dispose?.();
}

/** Listener for any durable or ephemeral Chatpack event. */
export type EventListener = (event: ChatpackEvent) => void;
