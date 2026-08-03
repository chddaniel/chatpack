/**
 * The end-to-end claim of this package, tested through the real HTTP handler:
 * two `chatpack()` instances (standing in for two server processes) sharing one
 * Redis channel, and an SSE client connected to node A receiving a message that
 * was sent through node B.
 *
 * This is the test that would fail today with the default in-process transport,
 * which is the whole reason the package exists. Both nodes share one storage
 * adapter, mirroring the real deployment: one database, many app servers.
 */
import { afterEach, describe, expect, it } from "vitest";

import { chatpack, type ChatpackHandler, type ChatpackInstance } from "@chatpack/core";
import { presence, receipts, typing } from "@chatpack/core/plugins";
import { memoryAdapter } from "@chatpack/adapter-memory";
import { inProcessTransport } from "@chatpack/core";
import { redisTransport, type RedisTransport } from "../src/index";
import { FakeIoredis, FakeRedisBroker } from "./fake-redis";

const BASE = "http://test.local/api/chat";

interface SseEvent {
  id: string | null;
  event: string | null;
  data: Record<string, unknown>;
}

/** A tiny SSE client over the handler's ReadableStream response. */
class SseClient {
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  private buffer = "";
  private pendingRead: Promise<ReadableStreamReadResult<Uint8Array>> | null = null;
  readonly events: SseEvent[] = [];

  private constructor(response: Response) {
    this.reader = response.body!.getReader();
  }

  static async connect(handler: ChatpackHandler, userId: string): Promise<SseClient> {
    const response = await handler.GET(
      new Request(`${BASE}/stream`, { headers: { "x-user-id": userId } }),
    );
    expect(response.status).toBe(200);
    return new SseClient(response);
  }

  async waitForEvents(count: number, timeoutMs = 2000): Promise<SseEvent[]> {
    const deadline = Date.now() + timeoutMs;
    while (this.events.length < count && Date.now() < deadline) {
      this.pendingRead ??= this.reader.read();
      const result = await Promise.race([
        this.pendingRead,
        new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 25)),
      ]);
      if (result === "timeout") continue;
      this.pendingRead = null;
      if (result.done) break;
      this.buffer += new TextDecoder().decode(result.value);
      this.drainBuffer();
    }
    return this.events;
  }

  private drainBuffer(): void {
    const frames = this.buffer.split("\n\n");
    this.buffer = frames.pop() ?? "";
    for (const frame of frames) {
      let id: string | null = null;
      let event: string | null = null;
      let data = "";
      for (const line of frame.split("\n")) {
        if (line.startsWith("id: ")) id = line.slice(4);
        else if (line.startsWith("event: ")) event = line.slice(7);
        else if (line.startsWith("data: ")) data = line.slice(6);
      }
      if (data) this.events.push({ id, event, data: JSON.parse(data) as Record<string, unknown> });
    }
  }

  async close(): Promise<void> {
    await this.reader.cancel();
  }
}

const openClients: SseClient[] = [];
const openTransports: RedisTransport[] = [];
afterEach(async () => {
  await Promise.all(openClients.map((c) => c.close()));
  openClients.length = 0;
  await Promise.all(openTransports.map((t) => t.close()));
  openTransports.length = 0;
});

interface Node {
  chat: ChatpackInstance;
  handler: ChatpackHandler;
}

/**
 * Build N Chatpack "nodes" over one shared storage adapter and one Redis
 * channel - the shape of a real horizontally-scaled deployment.
 */
function cluster(size: number, options: { withPlugins?: boolean } = {}): Node[] {
  const broker = new FakeRedisBroker();
  const storage = memoryAdapter();
  const nodes: Node[] = [];

  for (let i = 0; i < size; i++) {
    const transport = redisTransport({
      publisher: new FakeIoredis(broker),
      subscriber: new FakeIoredis(broker),
      nodeId: `node-${i}`,
    });
    openTransports.push(transport);
    const chat = chatpack({
      storage,
      transport,
      telemetry: false,
      ...(options.withPlugins ? { plugins: [typing(), presence(), receipts()] } : {}),
      auth: (request) => {
        const userId = request.headers.get("x-user-id");
        return userId ? { id: userId } : null;
      },
    });
    nodes.push({ chat, handler: chat.handler({ heartbeatIntervalMs: 0 }) });
  }
  return nodes;
}

