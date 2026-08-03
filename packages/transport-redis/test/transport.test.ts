import { describe, expect, it, vi } from "vitest";
import type { ChatEvent, EphemeralEvent, Message, TransportEvent } from "@chatpack/core";
import { DEFAULT_CHANNEL, decodeEnvelope, redisTransport } from "../src/index";
import { FakeIoredis, FakeNodeRedis, FakeRedisBroker } from "./fake-redis";

function message(overrides: Partial<Message> = {}): Message {
  return {
    id: "m1",
    conversationId: "c1",
    senderId: "alice",
    body: "hello",
    role: "user",
    seq: 1,
    createdAt: new Date("2026-08-03T10:00:00.000Z"),
    editedAt: null,
    deletedAt: null,
    metadata: {},
    ...overrides,
  };
}

function chatEvent(overrides: Partial<ChatEvent> = {}): ChatEvent {
  return {
    type: "message.created",
    conversationId: "c1",
    recipientIds: ["alice", "bob"],
    message: message(),
    ...overrides,
  };
}

function ephemeralEvent(overrides: Partial<EphemeralEvent> = {}): EphemeralEvent {
  return {
    ephemeral: true,
    type: "typing.started",
    conversationId: "c1",
    senderId: "alice",
    recipientIds: ["bob"],
    payload: { isTyping: true },
    at: "2026-08-03T10:00:00.000Z",
    ...overrides,
  };
}

/** Two transports on one broker - the multi-node setup under test. */
function twoNodes(options: { channel?: string } = {}) {
  const broker = new FakeRedisBroker();
  const nodeA = redisTransport({
    publisher: new FakeIoredis(broker),
    subscriber: new FakeIoredis(broker),
    nodeId: "node-a",
    ...(options.channel === undefined ? {} : { channel: options.channel }),
  });
  const nodeB = redisTransport({
    publisher: new FakeIoredis(broker),
    subscriber: new FakeIoredis(broker),
    nodeId: "node-b",
    ...(options.channel === undefined ? {} : { channel: options.channel }),
  });
  return { broker, nodeA, nodeB };
}

describe("redisTransport - local behavior matches inProcessTransport", () => {
  it("delivers to local subscribers synchronously", () => {
    const broker = new FakeRedisBroker();
    const transport = redisTransport({
      publisher: new FakeIoredis(broker),
      subscriber: new FakeIoredis(broker),
    });
    const received: TransportEvent[] = [];
    transport.subscribe((event) => received.push(event));

    transport.publish(chatEvent());

    // Synchronous: no await, no tick. The SSE handler relies on this.
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ type: "message.created" });
  });

  it("stops delivering after unsubscribe", () => {
    const broker = new FakeRedisBroker();
    const transport = redisTransport({
      publisher: new FakeIoredis(broker),
      subscriber: new FakeIoredis(broker),
    });
    const received: TransportEvent[] = [];
    const unsubscribe = transport.subscribe((event) => received.push(event));

    transport.publish(chatEvent());
    unsubscribe();
    transport.publish(chatEvent());

    expect(received).toHaveLength(1);
  });

  it("keeps fanning out when one listener throws", () => {
    const broker = new FakeRedisBroker();
    const transport = redisTransport({
      publisher: new FakeIoredis(broker),
      subscriber: new FakeIoredis(broker),
    });
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const received: TransportEvent[] = [];

    transport.subscribe(() => {
      throw new Error("broken subscriber");
    });
    transport.subscribe((event) => received.push(event));

    expect(() => transport.publish(chatEvent())).not.toThrow();
    expect(received).toHaveLength(1);
    consoleSpy.mockRestore();
  });
});

