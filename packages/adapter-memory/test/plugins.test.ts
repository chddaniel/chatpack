/**
 * Real-time trio integration suite (`docs/decisions/0008`): the ephemeral
 * event primitive and the first-party plugins from `@chatpack/core/plugins`
 * (typing, presence, receipts), exercised through the real HTTP handler and
 * `GET /stream` SSE endpoint.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  chatpack,
  type ChatpackHandler,
  type ChatpackInstance,
  type ChatpackPlugin,
  type PresenceStore,
} from "@chatpack/core";
import { typing, presence, receipts } from "@chatpack/core/plugins";
import { memoryAdapter } from "../src/index";

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
  // Keep the in-flight read across poll iterations: racing a fresh read()
  // against a timer would abandon reads that later resolve with real chunks.
  private pendingRead: Promise<ReadableStreamReadResult<Uint8Array>> | null = null;
  readonly events: SseEvent[] = [];

  constructor(response: Response) {
    this.reader = response.body!.getReader();
  }

  /** Pump the stream until `predicate` matches `count` events (or timeout). */
  async waitFor(
    predicate: (event: SseEvent) => boolean,
    count = 1,
    timeoutMs = 2000,
  ): Promise<SseEvent[]> {
    const deadline = Date.now() + timeoutMs;
    while (this.events.filter(predicate).length < count && Date.now() < deadline) {
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
    return this.events.filter(predicate);
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
      if (data) this.events.push({ id, event, data: JSON.parse(data) as Record<string, unknown> });
    }
  }

  async close(): Promise<void> {
    await this.reader.cancel();
  }
}

function createHttpChat(plugins?: ChatpackPlugin[]): {
  chat: ChatpackInstance;
  handler: ChatpackHandler;
} {
  const chat = chatpack({
    storage: memoryAdapter(),
    telemetry: false,
    auth: (request) => {
      const userId = request.headers.get("x-user-id");
      return userId ? { id: userId } : null;
    },
    ...(plugins ? { plugins } : {}),
  });
  return { chat, handler: chat.handler({ heartbeatIntervalMs: 0 }) };
}

