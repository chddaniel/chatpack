/**
 * The in-core plugin seam (`docs/decisions/0008`).
 *
 * Plugins extend Chatpack with real-time behavior — extra HTTP routes and
 * reactions to core actions — without touching storage. The first-party trio
 * (typing, presence, receipts) lives in `@chatpack/core/plugins`; the seam is
 * deliberately minimal: exactly the hooks those plugins need and nothing more.
 *
 * Rules:
 *
 * - Notification hooks (`onStreamOpen`, `onStreamClose`, `onMarkRead`,
 *   `onEventDelivered`) are fire-and-forget: a throwing plugin never breaks
 *   the request that triggered it (same rule as transport listeners).
 * - `handleRequest` is a real route handler: it runs after core routes miss
 *   and before the 404. Thrown {@link ChatpackError}s map to normal JSON
 *   error responses.
 *
 * @module
 */

import type { ChatpackApi } from "./chatpack";
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
}

/** Context for {@link ChatpackPlugin.onStreamOpen} / {@link ChatpackPlugin.onStreamClose}. */
export interface PluginStreamContext extends PluginContext {
  /** The user whose SSE stream opened or closed. */
  userId: string;
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
   * Handle an HTTP request under `basePath` that no core route matched.
   * Return a `Response` to answer it, or `null` to pass to the next plugin
   * (and ultimately the 404).
   */
  handleRequest?(ctx: PluginRequestContext): Promise<Response | null> | Response | null;
  /** A user's SSE stream connected. Fire-and-forget. */
  onStreamOpen?(ctx: PluginStreamContext): void;
  /** A user's SSE stream disconnected. Fire-and-forget. */
  onStreamClose?(ctx: PluginStreamContext): void;
  /** A user durably updated their last-read state. Fire-and-forget. */
  onMarkRead?(ctx: PluginMarkReadContext): void;
  /**
   * A durable event was delivered to a connected user's live stream.
   * Fires once per connected stream (a user with two tabs triggers it twice)
   * — consumers must treat derived signals as at-least-once.
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
  /** First plugin response wins; `null` means "no plugin claimed the route". */
  handleRequest(input: {
    request: Request;
    url: URL;
    method: string;
    segments: string[];
    userId: string;
  }): Promise<Response | null>;
  notifyStreamOpen(userId: string): void;
  notifyStreamClose(userId: string): void;
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
  function safely(plugin: ChatpackPlugin, hook: string, run: () => void): void {
    try {
      run();
    } catch (err) {
      console.error(`chatpack: plugin "${plugin.name}" threw in ${hook}`, err);
    }
  }

  return {
    hasPlugins: plugins.length > 0,
    publishEphemeral,

    async handleRequest(input) {
      for (const plugin of plugins) {
        if (!plugin.handleRequest) continue;
        const response = await plugin.handleRequest({ ...context, ...input });
        if (response !== null) return response;
      }
      return null;
    },

    notifyStreamOpen(userId) {
      for (const plugin of plugins) {
        if (!plugin.onStreamOpen) continue;
        safely(plugin, "onStreamOpen", () => plugin.onStreamOpen!({ ...context, userId }));
      }
    },

    notifyStreamClose(userId) {
      for (const plugin of plugins) {
        if (!plugin.onStreamClose) continue;
        safely(plugin, "onStreamClose", () => plugin.onStreamClose!({ ...context, userId }));
      }
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