describe("redisTransport - cross-node relay", () => {
  it("delivers an event published on node A to a subscriber on node B", () => {
    const { nodeA, nodeB } = twoNodes();
    const onB: TransportEvent[] = [];
    nodeB.subscribe((event) => onB.push(event));

    nodeA.publish(chatEvent({ message: message({ body: "from node A" }) }));

    expect(onB).toHaveLength(1);
    expect((onB[0] as ChatEvent).message.body).toBe("from node A");
  });

  it("does not echo an event back to the node that published it", () => {
    const { nodeA, nodeB } = twoNodes();
    const onA: TransportEvent[] = [];
    nodeA.subscribe((event) => onA.push(event));
    nodeB.subscribe(() => {});

    nodeA.publish(chatEvent());

    // Exactly one delivery: the local fan-out. The inbound copy is dropped by
    // nodeId, otherwise every client would see each message twice.
    expect(onA).toHaveLength(1);
  });

  it("relays ephemeral events (so typing and receipts work multi-node)", () => {
    const { nodeA, nodeB } = twoNodes();
    const onB: TransportEvent[] = [];
    nodeB.subscribe((event) => onB.push(event));

    nodeA.publish(ephemeralEvent());

    expect(onB).toHaveLength(1);
    expect(onB[0]).toMatchObject({
      ephemeral: true,
      type: "typing.started",
      at: "2026-08-03T10:00:00.000Z",
    });
  });

  it("isolates nodes on different channels", () => {
    const broker = new FakeRedisBroker();
    const prod = redisTransport({
      publisher: new FakeIoredis(broker),
      subscriber: new FakeIoredis(broker),
      channel: "chatpack:prod",
      nodeId: "prod-1",
    });
    const staging = redisTransport({
      publisher: new FakeIoredis(broker),
      subscriber: new FakeIoredis(broker),
      channel: "chatpack:staging",
      nodeId: "staging-1",
    });
    const onStaging: TransportEvent[] = [];
    staging.subscribe((event) => onStaging.push(event));

    prod.publish(chatEvent());

    expect(onStaging).toHaveLength(0);
  });

  it("publishes on the default channel when none is given", () => {
    const broker = new FakeRedisBroker();
    const transport = redisTransport({
      publisher: new FakeIoredis(broker),
      subscriber: new FakeIoredis(broker),
    });

    transport.publish(chatEvent());

    expect(broker.published[0]?.channel).toBe(DEFAULT_CHANNEL);
    expect(DEFAULT_CHANNEL).toBe("chatpack:events");
  });
});

describe("redisTransport - Date fields survive the wire", () => {
  it("revives createdAt/editedAt/deletedAt as real Dates on the receiving node", () => {
    const { nodeA, nodeB } = twoNodes();
    const onB: TransportEvent[] = [];
    nodeB.subscribe((event) => onB.push(event));

    const createdAt = new Date("2026-08-03T10:00:00.000Z");
    const editedAt = new Date("2026-08-03T11:30:00.000Z");
    nodeA.publish(
      chatEvent({
        type: "message.updated",
        message: message({ createdAt, editedAt }),
      }),
    );

    const relayed = (onB[0] as ChatEvent).message;
    // The contract is explicit that these are Date instances, never ISO
    // strings - JSON.stringify would otherwise hand subscribers strings.
    expect(relayed.createdAt).toBeInstanceOf(Date);
    expect(relayed.createdAt.getTime()).toBe(createdAt.getTime());
    expect(relayed.editedAt).toBeInstanceOf(Date);
    expect(relayed.editedAt?.getTime()).toBe(editedAt.getTime());
    expect(relayed.deletedAt).toBeNull();
  });

  it("revives deletedAt on a tombstone event", () => {
    const { nodeA, nodeB } = twoNodes();
    const onB: TransportEvent[] = [];
    nodeB.subscribe((event) => onB.push(event));

    const deletedAt = new Date("2026-08-03T12:00:00.000Z");
    nodeA.publish(
      chatEvent({ type: "message.deleted", message: message({ body: "", deletedAt }) }),
    );

    const relayed = (onB[0] as ChatEvent).message;
    expect(relayed.deletedAt).toBeInstanceOf(Date);
    expect(relayed.deletedAt?.getTime()).toBe(deletedAt.getTime());
  });

  it("preserves seq, metadata, and recipientIds exactly", () => {
    const { nodeA, nodeB } = twoNodes();
    const onB: TransportEvent[] = [];
    nodeB.subscribe((event) => onB.push(event));

    nodeA.publish(
      chatEvent({
        recipientIds: ["alice", "bob"],
        message: message({ seq: 42, metadata: { attachmentUrl: "https://example.com/a.png" } }),
      }),
    );

    const relayed = onB[0] as ChatEvent;
    expect(relayed.recipientIds).toEqual(["alice", "bob"]);
    expect(relayed.message.seq).toBe(42);
    expect(relayed.message.metadata).toEqual({ attachmentUrl: "https://example.com/a.png" });
  });
});