async function connect(node: Node, userId: string): Promise<SseClient> {
  const client = await SseClient.connect(node.handler, userId);
  openClients.push(client);
  return client;
}

describe("multi-node SSE fan-out", () => {
  it("delivers a message sent on node B to a stream connected to node A", async () => {
    const [nodeA, nodeB] = cluster(2) as [Node, Node];
    const conversation = await nodeA.chat.api.getOrCreateConversation({
      userId: "alice",
      otherUserId: "bob",
    });

    // Alice is connected to node A; Bob's request is load-balanced to node B.
    const alice = await connect(nodeA, "alice");
    const response = await nodeB.handler.POST(
      new Request(`${BASE}/conversations/${conversation.id}/messages`, {
        method: "POST",
        headers: { "x-user-id": "bob", "content-type": "application/json" },
        body: JSON.stringify({ body: "hello across nodes" }),
      }),
    );
    expect(response.status).toBe(201);

    const events = await alice.waitForEvents(1);
    expect(events).toHaveLength(1);
    expect(events[0]?.event).toBe("message.created");
    expect((events[0]?.data["message"] as { body: string }).body).toBe("hello across nodes");
  });

  it("fails this same scenario with the default in-process transport", async () => {
    // The control case: proves the test above is really exercising the relay
    // and not passing because both nodes share storage.
    const storage = memoryAdapter();
    const makeNode = (): Node => {
      const chat = chatpack({
        storage,
        transport: inProcessTransport(),
        telemetry: false,
        auth: (request) => {
          const userId = request.headers.get("x-user-id");
          return userId ? { id: userId } : null;
        },
      });
      return { chat, handler: chat.handler({ heartbeatIntervalMs: 0 }) };
    };
    const nodeA = makeNode();
    const nodeB = makeNode();
    const conversation = await nodeA.chat.api.getOrCreateConversation({
      userId: "alice",
      otherUserId: "bob",
    });

    const alice = await connect(nodeA, "alice");
    await nodeB.chat.api.sendMessage({
      userId: "bob",
      conversationId: conversation.id,
      body: "lost in the void",
    });

    const events = await alice.waitForEvents(1, 250);
    expect(events).toHaveLength(0);
  });

  it("gives each participant exactly one copy of a message (no echo)", async () => {
    const [nodeA, nodeB] = cluster(2) as [Node, Node];
    const conversation = await nodeA.chat.api.getOrCreateConversation({
      userId: "alice",
      otherUserId: "bob",
    });

    const alice = await connect(nodeA, "alice");
    const bob = await connect(nodeB, "bob");

    await nodeB.chat.api.sendMessage({
      userId: "bob",
      conversationId: conversation.id,
      body: "one copy only",
    });

    // Give any duplicate a generous chance to show up before asserting.
    await alice.waitForEvents(2, 300);
    await bob.waitForEvents(2, 300);

    expect(alice.events).toHaveLength(1);
    // Bob is the sender, on the publishing node: local fan-out only.
    expect(bob.events).toHaveLength(1);
  });

  it("keeps SSE ids intact so cross-node gap-fill still works", async () => {
    const [nodeA, nodeB] = cluster(2) as [Node, Node];
    const conversation = await nodeA.chat.api.getOrCreateConversation({
      userId: "alice",
      otherUserId: "bob",
    });

    const alice = await connect(nodeA, "alice");
    const sent = await nodeB.chat.api.sendMessage({
      userId: "bob",
      conversationId: conversation.id,
      body: "m1",
    });

    const [event] = await alice.waitForEvents(1);
    // `conversationId:seq` - the Last-Event-ID contract (docs/decisions/0006).
    expect(event?.id).toBe(`${conversation.id}:${sent.seq}`);
  });

  it("relays edits and deletes across nodes", async () => {
    const [nodeA, nodeB] = cluster(2) as [Node, Node];
    const conversation = await nodeA.chat.api.getOrCreateConversation({
      userId: "alice",
      otherUserId: "bob",
    });
    const alice = await connect(nodeA, "alice");

    const message = await nodeB.chat.api.sendMessage({
      userId: "bob",
      conversationId: conversation.id,
      body: "typo",
    });
    await nodeB.chat.api.editMessage({ userId: "bob", messageId: message.id, body: "fixed" });
    await nodeB.chat.api.deleteMessage({ userId: "bob", messageId: message.id });

    const events = await alice.waitForEvents(3);
    expect(events.map((e) => e.event)).toEqual([
      "message.created",
      "message.updated",
      "message.deleted",
    ]);
  });

  it("scales past two nodes", async () => {
    const nodes = cluster(3);
    const [nodeA, nodeB, nodeC] = nodes as [Node, Node, Node];
    const conversation = await nodeA.chat.api.getOrCreateConversation({
      userId: "alice",
      otherUserId: "bob",
    });

    const aliceOnA = await connect(nodeA, "alice");
    const aliceOnC = await connect(nodeC, "alice"); // second tab, different node

    await nodeB.chat.api.sendMessage({
      userId: "bob",
      conversationId: conversation.id,
      body: "broadcast",
    });

    expect(await aliceOnA.waitForEvents(1)).toHaveLength(1);
    expect(await aliceOnC.waitForEvents(1)).toHaveLength(1);
  });

  it("does not leak events to non-participants on other nodes", async () => {
    const [nodeA, nodeB] = cluster(2) as [Node, Node];
    const conversation = await nodeA.chat.api.getOrCreateConversation({
      userId: "alice",
      otherUserId: "bob",
    });

    // Mallory is connected to a different node than the sender - the relay must
    // not become a way around the per-event recipient check.
    const mallory = await connect(nodeA, "mallory");
    await nodeB.chat.api.sendMessage({
      userId: "bob",
      conversationId: conversation.id,
      body: "private",
    });

    expect(await mallory.waitForEvents(1, 300)).toHaveLength(0);
  });
});

