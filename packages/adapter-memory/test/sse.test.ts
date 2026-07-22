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
  data: { type: string; conversationId: string; message: { id: string; body: string } };
}

/** A tiny SSE client over the handler's ReadableStream response. */
class SseClient {
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  private buffer = "";
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
      const result = await Promise.race([
        this.reader.read(),
        new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 50)),
      ]);
      if (result === "timeout") continue;
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
        // lines starting with ":" are comments (heartbeats) — ignored
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