describe("redisTransport - failure handling", () => {
  it("never throws from publish when Redis rejects, and reports the error", async () => {
    const broker = new FakeRedisBroker();
    const publisher = new FakeIoredis(broker);
    publisher.failPublish = true;
    const onError = vi.fn();
    const transport = redisTransport({
      publisher,
      subscriber: new FakeIoredis(broker),
      onError,
    });
    const received: TransportEvent[] = [];
    transport.subscribe((event) => received.push(event));

    // The send path must survive a Redis outage: the message is already stored.
    expect(() => transport.publish(chatEvent())).not.toThrow();
    // Local subscribers are unaffected by Redis health.
    expect(received).toHaveLength(1);

    await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    expect(onError.mock.calls[0]?.[1]).toBe("publish");
  });

  it("never throws from publish when the client throws synchronously", () => {
    const broker = new FakeRedisBroker();
    const onError = vi.fn();
    const transport = redisTransport({
      publisher: {
        publish() {
          throw new Error("connection closed");
        },
      },
      subscriber: new FakeIoredis(broker),
      onError,
    });

    expect(() => transport.publish(chatEvent())).not.toThrow();
    expect(onError).toHaveBeenCalledWith(expect.any(Error), "publish");
  });

  it("ignores malformed payloads on the channel instead of crashing", () => {
    const broker = new FakeRedisBroker();
    const transport = redisTransport({
      publisher: new FakeIoredis(broker),
      subscriber: new FakeIoredis(broker),
      nodeId: "node-a",
    });
    const received: TransportEvent[] = [];
    transport.subscribe((event) => received.push(event));

    // Another app sharing the channel, a truncated payload, a future version.
    expect(() => broker.publish(DEFAULT_CHANNEL, "not json at all")).not.toThrow();
    expect(() => broker.publish(DEFAULT_CHANNEL, '{"v":99,"nodeId":"x","event":{}}')).not.toThrow();
    expect(() => broker.publish(DEFAULT_CHANNEL, '{"hello":"world"}')).not.toThrow();

    expect(received).toHaveLength(0);
  });

  it("reports a failed subscribe without throwing", async () => {
    const onError = vi.fn();
    const broker = new FakeRedisBroker();
    redisTransport({
      publisher: new FakeIoredis(broker),
      subscriber: {
        subscribe: () => Promise.reject(new Error("subscribe failed")),
        on: () => undefined,
      },
      onError,
    });

    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(expect.any(Error), "subscribe"));
  });

  it("rejects a single connection used for both publish and subscribe", () => {
    const broker = new FakeRedisBroker();
    const client = new FakeIoredis(broker);

    // A real Redis connection in subscriber mode refuses PUBLISH, so this
    // misconfiguration must fail loudly at construction, not silently at runtime.
    expect(() => redisTransport({ publisher: client, subscriber: client })).toThrow(
      /two separate Redis connections/,
    );
  });
});

