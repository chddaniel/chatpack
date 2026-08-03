/**
 * A minimal in-memory Redis pub/sub double, in both driver shapes.
 *
 * The point is to exercise the *cross-node* path for real - two transports on
 * one broker, events crossing between them as JSON strings - without a Redis
 * server. Because the payload genuinely round-trips through
 * `JSON.stringify`/`JSON.parse`, this also catches the `Date`-becomes-string
 * bug that a mocked-out transport would hide.
 */

import { EventEmitter } from "node:events";

/** A broker shared by every client created from it, standing in for a server. */
export class FakeRedisBroker {
  private readonly channels = new Map<string, Set<(payload: string) => void>>();
  /** Every payload published, for assertions about the wire format. */
  readonly published: Array<{ channel: string; payload: string }> = [];

  publish(channel: string, payload: string): number {
    this.published.push({ channel, payload });
    const subscribers = this.channels.get(channel);
    if (!subscribers) return 0;
    // Copy: a handler may unsubscribe while we are iterating.
    for (const subscriber of [...subscribers]) subscriber(payload);
    return subscribers.size;
  }

  add(channel: string, handler: (payload: string) => void): void {
    const existing = this.channels.get(channel) ?? new Set();
    existing.add(handler);
    this.channels.set(channel, existing);
  }

  remove(channel: string, handler: (payload: string) => void): void {
    this.channels.get(channel)?.delete(handler);
  }

  subscriberCount(channel: string): number {
    return this.channels.get(channel)?.size ?? 0;
  }
}

/** An `ioredis`-shaped client: `subscribe(channel)` + `on("message", ...)`. */
export class FakeIoredis {
  /** Set when `publish` should reject, to exercise the error path. */
  failPublish = false;
  private readonly messageListeners = new Set<(channel: string, payload: string) => void>();
  private readonly bridges = new Map<string, (payload: string) => void>();

  constructor(private readonly broker: FakeRedisBroker) {}

  publish(channel: string, message: string): Promise<number> {
    if (this.failPublish) return Promise.reject(new Error("redis unavailable"));
    return Promise.resolve(this.broker.publish(channel, message));
  }

  /** Lowercase, as ioredis spells it - the counterpart to node-redis's `pSubscribe`. */
  psubscribe(): Promise<number> {
    return Promise.resolve(1);
  }

  /**
   * ioredis resolves with the subscription count. Its optional second argument
   * is a Node-style `(err, count)` completion callback - deliberately not
   * accepted here, so a transport that mistook it for a message listener would
   * fail this suite.
   */
  subscribe(channel: string): Promise<number> {
    const bridge = (payload: string): void => {
      for (const listener of [...this.messageListeners]) listener(channel, payload);
    };
    this.bridges.set(channel, bridge);
    this.broker.add(channel, bridge);
    return Promise.resolve(1);
  }

  unsubscribe(channel: string): Promise<number> {
    const bridge = this.bridges.get(channel);
    if (bridge) {
      this.broker.remove(channel, bridge);
      this.bridges.delete(channel);
    }
    return Promise.resolve(0);
  }

  on(event: "message", listener: (channel: string, payload: string) => void): this {
    if (event === "message") this.messageListeners.add(listener);
    return this;
  }

  off(event: "message", listener: (channel: string, payload: string) => void): this {
    if (event === "message") this.messageListeners.delete(listener);
    return this;
  }
}

/**
 * A `node-redis` v4-shaped client: the listener is passed to `subscribe`, and
 * no `"message"` event is ever emitted.
 *
 * Deliberately an `EventEmitter` with a real `on`/`off`, because the actual
 * driver is one (verified against `redis@6`). An earlier version of this double
 * omitted `on` entirely, which let a transport that detected drivers by
 * `typeof subscriber.on === "function"` pass the suite while silently receiving
 * zero events against real node-redis. It also carries the camelCase
 * `pSubscribe` that identifies the driver.
 */
export class FakeNodeRedis extends EventEmitter {
  private readonly bridges = new Map<string, (payload: string) => void>();

  constructor(private readonly broker: FakeRedisBroker) {
    super();
  }

  /**
   * Never called by the transport - present only because its casing is how
   * node-redis is told apart from ioredis (`psubscribe`).
   */
  pSubscribe(): Promise<void> {
    return Promise.resolve();
  }

  publish(channel: string, message: string): Promise<number> {
    return Promise.resolve(this.broker.publish(channel, message));
  }

  subscribe(channel: string, listener?: (payload: string, channel: string) => void): Promise<void> {
    if (listener) {
      const bridge = (payload: string): void => listener(payload, channel);
      this.bridges.set(channel, bridge);
      this.broker.add(channel, bridge);
    }
    return Promise.resolve();
  }

  unsubscribe(channel: string): Promise<void> {
    const bridge = this.bridges.get(channel);
    if (bridge) {
      this.broker.remove(channel, bridge);
      this.bridges.delete(channel);
    }
    return Promise.resolve();
  }
}
