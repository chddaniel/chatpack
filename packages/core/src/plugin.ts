/**
 * The in-core plugin seam (`docs/decisions/0008`).
 *
 * Plugins extend Chatpack with real-time behavior, nested HTTP routes, and
 * blocking message validation without touching storage. The first-party trio
 * (typing, presence, receipts) lives in `@chatpack/core/plugins`; the seam is
 * deliberately minimal: exactly the hooks those integrations need.
 *
 * Rules:
 *
 * - Notification hooks (`onStreamOpen`, `onStreamClose`, `onMarkRead`,
 *   `onEventDelivered`) are fire-and-forget: a throwing plugin never breaks
 *   the request that triggered it (same rule as transport listeners).
 * - `handleCapabilityRequest` is a trusted opt-in bearer-capability route
 *   handler. It runs after path parsing and before host auth. Its read-only
 *   context contains no Chatpack API or authenticated user.
 * - `handleRequest` is a real route handler: it runs after core routes miss
 *   and before the 404. Thrown {@link ChatpackError}s map to normal JSON
 *   error responses.
 *
 * @module
 */

import type { ChatpackApi } from "./chatpack";
import { ChatpackError } from "./errors";
import type { BeforeMessageSendContext, BeforeMessageSendResult, ChatpackUser } from "./config";
import type { ChatEvent, EphemeralEvent, Transport } from "./transport";

/** Input for {@link PluginContext.publishEphemeral}. */
export interface PublishEphemeralInput {
  /** Namespaced event name, e.g. `"typing.started"`. Plugins own their namespace. */
  type: string;
  /** The conversation the signal belongs to, if any. */
  conversationId?: string;
  /** The user the signal is about. */
  senderId: string;
  /** The user ids that may receive the event. */
  recipientIds: string[];
  /** Event-specific data. Defaults to `{}`. */
  payload?: Record<string, unknown>;
}

/** Capabilities available to every plugin hook. */
export interface PluginContext {
  /** The server-side core API (permissions enforced per call). */
  api: ChatpackApi;
  /**
   * Publish a fire-and-forget {@link EphemeralEvent} on the transport. Never
   * stored, never replayed on reconnect.
   */
  publishEphemeral(input: PublishEphemeralInput): void;
}

/** Context for {@link ChatpackPlugin.handleRequest}. */
export interface PluginRequestContext extends PluginContext {
  /** The handler path prefix that produced this context. */
  basePath: string;
  /** The incoming request. */
  request: Request;
  /** Parsed request URL. */
  url: URL;
  /** Uppercased HTTP method. */
  method: string;
  /** Path segments after `basePath`, e.g. `["conversations", "c1", "typing"]`. */
  segments: string[];
  /** The authenticated user id (auth already ran). */
  userId: string;
  /** The complete authenticated user returned by the host auth hook. */
  user: ChatpackUser;
}

/**
 * Read-only context for {@link ChatpackPlugin.handleCapabilityRequest}.
 *
 * This is a trusted opt-in pre-auth seam for opaque bearer-capability routes.
 * It intentionally contains no authenticated user, Chatpack API, or domain
 * state. Only a plugin that is trusted as in-process server code should use it.
 */
export interface PluginCapabilityRequestContext {
  /** The handler path prefix that produced this context. */
  readonly basePath: string;
  /** The incoming request, unchanged. */
  readonly request: Request;
  /** Parsed request URL. */
  readonly url: URL;
  /** Uppercased HTTP method. */
  readonly method: string;
  /** Path segments after `basePath`. */
  readonly segments: readonly string[];
}

/** Context for {@link ChatpackPlugin.beforeMessageSend}. */
export interface PluginBeforeMessageSendContext extends PluginContext, BeforeMessageSendContext {}

/** Context for {@link ChatpackPlugin.onStreamOpen} / {@link ChatpackPlugin.onStreamClose}. */
export interface PluginStreamContext extends PluginContext {
  /** The user whose SSE stream opened or closed. */
  userId: string;
  /** Unique id for this SSE connection, stable across its lifecycle hooks. */
  connectionId: string;
}

