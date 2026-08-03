/**
 * M3 SSE suite: live delivery + reconnection gap-fill through the real
 * `GET /stream` endpoint.
 *
 * M3 DoD (MVP §11): "two SSE clients see each other's messages live; drop the
 * connection, messages backfill on reconnect."
 */
import { afterEach, describe, expect, it } from "vitest";

import { chatpack, type ChatpackHandler, type ChatpackInstance } from "@chatpack/core";
import { memoryAdapter } from "../src/index";

const BASE = "http://test.local/api/chat";

interface SseEvent {
  id: string | null;
  event: string | null;
  data: {
    type: string;
    conversationId: string;
    message: {
      id: string;
      body: string;
      seq: number;
      replyTo: { id: string; excerpt: string } | null;
      reactions: { emoji: string; count: number; userIds: string[] }[];
    };
    // Present on reaction frames only.
    actorId?: string;
    emoji?: string;
  };
}

/** A tiny SSE client over the handler's ReadableStream response. */
class SseClient {
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  private buffer = "";
  // Keep the in-flight read across poll iterations: racing a fresh read()
  // against a timer would abandon reads that later resolve with real chunks.
  private pendingRead: Promise<ReadableStreamReadResult<Uint8Array>> | null = null;
  readonly events: SseEvent[] = [];
  readonly status: number;

  private constructor(response: Response) {
    this.status = response.status;
    this.reader = response.body!.getReader();
  }

  static async connect(
    handler: ChatpackHandler,
    userId: string | undefined,
    query = "",
    headers: Record<string, string> = {},
  ): Promise<{ response: Response; client: SseClient | null }> {
    const response = await handler.GET(
      new Request(`${BASE}/stream${query}`, {
        headers: { ...(userId ? { "x-user-id": userId } : {}), ...headers },
      }),
    );
    if (response.status !== 200) return { response, client: null };
    return { response, client: new SseClient(response) };
  }

  /** Pump the stream until `count` events have arrived (or timeout). */
  async waitForEvents(count: number, timeoutMs = 2000): Promise<SseEvent[]> {
    const deadline = Date.now() + timeoutMs;
    while (this.events.length < count && Date.now() < deadline) {
      this.pendingRead ??= this.reader.read();
      const result = await Promise.race([
        this.pendingRead,
        new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 50)),
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
        // lines starting with ":" are comments (heartbeats) - ignored
      }
      if (data) this.events.push({ id, event, data: JSON.parse(data) });
    }
  }

  async close(): Promise<void> {
    await this.reader.cancel();
  }
}

function createHttpChat(): { chat: ChatpackInstance; handler: ChatpackHandler } {
  const chat = chatpack({
    storage: memoryAdapter(),
    telemetry: false,
    auth: (request) => {
      const userId = request.headers.get("x-user-id");
      return userId ? { id: userId } : null;
    },
  });
  return { chat, handler: chat.handler({ heartbeatIntervalMs: 0 }) };
}

const openClients: SseClient[] = [];
afterEach(async () => {
  await Promise.all(openClients.map((c) => c.close()));
  openClients.length = 0;
});

async function connect(
  handler: ChatpackHandler,
  userId: string,
  query = "",
  headers: Record<string, string> = {},
): Promise<SseClient> {
  const { client } = await SseClient.connect(handler, userId, query, headers);
  expect(client).not.toBeNull();
  openClients.push(client!);
  return client!;
}

