/**
 * `@chatpack/transport-redis` - a Redis pub/sub {@link Transport} for Chatpack.
 *
 * The default transport (`inProcessTransport`) fans events out to subscribers
 * inside **one** server process, which is correct for a single node and wrong
 * the moment you run two: Alice's SSE stream on node A never hears about Bob's
 * message handled by node B. This package closes that gap by relaying every
 * published event through a Redis channel, so all nodes see all events.
 *
 * It implements the same two-method `Transport` interface core already accepts,
 * so adopting it is a one-line change with no other API difference:
 *
 * ```ts
 * import { chatpack } from "@chatpack/core";
 * import { redisTransport } from "@chatpack/transport-redis";
 * import { Redis } from "ioredis";
 *
 * // Two connections: a Redis client in subscriber mode cannot issue PUBLISH.
 * const transport = redisTransport({
 *   publisher: new Redis(process.env.REDIS_URL!),
 *   subscriber: new Redis(process.env.REDIS_URL!),
 * });
 *
 * export const chat = chatpack({ storage, auth, transport });
 * ```
 *
 * **Bring your own client.** Anything matching {@link RedisPublisher} /
 * {@link RedisSubscriber} works - `ioredis`, `node-redis` v4+, or a fake in
 * tests. Chatpack does not depend on a Redis driver, so there is no version to
 * keep compatible and no second copy of one in your bundle.
 *
 * **What this fixes and what it does not.** Messages, typing signals, and
 * receipt ticks all travel on the transport, so they go multi-node here.
 * `presence()` is different: it counts live connections in a per-process `Map`
 * (`docs/decisions/0008`), so each node still only knows about its own
 * connections. Multi-node presence needs shared state and is not solved by this
 * package - see `docs/decisions/0012`.
 *
 * @module
 */

import type { Transport, TransportEvent } from "@chatpack/core";
import { decodeEnvelope, encodeEnvelope } from "./serialize";

/** The default Redis channel events are relayed on. */
export const DEFAULT_CHANNEL = "chatpack:events";

/**
 * The publish half of a Redis client (`ioredis` and `node-redis` both satisfy
 * this). Only `publish` is ever called.
 */
export interface RedisPublisher {
  publish(channel: string, message: string): Promise<unknown> | unknown;
}

/**
 * How a driver's `subscribe` is called - a **union of the two real shapes**, not
 * one permissive signature.
 *
 * That distinction is load-bearing, and getting it wrong is not theoretical:
 * this type used to be the single signature `subscribe(channel, listener?)`,
 * which is satisfied by *neither* driver this package documents. node-redis
 * rejects it on arity (its listener is required, so it cannot be passed to a
 * caller that may omit one), and ioredis rejects it on type (its optional second
 * argument is a Node-style `(err, count)` completion callback, so a message
 * listener is not assignable to it). Anything written against the README needed
 * a cast to compile.
 *
 * A union has no such problem: a client only has to match one arm.
 */
export type RedisSubscribeMethod =
  /** `ioredis`: the channel only - messages arrive on the `"message"` event. */
  | ((channel: string) => Promise<unknown> | unknown)
  /** `node-redis` v4+: the message listener is passed inline. */
  | ((
      channel: string,
      listener: (payload: string, channel: string) => void,
    ) => Promise<unknown> | unknown);

/**
 * The subscribe half of a Redis client. This must be a **separate connection**
 * from the publisher: once a Redis connection subscribes it enters subscriber
 * mode and rejects `PUBLISH`.
 *
 * The two common drivers disagree on how messages are delivered, so both shapes
 * are supported and detected at runtime:
 *
 * - **`ioredis`** exposes an event emitter: `subscribe(channel)`, then
 *   `on("message", (channel, payload) => ...)`. (Its optional second argument
 *   to `subscribe` is a Node-style `(err, count)` completion callback, *not* a
 *   message listener - passing a message handler there would never fire.)
 * - **`node-redis` v4+** takes the listener inline:
 *   `subscribe(channel, (payload, channel) => ...)`, and does *not* emit a
 *   `"message"` event at all.
 *
 * Detection cannot use the presence of `on`: **both** drivers are
 * `EventEmitter`s, so that test sends node-redis down the ioredis path, where
 * `subscribe(channel)` without a listener leaves it with nothing to call and no
 * event is ever delivered. The reliable discriminator is the casing of the
 * pattern-subscribe method, which the two drivers spell differently:
 * node-redis has camelCase `pSubscribe`, ioredis has lowercase `psubscribe`.
 * Exactly one delivery path is ever wired, so no event is handled twice.
 */
