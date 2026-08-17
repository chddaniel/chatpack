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
 * **What this fixes and what it does not.** Messages, typing signals, receipt
 * ticks, and presence transition events travel on the transport. Presence
 * connection state needs the separate `redisPresenceStore()` below; configure
 * both pieces for a complete multi-node deployment (ADR 0025).
 *
 * @module
 */

import type { PresenceStore, PresenceState, Transport, TransportEvent } from "@chatpack/core";
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

/** ioredis-shaped client used by {@link redisPresenceStore}. */
export interface RedisPresenceIoredisClient {
  eval(
    script: string,
    numberOfKeys: number,
    ...keysAndArguments: string[]
  ): Promise<unknown> | unknown;
  psubscribe?: unknown;
}

/** node-redis-shaped client used by {@link redisPresenceStore}. */
export interface RedisPresenceNodeClient {
  eval(
    script: string,
    options: { keys: string[]; arguments: string[] },
  ): Promise<unknown> | unknown;
  pSubscribe?: unknown;
}

/** Redis client shapes accepted by {@link redisPresenceStore}. */
export type RedisPresenceClient = RedisPresenceIoredisClient | RedisPresenceNodeClient;

/** Where a presence-store failure happened. */
export type RedisPresenceErrorContext = "open" | "heartbeat" | "close" | "finalize" | "get";

/** Options for {@link redisPresenceStore}. */
export interface RedisPresenceStoreOptions {
  /** A normal Redis connection that supports `EVAL`, not a subscriber connection. */
  client: RedisPresenceClient;
  /** Prefix used for all presence keys. Default: `chatpack:presence`. */
  keyPrefix?: string;
  /** Called before a store error is rethrown to the core plugin. */
  onError?: (error: unknown, context: RedisPresenceErrorContext) => void;
}

const OPEN_PRESENCE_SCRIPT = `
local now = tonumber(ARGV[1])
local expiry = tonumber(ARGV[2])
local connection = ARGV[3]
redis.call("ZREMRANGEBYSCORE", KEYS[1], "-inf", now)
local wasOnline = redis.call("ZCARD", KEYS[1]) > 0
local wasPending = redis.call("GET", KEYS[3]) ~= false
redis.call("ZADD", KEYS[1], expiry, connection)
redis.call("SET", KEYS[2], ARGV[1])
redis.call("DEL", KEYS[3])
return { wasOnline and 1 or 0, wasPending and 1 or 0 }
`;

const HEARTBEAT_PRESENCE_SCRIPT = `
local now = tonumber(ARGV[1])
local expiry = tonumber(ARGV[2])
local connection = ARGV[3]
redis.call("ZREMRANGEBYSCORE", KEYS[1], "-inf", now)
if redis.call("ZSCORE", KEYS[1], connection) == false then return 0 end
redis.call("ZADD", KEYS[1], expiry, connection)
redis.call("SET", KEYS[2], ARGV[1])
return 1
`;

const CLOSE_PRESENCE_SCRIPT = `
local now = tonumber(ARGV[1])
local connection = ARGV[2]
local token = ARGV[3]
local delay = tonumber(ARGV[4])
redis.call("ZREMRANGEBYSCORE", KEYS[1], "-inf", now)
local removed = redis.call("ZREM", KEYS[1], connection)
if removed == 0 then return { 0, 0, redis.call("GET", KEYS[2]) or "" } end
redis.call("SET", KEYS[2], ARGV[1])
local remaining = redis.call("ZCARD", KEYS[1])
if remaining == 0 then
  -- Keep token alive slightly beyond the application timer. The timer and
  -- Redis key expiry use separate clocks and must not race at the boundary.
  redis.call("SET", KEYS[3], token, "PX", math.max(delay + 1000, 1000))
end
return { removed, remaining, redis.call("GET", KEYS[2]) or "" }
`;

const FINALIZE_PRESENCE_SCRIPT = `
local now = tonumber(ARGV[1])
local token = ARGV[2]
redis.call("ZREMRANGEBYSCORE", KEYS[1], "-inf", now)
if redis.call("GET", KEYS[3]) ~= token then return { 0, "" } end
if redis.call("ZCARD", KEYS[1]) > 0 then return { 0, "" } end
redis.call("DEL", KEYS[3])
return { 1, redis.call("GET", KEYS[2]) or "" }
`;

const GET_PRESENCE_SCRIPT = `
local now = tonumber(ARGV[1])
redis.call("ZREMRANGEBYSCORE", KEYS[1], "-inf", now)
local lastSeen = redis.call("GET", KEYS[2])
return { redis.call("ZCARD", KEYS[1]) > 0 and 1 or 0, lastSeen or "" }
`;

function presenceKeys(prefix: string, userId: string): string[] {
  const safeUserId = encodeURIComponent(userId);
  return [
    `${prefix}:leases:{${safeUserId}}`,
    `${prefix}:last-seen:{${safeUserId}}`,
    `${prefix}:pending:{${safeUserId}}`,
  ];
}