describe("M3 Definition of Done", () => {
  it("two SSE clients see each other's messages live", async () => {
    const { chat, handler } = createHttpChat();
    const conversation = await chat.api.getOrCreateConversation({
      userId: "alice",
      otherUserId: "bob",
    });

    const alice = await connect(handler, "alice");
    const bob = await connect(handler, "bob");

    await chat.api.sendMessage({
      userId: "alice",
      conversationId: conversation.id,
      body: "hey bob!",
    });
    await chat.api.sendMessage({
      userId: "bob",
      conversationId: conversation.id,
      body: "hey alice!",
    });

    const aliceEvents = await alice.waitForEvents(2);
    const bobEvents = await bob.waitForEvents(2);

    expect(aliceEvents.map((e) => e.data.message.body)).toEqual(["hey bob!", "hey alice!"]);
    expect(bobEvents.map((e) => e.data.message.body)).toEqual(["hey bob!", "hey alice!"]);
    expect(aliceEvents.every((e) => e.event === "message.created")).toBe(true);
  });

  it("drop the connection, messages backfill on reconnect (Last-Event-ID)", async () => {
    const { chat, handler } = createHttpChat();
    const conversation = await chat.api.getOrCreateConversation({
      userId: "alice",
      otherUserId: "bob",
    });

    // bob is connected and sees the first message...
    const bob = await connect(handler, "bob");
    await chat.api.sendMessage({ userId: "alice", conversationId: conversation.id, body: "m1" });
    const [first] = await bob.waitForEvents(1);
    expect(first!.data.message.body).toBe("m1");
    const lastSeenId = first!.id!; // "convId:seq"

    // ...then drops.
    await bob.close();

    // Messages sent while bob is offline:
    await chat.api.sendMessage({ userId: "alice", conversationId: conversation.id, body: "m2" });
    await chat.api.sendMessage({ userId: "alice", conversationId: conversation.id, body: "m3" });

    // bob reconnects with Last-Event-ID → missed messages replay.
    const bobAgain = await connect(handler, "bob", "", { "last-event-id": lastSeenId });
    const replayed = await bobAgain.waitForEvents(2);
    expect(replayed.map((e) => e.data.message.body)).toEqual(["m2", "m3"]);

    // And live delivery continues after the backfill.
    await chat.api.sendMessage({ userId: "alice", conversationId: conversation.id, body: "m4" });
    const all = await bobAgain.waitForEvents(3);
    expect(all.map((e) => e.data.message.body)).toEqual(["m2", "m3", "m4"]);
  });
});

describe("stream auth & participation", () => {
  it("401 without auth", async () => {
    const { handler } = createHttpChat();
    const { response } = await SseClient.connect(handler, undefined);
    expect(response.status).toBe(401);
  });

  it("non-participants never receive events", async () => {
    const { chat, handler } = createHttpChat();
    const conversation = await chat.api.getOrCreateConversation({
      userId: "alice",
      otherUserId: "bob",
    });

    const mallory = await connect(handler, "mallory");
    const bob = await connect(handler, "bob");

    await chat.api.sendMessage({
      userId: "alice",
      conversationId: conversation.id,
      body: "secret",
    });

    await bob.waitForEvents(1); // delivery happened
    const malloryEvents = await mallory.waitForEvents(1, 300); // give it a beat
    expect(malloryEvents).toHaveLength(0);
  });

  it("gap-fill cannot read a foreign conversation", async () => {
    const { chat, handler } = createHttpChat();
    const conversation = await chat.api.getOrCreateConversation({
      userId: "alice",
      otherUserId: "bob",
    });
    await chat.api.sendMessage({ userId: "alice", conversationId: conversation.id, body: "m1" });

    // mallory forges a Last-Event-ID pointing at alice+bob's conversation.
    const mallory = await connect(handler, "mallory", "", {
      "last-event-id": `${conversation.id}:0`,
    });
    const events = await mallory.waitForEvents(1, 300);
    expect(events).toHaveLength(0); // FORBIDDEN_READ swallowed; no leak, stream stays open
  });
});