describe("multi-node ephemeral events", () => {
  it("relays typing indicators across nodes", async () => {
    const [nodeA, nodeB] = cluster(2, { withPlugins: true }) as [Node, Node];
    const conversation = await nodeA.chat.api.getOrCreateConversation({
      userId: "alice",
      otherUserId: "bob",
    });
    const alice = await connect(nodeA, "alice");

    const response = await nodeB.handler.POST(
      new Request(`${BASE}/conversations/${conversation.id}/typing`, {
        method: "POST",
        headers: { "x-user-id": "bob", "content-type": "application/json" },
        body: JSON.stringify({ isTyping: true }),
      }),
    );
    expect(response.status).toBe(200);

    const [event] = await alice.waitForEvents(1);
    expect(event?.event).toBe("typing.started");
    // Ephemeral frames must stay id-less, or they would corrupt Last-Event-ID.
    expect(event?.id).toBeNull();
  });

  it("relays read receipts across nodes", async () => {
    const [nodeA, nodeB] = cluster(2, { withPlugins: true }) as [Node, Node];
    const conversation = await nodeA.chat.api.getOrCreateConversation({
      userId: "alice",
      otherUserId: "bob",
    });
    const alice = await connect(nodeA, "alice");

    const message = await nodeA.chat.api.sendMessage({
      userId: "alice",
      conversationId: conversation.id,
      body: "did you see this?",
    });
    // Bob reads it on the other node.
    await nodeB.chat.api.markRead({
      userId: "bob",
      conversationId: conversation.id,
      messageId: message.id,
    });

    const events = await alice.waitForEvents(2);
    const receipt = events.find((e) => e.event === "receipt.read");
    expect(receipt).toBeDefined();
    expect((receipt?.data["payload"] as { messageId: string }).messageId).toBe(message.id);
  });
});
