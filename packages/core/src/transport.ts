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

/** Callback invoked for each event delivered to a subscription. */
export type TransportListener = (event: ChatEvent) => void;

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
  publish(event: ChatEvent): void;
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
    publish(event: ChatEvent): void {
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