function redisResultArray(value: unknown, operation: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`chatpack: invalid Redis ${operation} result.`);
  return value;
}

function redisResultNumber(value: unknown, operation: string): number {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value !== "") return Number(value);
  throw new Error(`chatpack: invalid Redis ${operation} result.`);
}

function presenceState(online: boolean, rawLastSeen: unknown): PresenceState {
  if (typeof rawLastSeen !== "string" || rawLastSeen === "") {
    return { online, lastSeenAt: null };
  }
  const lastSeenAt = new Date(Number(rawLastSeen));
  if (Number.isNaN(lastSeenAt.getTime())) {
    throw new Error("chatpack: Redis presence last-seen value is invalid.");
  }
  return { online, lastSeenAt };
}

function evaluatePresence(
  client: RedisPresenceClient,
  script: string,
  keys: string[],
  args: string[],
): Promise<unknown> {
  const isNodeRedis =
    "pSubscribe" in client && typeof (client as RedisPresenceNodeClient).pSubscribe === "function";
  const result = isNodeRedis
    ? (client as RedisPresenceNodeClient).eval(script, { keys, arguments: args })
    : (client as RedisPresenceIoredisClient).eval(script, keys.length, ...keys, ...args);
  return Promise.resolve(result);
}

/** Create a Redis-backed, multi-node {@link PresenceStore}. */
export function redisPresenceStore(options: RedisPresenceStoreOptions): PresenceStore {
  const prefix = options.keyPrefix ?? "chatpack:presence";
  const reportError =
    options.onError ??
    ((error: unknown, context: RedisPresenceErrorContext) =>
      console.error(`chatpack: Redis presence ${context} failed`, error));

  async function run<T>(
    context: RedisPresenceErrorContext,
    operation: () => Promise<T>,
  ): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      reportError(error, context);
      throw error;
    }
  }

  return {
    open(input: Parameters<PresenceStore["open"]>[0]) {
      return run("open", async () => {
        const keys = presenceKeys(prefix, input.userId);
        const raw = redisResultArray(
          await evaluatePresence(options.client, OPEN_PRESENCE_SCRIPT, keys, [
            String(input.now.getTime()),
            String(input.now.getTime() + input.leaseTtlMs),
            input.connectionId,
          ]),
          "open",
        );
        const wasOnline = redisResultNumber(raw[0], "open") === 1;
        const wasPending = redisResultNumber(raw[1], "open") === 1;
        return {
          state: presenceState(true, String(input.now.getTime())),
          transition: !wasOnline && !wasPending ? "online" : null,
        };
      });
    },

    heartbeat(input: Parameters<PresenceStore["heartbeat"]>[0]) {
      return run("heartbeat", async () => {
        const keys = presenceKeys(prefix, input.userId);
        await evaluatePresence(options.client, HEARTBEAT_PRESENCE_SCRIPT, keys, [
          String(input.now.getTime()),
          String(input.now.getTime() + input.leaseTtlMs),
          input.connectionId,
        ]);
      });
    },

    close(input: Parameters<PresenceStore["close"]>[0]) {
      return run("close", async () => {
        const keys = presenceKeys(prefix, input.userId);
        const offlineToken = `${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
        const raw = redisResultArray(
          await evaluatePresence(options.client, CLOSE_PRESENCE_SCRIPT, keys, [
            String(input.now.getTime()),
            input.connectionId,
            offlineToken,
            String(input.offlineDelayMs),
          ]),
          "close",
        );
        const removed = redisResultNumber(raw[0], "close") === 1;
        const remaining = redisResultNumber(raw[1], "close");
        return {
          state: presenceState(remaining > 0, raw[2]),
          offlineToken: removed && remaining === 0 ? offlineToken : null,
        };
      });
    },

    finalizeOffline(input: Parameters<PresenceStore["finalizeOffline"]>[0]) {
      return run("finalize", async () => {
        const keys = presenceKeys(prefix, input.userId);
        const raw = await evaluatePresence(options.client, FINALIZE_PRESENCE_SCRIPT, keys, [
          String(input.now.getTime()),
          input.token,
        ]);
        const result = redisResultArray(raw, "finalize");
        if (redisResultNumber(result[0], "finalize") !== 1) return null;
        return {
          state: presenceState(false, result[1]),
          transition: "offline" as const,
        };
      });
    },

    get(input: Parameters<PresenceStore["get"]>[0]) {
      return run("get", async () => {
        const keys = presenceKeys(prefix, input.userId);
        const raw = redisResultArray(
          await evaluatePresence(options.client, GET_PRESENCE_SCRIPT, keys, [
            String(input.now.getTime()),
          ]),
          "get",
        );
        return presenceState(redisResultNumber(raw[0], "get") === 1, raw[1]);
      });
    },
  };
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