describe("redisTransport - driver shapes", () => {
  it("works with a node-redis-style client (listener passed to subscribe)", () => {
    const broker = new FakeRedisBroker();
    const nodeA = redisTransport({
      publisher: new FakeNodeRedis(broker),
      subscriber: new FakeNodeRedis(broker),
      nodeId: "node-a",
    });
    const nodeB = redisTransport({
      publisher: new FakeNodeRedis(broker),
      subscriber: new FakeNodeRedis(broker),
      nodeId: "node-b",
    });
    const onB: TransportEvent[] = [];
    nodeB.subscribe((event) => onB.push(event));

    nodeA.publish(chatEvent());

    expect(onB).toHaveLength(1);
  });

  it("delivers exactly once per event, not once per supported driver path", () => {
    const { nodeA, nodeB } = twoNodes();
    const onB: TransportEvent[] = [];
    nodeB.subscribe((event) => onB.push(event));

    nodeA.publish(chatEvent({ message: message({ id: "m1", seq: 1 }) }));
    nodeA.publish(chatEvent({ message: message({ id: "m2", seq: 2 }) }));

    expect(onB).toHaveLength(2);
    expect(onB.map((e) => (e as ChatEvent).message.id)).toEqual(["m1", "m2"]);
  });

  it("generates a distinct nodeId per instance by default", () => {
    const broker = new FakeRedisBroker();
    const first = redisTransport({
      publisher: new FakeIoredis(broker),
      subscriber: new FakeIoredis(broker),
    });
    const second = redisTransport({
      publisher: new FakeIoredis(broker),
      subscriber: new FakeIoredis(broker),
    });

    expect(first.nodeId).not.toBe(second.nodeId);
    expect(first.nodeId).not.toBe("");
  });
});

describe("redisTransport - close()", () => {
  it("unsubscribes and stops delivering", async () => {
    const { broker, nodeA, nodeB } = twoNodes();
    const onB: TransportEvent[] = [];
    nodeB.subscribe((event) => onB.push(event));

    await nodeB.close();
    nodeA.publish(chatEvent());

    expect(onB).toHaveLength(0);
    expect(broker.subscriberCount(DEFAULT_CHANNEL)).toBe(1);
  });

  it("stops publishing after close and is idempotent", async () => {
    const { broker, nodeA } = twoNodes();

    await nodeA.close();
    await nodeA.close();
    nodeA.publish(chatEvent());

    expect(broker.published).toHaveLength(0);
  });
});

describe("wire format", () => {
  it("tags envelopes with the publishing nodeId and a version", () => {
    const broker = new FakeRedisBroker();
    const transport = redisTransport({
      publisher: new FakeIoredis(broker),
      subscriber: new FakeIoredis(broker),
      nodeId: "node-a",
    });

    transport.publish(chatEvent());

    const envelope = decodeEnvelope(broker.published[0]!.payload);
    expect(envelope).not.toBeNull();
    expect(envelope?.v).toBe(1);
    expect(envelope?.nodeId).toBe("node-a");
  });

  it("returns null for payloads that are not envelopes", () => {
    expect(decodeEnvelope("[]")).toBeNull();
    expect(decodeEnvelope("null")).toBeNull();
    expect(decodeEnvelope('{"v":1,"nodeId":"","event":{"type":"x"}}')).toBeNull();
    expect(decodeEnvelope('{"v":1,"nodeId":"a"}')).toBeNull();
    // Durable event with no message is malformed.
    expect(decodeEnvelope('{"v":1,"nodeId":"a","event":{"type":"message.created"}}')).toBeNull();
  });

  it("leaves an unparseable date value alone rather than making an Invalid Date", () => {
    const envelope = decodeEnvelope(
      JSON.stringify({
        v: 1,
        nodeId: "a",
        event: {
          type: "message.created",
          conversationId: "c1",
          recipientIds: ["alice"],
          message: { ...message(), createdAt: "not-a-date" },
        },
      }),
    );

    expect(envelope).not.toBeNull();
    expect((envelope?.event as ChatEvent).message.createdAt).toBe("not-a-date");
  });
});