function request(
  handler: ChatpackHandler,
  method: "GET" | "POST",
  path: string,
  userId: string,
  body?: unknown,
): Promise<Response> {
  const fn = method === "GET" ? handler.GET : handler.POST;
  return fn(
    new Request(`${BASE}${path}`, {
      method,
      headers: { "x-user-id": userId, "content-type": "application/json" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }),
  );
}

it("passes custom handler basePath to a PUT plugin route", async () => {
  const seen: string[] = [];
  const chat = chatpack({
    storage: memoryAdapter(),
    telemetry: false,
    auth: () => ({ id: "alice" }),
    plugins: [
      {
        name: "filepack",
        handleRequest(ctx) {
          seen.push(ctx.basePath);
          return ctx.method === "PUT" ? new Response("uploaded", { status: 200 }) : null;
        },
      },
    ],
  });
  const handler = chat.handler({ basePath: "/api/messaging", heartbeatIntervalMs: 0 });

  const response = await handler.PUT(
    new Request("http://test.local/api/messaging/uploads/attempt-1/content", {
      method: "PUT",
      headers: { "x-user-id": "alice" },
      body: "bytes",
    }),
  );

  expect(response.status).toBe(200);
  expect(await response.text()).toBe("uploaded");
  expect(seen).toEqual(["/api/messaging"]);
});

const openClients: SseClient[] = [];
afterEach(async () => {
  await Promise.all(openClients.map((c) => c.close()));
  openClients.length = 0;
});

async function connect(handler: ChatpackHandler, userId: string): Promise<SseClient> {
  const response = await handler.GET(
    new Request(`${BASE}/stream`, { headers: { "x-user-id": userId } }),
  );
  expect(response.status).toBe(200);
  const client = new SseClient(response);
  openClients.push(client);
  return client;
}

const isEphemeral = (e: SseEvent): boolean => e.data["ephemeral"] === true;

describe("typing()", () => {
  it("notifies the other participant, never the typist", async () => {
    const { chat, handler } = createHttpChat([typing()]);
    const conversation = await chat.api.getOrCreateConversation({
      userId: "alice",
      otherUserId: "bob",
    });

    const alice = await connect(handler, "alice");
    const bob = await connect(handler, "bob");

    const response = await request(
      handler,
      "POST",
      `/conversations/${conversation.id}/typing`,
      "alice",
    );
    expect(response.status).toBe(200);

    const [event] = await bob.waitFor((e) => e.event === "typing.started");
    expect(event).toBeDefined();
    expect(event!.data["senderId"]).toBe("alice");
    expect(event!.data["conversationId"]).toBe(conversation.id);

    const echoed = await alice.waitFor((e) => e.event === "typing.started", 1, 300);
    expect(echoed).toHaveLength(0);
  });

  it("isTyping: false publishes typing.stopped", async () => {
    const { chat, handler } = createHttpChat([typing()]);
    const conversation = await chat.api.getOrCreateConversation({
      userId: "alice",
      otherUserId: "bob",
    });
    const bob = await connect(handler, "bob");

    await request(handler, "POST", `/conversations/${conversation.id}/typing`, "alice", {
      isTyping: false,
    });

    const [event] = await bob.waitFor((e) => e.event === "typing.stopped");
    expect(event!.data["payload"]).toEqual({ isTyping: false });
  });

  it("ephemeral frames carry no SSE id, so Last-Event-ID is untouched", async () => {
    const { chat, handler } = createHttpChat([typing()]);
    const conversation = await chat.api.getOrCreateConversation({
      userId: "alice",
      otherUserId: "bob",
    });
    const bob = await connect(handler, "bob");

    await request(handler, "POST", `/conversations/${conversation.id}/typing`, "alice");
    await chat.api.sendMessage({ userId: "alice", conversationId: conversation.id, body: "hi" });

    const [typingEvent] = await bob.waitFor((e) => e.event === "typing.started");
    const [messageEvent] = await bob.waitFor((e) => e.event === "message.created");
    expect(typingEvent!.id).toBeNull();
    expect(messageEvent!.id).toBe(`${conversation.id}:1`);
  });

  it("enforces permissions and validates input", async () => {
    const { chat, handler } = createHttpChat([typing()]);
    const conversation = await chat.api.getOrCreateConversation({
      userId: "alice",
      otherUserId: "bob",
    });

    const forbidden = await request(
      handler,
      "POST",
      `/conversations/${conversation.id}/typing`,
      "mallory",
    );
    expect(forbidden.status).toBe(403);

    const missing = await request(handler, "POST", `/conversations/nope/typing`, "alice");
    expect(missing.status).toBe(404);

    const invalid = await request(
      handler,
      "POST",
      `/conversations/${conversation.id}/typing`,
      "alice",
      {
        isTyping: "yes",
      },
    );
    expect(invalid.status).toBe(400);
  });

  it("route does not exist without the plugin", async () => {
    const { chat, handler } = createHttpChat();
    const conversation = await chat.api.getOrCreateConversation({
      userId: "alice",
      otherUserId: "bob",
    });
    const response = await request(
      handler,
      "POST",
      `/conversations/${conversation.id}/typing`,
      "alice",
    );
    expect(response.status).toBe(404);
  });
});

describe("presence()", () => {
  it("returns null lastSeenAt for an unseen user", async () => {
    const { chat, handler } = createHttpChat([presence({ offlineDelayMs: 0 })]);
    await chat.api.getOrCreateConversation({ userId: "alice", otherUserId: "bob" });

    const response = await request(handler, "GET", "/presence?userIds=alice", "bob");
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      presence: Record<string, { online: boolean; lastSeenAt: string | null }>;
    };
    expect(body.presence["alice"]).toEqual({ online: false, lastSeenAt: null });
  });

  it("keeps reconnects inside the offline grace period", async () => {
    const { chat, handler } = createHttpChat([presence({ offlineDelayMs: 50 })]);
    await chat.api.getOrCreateConversation({ userId: "alice", otherUserId: "bob" });

    const bob = await connect(handler, "bob");
    const alice = await connect(handler, "alice");
    await bob.waitFor((e) => e.event === "presence.online");

    await alice.close();
    const reconnected = await connect(handler, "alice");
    const offline = await bob.waitFor((e) => e.event === "presence.offline", 1, 100);
    expect(offline).toHaveLength(0);
    await reconnected.close();
  });

  it("notifies a presence store only once for duplicate stream close", async () => {
    const close = vi.fn(async () => ({
      state: { online: false, lastSeenAt: new Date() },
      offlineToken: null,
    }));
    const store: PresenceStore = {
      open: vi.fn(async () => ({
        state: { online: true, lastSeenAt: new Date() },
        transition: null,
      })),
      heartbeat: vi.fn(async () => {}),
      close,
      finalizeOffline: vi.fn(async () => null),
      get: vi.fn(async () => ({ online: false, lastSeenAt: null })),
    };
    const { handler } = createHttpChat([presence({ store })]);
    const client = await connect(handler, "alice");
    await vi.waitFor(() => expect(store.open).toHaveBeenCalledTimes(1));

    await client.close();
    await client.close();
    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));
  });

  it("publishes presence.online / presence.offline to conversation partners", async () => {
    const { chat, handler } = createHttpChat([presence({ offlineDelayMs: 0 })]);
    await chat.api.getOrCreateConversation({ userId: "alice", otherUserId: "bob" });

    const bob = await connect(handler, "bob");
    const alice = await connect(handler, "alice");

    const [online] = await bob.waitFor((e) => e.event === "presence.online");
    expect(online!.data["senderId"]).toBe("alice");

    await alice.close();
    const [offline] = await bob.waitFor((e) => e.event === "presence.offline");
    expect(offline!.data["senderId"]).toBe("alice");
  });

  it("is multi-tab safe: offline only after the last stream closes", async () => {
    const { chat, handler } = createHttpChat([presence({ offlineDelayMs: 0 })]);
    await chat.api.getOrCreateConversation({ userId: "alice", otherUserId: "bob" });

    const bob = await connect(handler, "bob");
    const aliceTab1 = await connect(handler, "alice");
    const aliceTab2 = await connect(handler, "alice");
    await bob.waitFor((e) => e.event === "presence.online");

    await aliceTab1.close();
    const early = await bob.waitFor((e) => e.event === "presence.offline", 1, 300);
    expect(early).toHaveLength(0);

    await aliceTab2.close();
    const [offline] = await bob.waitFor((e) => e.event === "presence.offline");
    expect(offline!.data["senderId"]).toBe("alice");
  });

  it("GET /presence returns a snapshot, restricted to conversation partners", async () => {
    const { chat, handler } = createHttpChat([presence({ offlineDelayMs: 0 })]);
    await chat.api.getOrCreateConversation({ userId: "alice", otherUserId: "bob" });

    await connect(handler, "alice");

    const response = await request(handler, "GET", `/presence?userIds=alice,stranger`, "bob");
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      presence: Record<string, { online: boolean; lastSeenAt: string | null }>;
    };
    expect(body.presence["alice"]!.online).toBe(true);
    // No presence leaks: bob shares no conversation with "stranger".
    expect(body.presence["stranger"]).toBeUndefined();

    // mallory shares no conversation with alice either.
    const probed = await request(handler, "GET", `/presence?userIds=alice`, "mallory");
    const probedBody = (await probed.json()) as { presence: Record<string, unknown> };
    expect(probedBody.presence["alice"]).toBeUndefined();
  });

  it("returns an internal error when a shared presence snapshot fails", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const failedStore: PresenceStore = {
      open: async () => ({
        state: { online: true, lastSeenAt: new Date() },
        transition: null,
      }),
      heartbeat: async () => {},
      close: async () => ({
        state: { online: false, lastSeenAt: new Date() },
        offlineToken: null,
      }),
      finalizeOffline: async () => null,
      get: async () => {
        throw new Error("presence store unavailable");
      },
    };
    try {
      const { chat, handler } = createHttpChat([presence({ store: failedStore })]);
      await chat.api.getOrCreateConversation({ userId: "alice", otherUserId: "bob" });
      const response = await request(handler, "GET", "/presence?userIds=alice", "bob");
      expect(response.status).toBe(500);
      expect(errorSpy).toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });
});

