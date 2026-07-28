/**
 * The transport contract — the second of the two interfaces that carry the
 * whole Chatpack design (MVP §6): publish/subscribe of live message events to
 * connected SSE clients.
 *
 * Durable data and live events stay separate on purpose (MVP §6): storage has
 * durability requirements, the transport is fire-and-forget fan-out. v0 ships
 * a single-node in-process implementation ({@link inProcessTransport});
 * the interface is shaped so a Redis/pub-sub adapter can drop in later with
 * **no public API changes** (MVP §5).
 *
 * Two kinds of events travel on the transport (`docs/decisions/0008`):
 *
 * - {@link ChatEvent} — durable message events, backed by storage, replayable
 *   on reconnect via `Last-Event-ID` gap-fill.
 * - {@link EphemeralEvent} — fire-and-forget signals (typing, presence,
 *   receipt ticks) that are never stored and never replayed. Miss one and
 *   it's gone — which is correct for "Alice is typing…".
 *
 * @module
 */

import type { Message } from "./types";

/**
 * A live event published on the transport whenever a message is created,
 * edited, or soft-deleted.
 *
 * Every event carries the full {@link Message} snapshot — consumers reconcile
 * by `message.id` + `message.seq` (see `docs/decisions/0003`), so events are
 * safe to receive more than once (at-least-once delivery, MVP §9).
 */
export interface ChatEvent {
  /** What happened. */
  type: "message.created" | "message.updated" | "message.deleted";
  /** The conversation the event belongs to. */
  conversationId: string;
  /** The user ids that may receive this event (the two participants). */
  recipientIds: string[];
  /** Full message snapshot after the action. */
  message: Message;
}

/**
 * A fire-and-forget live signal that is **never persisted** and **never
 * replayed** on reconnect (`docs/decisions/0008`).
 *
 * Ephemeral events power the real-time plugins (typing indicators, presence,
 * delivery/read ticks). Their SSE frames carry no `id:` field, so they never
 * disturb `Last-Event-ID` gap-fill for durable messages.
 */
export interface EphemeralEvent {
  /** Discriminant separating ephemeral events from durable {@link ChatEvent}s. */
  ephemeral: true;
  /**
   * Namespaced event name, e.g. `"typing.started"`, `"presence.online"`,
   * `"receipt.read"`. Plugins own their namespace.
   */
  type: string;
  /** The conversation this signal belongs to, if any (presence has none). */
  conversationId?: string;
  /** The user the signal is about (who is typing, who came online, …). */
  senderId: string;
  /** The user ids that may receive this event. */
  recipientIds: string[];
  /** Event-specific data, JSON-serializable. */
  payload: Record<string, unknown>;
  /** ISO-8601 timestamp of when the signal was published. */
  at: string;
}

/** Any event carried by the transport: durable or ephemeral. */
export type TransportEvent = ChatEvent | EphemeralEvent;

/** Type guard: is this transport event an {@link EphemeralEvent}? */
export function isEphemeralEvent(event: TransportEvent): event is EphemeralEvent {
  return "ephemeral" in event && event.ephemeral === true;
}

/** Callback invoked for each event delivered to a subscription. */
export type TransportListener = (event: TransportEvent) => void;

/**
 * Publish/subscribe of live chat events.
 *
 * Implementations must be fire-and-forget on the publish side: a slow or
 * failing subscriber must never block or fail the send path (MVP §9 —
 * durable-first: the message already exists in storage before publish).
 */
export interface Transport {
  /**
   * Publish an event to all current subscribers. Must not throw; must not
   * await subscriber work.
   */
  publish(event: TransportEvent): void;
  /**
   * Subscribe to all events. Filtering (per-user, per-conversation) is the
   * caller's job — core re-checks participation server-side on every publish
   * rather than trusting subscription parameters (MVP §9).
   *
   * Returns an unsubscribe function.
   */
  subscribe(listener: TransportListener): () => void;
}

/**
 * The v0 single-node transport: an in-process listener set.
 *
 * Correct for a single server process (MVP §5 says single-node loudly). For
 * multi-node deployments a Redis/pub-sub transport can implement the same
 * interface later.
 */
export function inProcessTransport(): Transport {
  const listeners = new Set<TransportListener>();

  return {
    publish(event: TransportEvent): void {
      for (const listener of listeners) {
        try {
          listener(event);
        } catch (err) {
          // A broken subscriber must never break the send path.
          console.error("chatpack: transport listener threw", err);
        }
      }
    },
    subscribe(listener: TransportListener): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
