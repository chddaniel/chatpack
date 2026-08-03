import { describe, expect, it, vi } from "vitest";
import { memoryAdapter } from "@chatpack/adapter-memory";
import { chatpack, type TransportEvent } from "@chatpack/core";
import { createChatClient } from "../src/client";
import type { ChatpackEventSource } from "../src/config";

/**
 * Stands in for the browser `EventSource` on one user's `/stream` connection:
 * takes transport events, applies the same recipient filter the SSE route
 * does, and dispatches them synchronously as `MessageEvent`s.
 */
class ScriptedEventSource implements ChatpackEventSource {
  readyState = 1;
  onopen: EventListener | null = null;
  onerror: EventListener | null = null;
  private readonly listeners = new Map<string, Set<(event: Event) => void>>();

  constructor(private readonly userId: string) {}

  addEventListener(type: string, listener: (event: Event) => void): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: (event: Event) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  close(): void {
    this.readyState = 2;
  }

  deliver(event: TransportEvent): void {
    if (!event.recipientIds.includes(this.userId)) return;
    const { recipientIds: _recipientIds, ...frame } = event;
    const message = new MessageEvent(event.type, { data: JSON.stringify(frame) });
    for (const listener of this.listeners.get(event.type) ?? []) listener(message);
  }
}

describe("client and handler integration", () => {
  it("uses the public handler without duplicating protocol logic", async () => {
    const chat = chatpack({
      storage: memoryAdapter(),
      auth: (request) => {
        const userId = request.headers.get("x-user-id");
        return userId === null ? null : { id: userId };
      },
    });
    const handler = chat.handler({ heartbeatIntervalMs: 0 });
    const client = createChatClient({
      fetch: async (input, init) => {
        const requestURL = new URL(input instanceof Request ? input.url : input);
        const headers = new Headers(init?.headers);
        headers.set("x-user-id", "alice");
        return handler.fetch(
          new Request("http://chatpack.invalid" + requestURL.pathname + requestURL.search, {
            ...init,
            headers,
          }),
        );
      },
    });

    const conversation = await client.conversations.create({ otherUserId: "bob" });
    expect(conversation.error).toBeNull();
    if (conversation.error !== null) return;

    const sent = await client.messages.send({
      conversationId: conversation.data.id,
      body: "hello from the client",
    });
    expect(sent.error).toBeNull();

    const page = await client.messages.list({ conversationId: conversation.data.id });
    expect(page).toMatchObject({
      error: null,
      data: { messages: [{ body: "hello from the client" }] },
    });
  });

  it("live-updates the conversations list when a message arrives elsewhere", async () => {
    const chat = chatpack({
      storage: memoryAdapter(),
      auth: (request) => {
        const userId = request.headers.get("x-user-id");
        return userId === null ? null : { id: userId };
      },
    });
    const handler = chat.handler({ heartbeatIntervalMs: 0 });
    const clientFor = (userId: string) =>
      createChatClient({
        userId,
        fetch: async (input, init) => {
          const requestURL = new URL(input instanceof Request ? input.url : input);
          const headers = new Headers(init?.headers);
          headers.set("x-user-id", userId);
          return handler.fetch(
            new Request("http://chatpack.invalid" + requestURL.pathname + requestURL.search, {
              ...init,
              headers,
            }),
          );
        },
        // Drive the stream by hand: feed the client the same events core
        // publishes to a connected SSE subscriber.
        eventSource: () => alicesStream,
      });

    const alicesStream = new ScriptedEventSource("alice");
    const alice = clientFor("alice");
    const bob = clientFor("bob");
    const carol = clientFor("carol");
    chat.transport.subscribe((event) => alicesStream.deliver(event));

    // Alice is in both conversations; carol's is the most recently active, so
    // bob's message has to move his conversation to the front of her list.
    const withBob = await bob.conversations.create({ otherUserId: "alice" });
    const withCarol = await carol.conversations.create({ otherUserId: "alice" });
    if (withBob.error !== null || withCarol.error !== null) throw new Error("setup failed");
    await bob.messages.send({ conversationId: withBob.data.id, body: "first" });
    await carol.messages.send({ conversationId: withCarol.data.id, body: "second" });

    const listed = await alice.conversations.list();
    expect(listed.data?.conversations.map((c) => [c.id, c.unreadCount])).toEqual([
      [withCarol.data.id, 1],
      [withBob.data.id, 1],
    ]);
    alice.realtime.connect();

    await bob.messages.send({ conversationId: withBob.data.id, body: "ping alice" });

    // Reordered to most-recently-active, and the server's count of 1 grew to 2.
    expect(
      alice.$store
        .getSnapshot()
        .conversations.data?.conversations.map((c) => [c.id, c.unreadCount]),
    ).toEqual([
      [withBob.data.id, 2],
      [withCarol.data.id, 1],
    ]);

    const newest = await alice.messages.list({ conversationId: withBob.data.id });
    if (newest.error !== null) throw new Error("list failed");
    await alice.conversations.markRead({
      conversationId: withBob.data.id,
      messageId: newest.data.messages[0]!.id,
    });
    expect(alice.$store.getSnapshot().conversations.data?.conversations[0]?.unreadCount).toBe(0);

    // A conversation created after alice loaded her list has no row to
    // reorder, so the client backfills it from the server instead.
    const dave = clientFor("dave");
    const withDave = await dave.conversations.create({ otherUserId: "alice" });
    if (withDave.error !== null) throw new Error("setup failed");
    await dave.messages.send({ conversationId: withDave.data.id, body: "hi alice" });
    await vi.waitFor(() => {
      const first = alice.$store.getSnapshot().conversations.data?.conversations[0];
      expect(first?.id).toBe(withDave.data.id);
      expect(first?.unreadCount).toBe(1);
    });

    alice.dispose();
    bob.dispose();
    carol.dispose();
    dave.dispose();
  });
});