/** Context for {@link ChatpackPlugin.onMarkRead}. */
export interface PluginMarkReadContext extends PluginContext {
  /** The user who updated their read-state. */
  userId: string;
  /** The conversation that was marked read. */
  conversationId: string;
  /** The last-read message id. */
  messageId: string;
  /** All participant user ids of the conversation. */
  recipientIds: string[];
}

/** Context for {@link ChatpackPlugin.onEventDelivered}. */
export interface PluginEventDeliveredContext extends PluginContext {
  /** The user whose live SSE stream just received the event. */
  userId: string;
  /** The durable event that was delivered (never an ephemeral event). */
  event: ChatEvent;
}

/**
 * A Chatpack plugin. Pass instances via `chatpack({ plugins: [...] })`.
 *
 * @example
 * ```ts
 * import { typing, presence, receipts } from "@chatpack/core/plugins";
 *
 * const chat = chatpack({
 *   storage: memoryAdapter(),
 *   auth: myAuth,
 *   plugins: [typing(), presence(), receipts()],
 * });
 * ```
 */
export interface ChatpackPlugin {
  /** Unique plugin name, used in logs. */
  name: string;
  /**
   * Runs after the application before hook and before message persistence.
   * Return a rewrite, or nothing to accept the current message. A throwing
   * non-Chatpack error becomes `MESSAGE_REJECTED`.
   */
  beforeMessageSend?(
    ctx: PluginBeforeMessageSendContext,
  ): Promise<BeforeMessageSendResult | void> | BeforeMessageSendResult | void;
  /**
   * Handle an HTTP request under `basePath` that no core route matched.
   * Return a `Response` to answer it, or `null` to pass to the next plugin
   * (and ultimately the 404).
   */
  handleRequest?(ctx: PluginRequestContext): Promise<Response | null> | Response | null;
  /**
   * Handle an explicitly opted-in bearer-capability request before host auth.
   * Return a `Response` to claim it, or `null` to continue through normal auth.
   * This is a trusted in-process hook: it receives only a read-only,
   * authentication-free request context and no Chatpack API or domain state.
   * Capability validation remains the responsibility of the claiming plugin.
   */
  handleCapabilityRequest?(
    ctx: PluginCapabilityRequestContext,
  ): Promise<Response | null> | Response | null;
  /** A user's SSE stream connected. Fire-and-forget. */
  onStreamOpen?(ctx: PluginStreamContext): unknown | Promise<unknown>;
  /** A user's SSE stream disconnected. Fire-and-forget. */
  onStreamClose?(ctx: PluginStreamContext): unknown | Promise<unknown>;
  /** A user durably updated their last-read state. Fire-and-forget. */
  onMarkRead?(ctx: PluginMarkReadContext): void;
  /**
   * A durable event was delivered to a connected user's live stream.
   * Fires once per connected stream (a user with two tabs triggers it twice)
   * - consumers must treat derived signals as at-least-once.
   */
  onEventDelivered?(ctx: PluginEventDeliveredContext): void;
}

/**
 * Internal dispatcher created by `chatpack()` and shared with the handler.
 * Wraps every notification hook in a try/catch so plugins can't break core.
 */
export interface PluginRuntime {
  /** Whether any plugin is registered (lets hot paths skip work). */
  hasPlugins: boolean;
  publishEphemeral(input: PublishEphemeralInput): void;
  /** First capability response wins; `null` continues to normal auth. */
  handleCapabilityRequest(input: PluginCapabilityRequestContext): Promise<Response | null>;
  /** First plugin response wins; `null` means "no plugin claimed the route". */
  handleRequest(input: {
    request: Request;
    url: URL;
    method: string;
    segments: string[];
    basePath: string;
    userId: string;
    user: ChatpackUser;
  }): Promise<Response | null>;
  /** Run blocking plugin message hooks in registration order. */
  runBeforeMessageSend(ctx: BeforeMessageSendContext): Promise<BeforeMessageSendResult>;
  notifyStreamOpen(userId: string, connectionId?: string): void | Promise<void>;
  notifyStreamClose(userId: string, connectionId?: string): void | Promise<void>;
  notifyMarkRead(input: {
    userId: string;
    conversationId: string;
    messageId: string;
    recipientIds: string[];
  }): void;
  notifyEventDelivered(userId: string, event: ChatEvent): void;
}