export interface RedisSubscriber {
  subscribe: RedisSubscribeMethod;
  unsubscribe?(channel: string): Promise<unknown> | unknown;
  on?(event: "message", listener: (channel: string, payload: string) => void): unknown;
  off?(event: "message", listener: (channel: string, payload: string) => void): unknown;
  /** Present on `node-redis` v4+ (camelCase) - used to identify that driver. */
  pSubscribe?: unknown;
}

/** Where a transport failure happened, for {@link RedisTransportOptions.onError}. */
export type RedisTransportErrorContext = "publish" | "receive" | "subscribe";

/** Options for {@link redisTransport}. */
export interface RedisTransportOptions {
  /** Redis client used to `PUBLISH`. */
  publisher: RedisPublisher;
  /**
   * A **second** Redis client, used to `SUBSCRIBE`. Must not be the same
   * connection as `publisher`.
   */
  subscriber: RedisSubscriber;
  /**
   * The channel to relay events on. Default: `"chatpack:events"`. Override to
   * isolate environments that share one Redis instance (e.g. `staging` vs
   * `prod`), or to shard traffic.
   */
  channel?: string;
  /**
   * Unique id for this process. Used to drop the node's own echoed events -
   * local subscribers already received them synchronously from `publish()`.
   * Defaults to a random id, which is what you want; override only for
   * deterministic tests.
   */
  nodeId?: string;
  /**
   * Called when a publish, an inbound payload, or the subscription itself
   * fails. Defaults to `console.error`. A transport failure must never fail the
   * request that triggered it (the message is already durably stored), so this
   * is a reporting seam - wire it to your error tracker.
   */
  onError?: (error: unknown, context: RedisTransportErrorContext) => void;
}

/** A Chatpack transport with a Redis-specific lifecycle. */
export interface RedisTransport extends Transport {
  /**
   * The id this node tags its outbound events with (so they can be dropped on
   * the way back in). Exposed for logging and tests.
   */
  readonly nodeId: string;
  /**
   * Stop relaying: unsubscribe from the channel and drop all local listeners.
   * The Redis connections themselves are yours to close - this package did not
   * open them.
   */
  close(): Promise<void>;
}