describe("receipts()", () => {
  it("sends receipt.delivered to the sender when the recipient's stream receives the message", async () => {
    const { chat, handler } = createHttpChat([receipts()]);
    const conversation = await chat.api.getOrCreateConversation({
      userId: "alice",
      otherUserId: "bob",
    });

    const alice = await connect(handler, "alice");
    const bob = await connect(handler, "bob");

    const message = await chat.api.sendMessage({
      userId: "alice",
      conversationId: conversation.id,
      body: "hi",
    });

    await bob.waitFor((e) => e.event === "message.created");
    const [delivered] = await alice.waitFor((e) => e.event === "receipt.delivered");
    expect(delivered!.data["senderId"]).toBe("bob");
    expect(delivered!.data["payload"]).toEqual({ messageId: message.id, seq: message.seq });

    // bob (the recipient) gets no delivered tick - it's for the sender only.
    const bobTicks = await bob.waitFor((e) => e.event === "receipt.delivered", 1, 300);
    expect(bobTicks).toHaveLength(0);
  });

  it("no delivered tick when the recipient is offline", async () => {
    const { chat, handler } = createHttpChat([receipts()]);
    const conversation = await chat.api.getOrCreateConversation({
      userId: "alice",
      otherUserId: "bob",
    });
    const alice = await connect(handler, "alice");

    await chat.api.sendMessage({ userId: "alice", conversationId: conversation.id, body: "hi" });

    const ticks = await alice.waitFor((e) => e.event === "receipt.delivered", 1, 300);
    expect(ticks).toHaveLength(0);
  });

  it("sends receipt.read to the other participant on mark-read", async () => {
    const { chat, handler } = createHttpChat([receipts()]);
    const conversation = await chat.api.getOrCreateConversation({
      userId: "alice",
      otherUserId: "bob",
    });
    const message = await chat.api.sendMessage({
      userId: "alice",
      conversationId: conversation.id,
      body: "hi",
    });

    const alice = await connect(handler, "alice");

    const response = await request(
      handler,
      "POST",
      `/conversations/${conversation.id}/read`,
      "bob",
      {
        messageId: message.id,
      },
    );
    expect(response.status).toBe(200);

    const [read] = await alice.waitFor((e) => e.event === "receipt.read");
    expect(read!.data["senderId"]).toBe("bob");
    expect(read!.data["payload"]).toEqual({ messageId: message.id });
  });

  // A reaction is durable-backed but is not a message, so it must not look like
  // a delivery to the receipts plugin (ADR 0013 §4) - otherwise every reaction
  // would fire a duplicate "delivered" tick for a message sent long ago.
  it("a reaction never fires a delivered tick", async () => {
    const { chat, handler } = createHttpChat([receipts()]);
    const conversation = await chat.api.getOrCreateConversation({
      userId: "alice",
      otherUserId: "bob",
    });

    const alice = await connect(handler, "alice");
    const bob = await connect(handler, "bob");

    const message = await chat.api.sendMessage({
      userId: "alice",
      conversationId: conversation.id,
      body: "hi",
    });
    await bob.waitFor((e) => e.event === "message.created");
    await alice.waitFor((e) => e.event === "receipt.delivered");

    await chat.api.addReaction({ userId: "bob", messageId: message.id, emoji: "👍" });
    await alice.waitFor((e) => e.event === "reaction.added");

    // Still exactly the one tick from the original message.
    const ticks = await alice.waitFor((e) => e.event === "receipt.delivered", 2, 300);
    expect(ticks).toHaveLength(1);
  });
});