/** Create the {@link PluginRuntime} for a Chatpack instance. */
export function createPluginRuntime(
  plugins: ChatpackPlugin[],
  api: ChatpackApi,
  transport: Transport,
): PluginRuntime {
  function publishEphemeral(input: PublishEphemeralInput): void {
    const event: EphemeralEvent = {
      ephemeral: true,
      type: input.type,
      ...(input.conversationId !== undefined ? { conversationId: input.conversationId } : {}),
      senderId: input.senderId,
      recipientIds: input.recipientIds,
      payload: input.payload ?? {},
      at: new Date().toISOString(),
    };
    transport.publish(event);
  }

  const context: PluginContext = { api, publishEphemeral };

  /** Run a notification hook so a throwing plugin never breaks the caller. */
  function safely(
    plugin: ChatpackPlugin,
    hook: string,
    run: () => unknown | Promise<unknown>,
  ): void | Promise<void> {
    try {
      const result = run();
      if (result instanceof Promise) {
        return result.then(
          () => undefined,
          (err: unknown) => {
            console.error(`chatpack: plugin "${plugin.name}" threw in ${hook}`, err);
          },
        );
      }
    } catch (err) {
      console.error(`chatpack: plugin "${plugin.name}" threw in ${hook}`, err);
    }
  }

  return {
    hasPlugins: plugins.length > 0,
    publishEphemeral,

    async handleCapabilityRequest(input) {
      for (const plugin of plugins) {
        if (!plugin.handleCapabilityRequest) continue;
        const response = await plugin.handleCapabilityRequest({ ...input });
        if (response !== null) return response;
      }
      return null;
    },

    async handleRequest(input) {
      for (const plugin of plugins) {
        if (!plugin.handleRequest) continue;
        const response = await plugin.handleRequest({ ...context, ...input });
        if (response !== null) return response;
      }
      return null;
    },

    async runBeforeMessageSend(input) {
      let current: BeforeMessageSendContext = input;
      for (const plugin of plugins) {
        if (!plugin.beforeMessageSend) continue;

        let result: BeforeMessageSendResult | void;
        try {
          result = await plugin.beforeMessageSend({ ...context, ...current });
        } catch (err) {
          if (err instanceof ChatpackError) throw err;
          throw new ChatpackError(
            "MESSAGE_REJECTED",
            err instanceof Error && err.message ? err.message : "Message rejected.",
          );
        }

        current = {
          ...current,
          ...(result?.body !== undefined ? { body: result.body } : {}),
          ...(result?.metadata !== undefined ? { metadata: result.metadata } : {}),
        };
      }

      return { body: current.body, metadata: current.metadata };
    },

    notifyStreamOpen(userId, connectionId = "legacy") {
      const pending: Promise<void>[] = [];
      for (const plugin of plugins) {
        if (!plugin.onStreamOpen) continue;
        const result = safely(plugin, "onStreamOpen", () =>
          plugin.onStreamOpen!({ ...context, userId, connectionId }),
        );
        if (result instanceof Promise) pending.push(result);
      }
      return pending.length > 0 ? Promise.all(pending).then(() => undefined) : undefined;
    },

    notifyStreamClose(userId, connectionId = "legacy") {
      const pending: Promise<void>[] = [];
      for (const plugin of plugins) {
        if (!plugin.onStreamClose) continue;
        const result = safely(plugin, "onStreamClose", () =>
          plugin.onStreamClose!({ ...context, userId, connectionId }),
        );
        if (result instanceof Promise) pending.push(result);
      }
      return pending.length > 0 ? Promise.all(pending).then(() => undefined) : undefined;
    },

    notifyMarkRead(input) {
      for (const plugin of plugins) {
        if (!plugin.onMarkRead) continue;
        safely(plugin, "onMarkRead", () => plugin.onMarkRead!({ ...context, ...input }));
      }
    },

    notifyEventDelivered(userId, event) {
      for (const plugin of plugins) {
        if (!plugin.onEventDelivered) continue;
        safely(plugin, "onEventDelivered", () =>
          plugin.onEventDelivered!({ ...context, userId, event }),
        );
      }
    },
  };
}