function randomNodeId(): string {
  const globalCrypto: { randomUUID?: () => string } | undefined = globalThis.crypto;
  if (typeof globalCrypto?.randomUUID === "function") return globalCrypto.randomUUID();
  // Older runtimes without Web Crypto: uniqueness only needs to hold across the
  // nodes sharing one channel, not globally.
  return `node-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
}

/**
 * Create a Redis pub/sub transport.
 *
 * Semantics, and how they line up with what core already guarantees:
 *
 * - **`publish` stays synchronous and never throws.** The `Transport` contract
 *   requires it (a slow or broken transport must not block or fail the send
 *   path - the message is already in storage). Local subscribers are notified
 *   inline; the Redis `PUBLISH` is fire-and-forget, and a rejected publish goes
 *   to `onError` instead of surfacing to the caller. The visible consequence of
 *   a Redis outage is therefore *other nodes miss live events* - senders still
 *   succeed and history stays correct, because clients gap-fill from storage on
 *   reconnect (`docs/decisions/0006`).
 * - **Local delivery is not routed through Redis.** Subscribers on the
 *   publishing node get the event synchronously, exactly as with
 *   `inProcessTransport`, so single-node behavior and tests are unchanged and
 *   a Redis hiccup cannot delay same-node delivery.
 * - **No echo.** Every envelope is tagged with `nodeId`; inbound envelopes from
 *   this node are dropped, since those events were already delivered locally.
 * - **At-least-once overall, as before.** Redis pub/sub itself is at-most-once
 *   (an event published while a node is disconnected is simply lost), which is
 *   why durable events remain replayable from storage and ephemeral ones are
 *   explicitly droppable. Clients already dedupe by message id.
 */
export function redisTransport(options: RedisTransportOptions): RedisTransport {
  const { publisher, subscriber } = options;
  if ((publisher as unknown) === (subscriber as unknown)) {
    throw new Error(
      "chatpack: redisTransport() needs two separate Redis connections - a client in " +
        "subscriber mode cannot PUBLISH. Pass distinct `publisher` and `subscriber` clients.",
    );
  }

  const channel = options.channel ?? DEFAULT_CHANNEL;
  const nodeId = options.nodeId ?? randomNodeId();
  const reportError =
    options.onError ??
    ((error: unknown, context: RedisTransportErrorContext) =>
      console.error(`chatpack: redis transport ${context} failed`, error));

  const listeners = new Set<(event: TransportEvent) => void>();
  let closed = false;

  /** Deliver to this node's own subscribers. A broken one must not stop the rest. */
  function fanOutLocally(event: TransportEvent): void {
    for (const listener of listeners) {
      try {
        listener(event);
      } catch (err) {
        console.error("chatpack: transport listener threw", err);
      }
    }
  }

  /** Handle a payload that arrived on the Redis channel. */
  function handleInbound(payload: unknown): void {
    if (closed) return;
    try {
      if (typeof payload !== "string") return;
      const envelope = decodeEnvelope(payload);
      // Unparseable payload, or our own event coming back to us.
      if (envelope === null || envelope.nodeId === nodeId) return;
      fanOutLocally(envelope.event);
    } catch (err) {
      reportError(err, "receive");
    }
  }

  // One delivery path only, chosen by driver shape (see RedisSubscriber).
  // node-redis is identified by its camelCase `pSubscribe`; everything else
  // (ioredis, and fakes shaped like it) is driven as an event emitter. Both
  // drivers have `on`, so that cannot be the test.
  const isNodeRedis = typeof subscriber.pSubscribe === "function";
  const useEmitter = !isNodeRedis && typeof subscriber.on === "function";
  const emitterListener = (incomingChannel: string, payload: string): void => {
    if (incomingChannel !== channel) return;
    handleInbound(payload);
  };

  // A union of signatures cannot be called generically, and narrowing it here
  // would only re-ask the question the driver check above just answered. Widened
  // once, next to that check, so the shape we call and the shape we detected
  // cannot drift apart. `.call` keeps the driver as the receiver - these are
  // methods, and ioredis needs its `this`.
  const subscribe = subscriber.subscribe as (
    channel: string,
    listener?: (payload: string, channel: string) => void,
  ) => Promise<unknown> | unknown;

  try {
    let subscribed: Promise<unknown> | unknown;
    if (useEmitter) {
      subscriber.on?.("message", emitterListener);
      subscribed = subscribe.call(subscriber, channel);
    } else {
      subscribed = subscribe.call(subscriber, channel, (payload) => handleInbound(payload));
    }
    if (subscribed instanceof Promise) {
      subscribed.catch((err: unknown) => reportError(err, "subscribe"));
    }
  } catch (err) {
    reportError(err, "subscribe");
  }

  return {
    nodeId,

    publish(event: TransportEvent): void {
      if (closed) return;

      // 1. Local subscribers first: synchronous, same as the in-process
      //    transport, and unaffected by Redis health.
      fanOutLocally(event);

      // 2. Relay to the other nodes. Fire-and-forget by contract: publish()
      //    must not throw and must not await subscriber work.
      try {
        const result = publisher.publish(channel, encodeEnvelope(nodeId, event));
        if (result instanceof Promise) {
          result.catch((err: unknown) => reportError(err, "publish"));
        }
      } catch (err) {
        reportError(err, "publish");
      }
    },

    subscribe(listener: (event: TransportEvent) => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      listeners.clear();
      if (useEmitter && typeof subscriber.off === "function") {
        subscriber.off("message", emitterListener);
      }
      try {
        await subscriber.unsubscribe?.(channel);
      } catch (err) {
        reportError(err, "subscribe");
      }
    },
  };
}

export { encodeEnvelope, decodeEnvelope, type EventEnvelope } from "./serialize";