describe("ephemeral events vs gap-fill", () => {
  it("reconnect replays only durable messages, never ephemeral events", async () => {
    const { chat, handler } = createHttpChat([typing(), receipts()]);
    const conversation = await chat.api.getOrCreateConversation({
      userId: "alice",
      otherUserId: "bob",
    });

    const bob = await connect(handler, "bob");
    await request(handler, "POST", `/conversations/${conversation.id}/typing`, "alice");
    await chat.api.sendMessage({ userId: "alice", conversationId: conversation.id, body: "m1" });
    await bob.waitFor((e) => e.event === "typing.started");
    const [m1] = await bob.waitFor((e) => e.event === "message.created");
    await bob.close();

    // While bob is offline: another typing burst and a durable message.
    await request(handler, "POST", `/conversations/${conversation.id}/typing`, "alice");
    await chat.api.sendMessage({ userId: "alice", conversationId: conversation.id, body: "m2" });

    const response = await handler.GET(
      new Request(`${BASE}/stream`, {
        headers: { "x-user-id": "bob", "last-event-id": m1!.id! },
      }),
    );
    const bobAgain = new SseClient(response);
    openClients.push(bobAgain);

    const replayed = await bobAgain.waitFor((e) => e.event === "message.created");
    expect(replayed.map((e) => (e.data["message"] as { body: string }).body)).toEqual(["m2"]);
    expect(bobAgain.events.filter(isEphemeral)).toHaveLength(0);
  });

  it("all three plugins together deliver a coherent stream", async () => {
    const { chat, handler } = createHttpChat([
      typing(),
      presence({ offlineDelayMs: 0 }),
      receipts(),
    ]);
    const conversation = await chat.api.getOrCreateConversation({
      userId: "alice",
      otherUserId: "bob",
    });

    const alice = await connect(handler, "alice");
    const bob = await connect(handler, "bob");

    // alice connected first, so she sees bob's online transition.
    await alice.waitFor((e) => e.event === "presence.online");
    await request(handler, "POST", `/conversations/${conversation.id}/typing`, "alice");
    const message = await chat.api.sendMessage({
      userId: "alice",
      conversationId: conversation.id,
      body: "hello!",
    });
    await request(handler, "POST", `/conversations/${conversation.id}/read`, "bob", {
      messageId: message.id,
    });

    await bob.waitFor((e) => e.event === "typing.started");
    await bob.waitFor((e) => e.event === "message.created");
    await alice.waitFor((e) => e.event === "receipt.delivered");
    await alice.waitFor((e) => e.event === "receipt.read");

    // Durable events carry ids; ephemeral events never do.
    for (const event of [...alice.events, ...bob.events]) {
      if (isEphemeral(event)) expect(event.id).toBeNull();
      else expect(event.id).not.toBeNull();
    }
  });
});