describe("event kinds", () => {
  it("edits and soft-deletes arrive as message.updated / message.deleted", async () => {
    const { chat, handler } = createHttpChat();
    const conversation = await chat.api.getOrCreateConversation({
      userId: "alice",
      otherUserId: "bob",
    });

    const bob = await connect(handler, "bob");

    const message = await chat.api.sendMessage({
      userId: "alice",
      conversationId: conversation.id,
      body: "helo",
    });
    await chat.api.editMessage({ userId: "alice", messageId: message.id, body: "hello" });
    await chat.api.deleteMessage({ userId: "alice", messageId: message.id });

    const events = await bob.waitForEvents(3);
    expect(events.map((e) => e.event)).toEqual([
      "message.created",
      "message.updated",
      "message.deleted",
    ]);
    expect(events[1]!.data.message.body).toBe("hello");
    expect(events[2]!.data.message.body).toBe("");
  });

  it("reaction frames carry the actor, the key, and no id: line (ADR 0013)", async () => {
    const { chat, handler } = createHttpChat();
    const conversation = await chat.api.getOrCreateConversation({
      userId: "alice",
      otherUserId: "bob",
    });

    const alice = await connect(handler, "alice");
    const message = await chat.api.sendMessage({
      userId: "alice",
      conversationId: conversation.id,
      body: "react to me",
    });
    await chat.api.addReaction({ userId: "bob", messageId: message.id, emoji: "👍" });
    await chat.api.removeReaction({ userId: "bob", messageId: message.id, emoji: "👍" });

    const events = await alice.waitForEvents(3);
    expect(events.map((e) => e.event)).toEqual([
      "message.created",
      "reaction.added",
      "reaction.removed",
    ]);

    const [, added, removed] = events;
    // No `id:` line: EventSource must never adopt a reaction as Last-Event-ID,
    // or the next reconnect would gap-fill from the wrong place.
    expect(added!.id).toBeNull();
    expect(removed!.id).toBeNull();
    expect(added!.data.actorId).toBe("bob");
    expect(added!.data.emoji).toBe("👍");
    // The frame carries the complete post-change set, not a delta.
    expect(added!.data.message.reactions).toEqual([{ emoji: "👍", count: 1, userIds: ["bob"] }]);
    expect(removed!.data.message.reactions).toEqual([]);
  });

  it("a reaction leaves the gap-fill baseline on the last real message", async () => {
    const { chat, handler } = createHttpChat();
    const conversation = await chat.api.getOrCreateConversation({
      userId: "alice",
      otherUserId: "bob",
    });

    const bob = await connect(handler, "bob");
    const m1 = await chat.api.sendMessage({
      userId: "alice",
      conversationId: conversation.id,
      body: "m1",
    });
    const [first] = await bob.waitForEvents(1);
    const lastSeenId = first!.id!;
    expect(lastSeenId).toBe(`${conversation.id}:${m1.seq}`);

    // A reaction arrives, then bob drops. Because the reaction frame had no
    // `id:`, his Last-Event-ID is still m1's - so m2 replays and nothing else.
    await chat.api.addReaction({ userId: "alice", messageId: m1.id, emoji: "👍" });
    await bob.waitForEvents(2);
    await bob.close();

    await chat.api.sendMessage({ userId: "alice", conversationId: conversation.id, body: "m2" });

    const bobAgain = await connect(handler, "bob", "", { "last-event-id": lastSeenId });
    const replayed = await bobAgain.waitForEvents(1);
    expect(replayed.map((e) => e.data.message.body)).toEqual(["m2"]);
    expect(replayed[0]!.event).toBe("message.created");
  });

  it("gap-filled frames carry replyTo and reactions, like live ones", async () => {
    const { chat, handler } = createHttpChat();
    const conversation = await chat.api.getOrCreateConversation({
      userId: "alice",
      otherUserId: "bob",
    });

    const bob = await connect(handler, "bob");
    const parent = await chat.api.sendMessage({
      userId: "alice",
      conversationId: conversation.id,
      body: "the original",
    });
    const [first] = await bob.waitForEvents(1);
    await bob.close();

    // Sent while bob is offline: a reply that also picks up a reaction.
    const reply = await chat.api.sendMessage({
      userId: "alice",
      conversationId: conversation.id,
      body: "quoting",
      replyToMessageId: parent.id,
    });
    await chat.api.addReaction({ userId: "alice", messageId: reply.id, emoji: "🎉" });

    const bobAgain = await connect(handler, "bob", "", { "last-event-id": first!.id! });
    const [replayed] = await bobAgain.waitForEvents(1);
    expect(replayed!.data.message.replyTo).toMatchObject({
      id: parent.id,
      excerpt: "the original",
    });
    expect(replayed!.data.message.reactions).toEqual([
      { emoji: "🎉", count: 1, userIds: ["alice"] },
    ]);
  });

  it("event ids are conversationId:seq for deterministic reconciliation", async () => {
    const { chat, handler } = createHttpChat();
    const conversation = await chat.api.getOrCreateConversation({
      userId: "alice",
      otherUserId: "bob",
    });

    const bob = await connect(handler, "bob");
    const message = await chat.api.sendMessage({
      userId: "alice",
      conversationId: conversation.id,
      body: "hi",
    });

    const [event] = await bob.waitForEvents(1);
    expect(event!.id).toBe(`${conversation.id}:${message.seq}`);
  });
});

describe("transport isolation", () => {
  it("a throwing subscriber never breaks the send path", async () => {
    const { chat } = createHttpChat();
    const conversation = await chat.api.getOrCreateConversation({
      userId: "alice",
      otherUserId: "bob",
    });

    chat.transport.subscribe(() => {
      throw new Error("broken subscriber");
    });

    await expect(
      chat.api.sendMessage({ userId: "alice", conversationId: conversation.id, body: "still ok" }),
    ).resolves.toMatchObject({ body: "still ok" });
  });
});
