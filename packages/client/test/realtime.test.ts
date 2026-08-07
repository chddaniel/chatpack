import { describe, expect, it } from "vitest";
import {
  createRealtime,
  isConversationChatEvent,
  isReactionChatEvent,
  type ChatpackEvent,
} from "../src/realtime";
import type { ChatpackEventSource } from "../src/config";

class MockEventSource implements ChatpackEventSource {
  readyState = 0;
  onopen: EventListener | null = null;
  onerror: EventListener | null = null;
  private readonly listeners = new Map<string, Set<(event: Event) => void>>();

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

  emit(type: string, data: unknown): void {
    const event = new MessageEvent(type, { data: JSON.stringify(data) });
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

describe("realtime", () => {
  it("uses one lazy stream and dispatches durable and ephemeral events", () => {
    const source = new MockEventSource();
    const received: string[] = [];
    const realtime = createRealtime({
      url: "/api/chat/stream",
      credentials: "same-origin",
      eventSource: () => source,
      eventTypes: ["message.created", "typing.started"],
      onEvent: (event) => received.push(event.type),
    });

    expect(realtime.getSnapshot().status).toBe("idle");
    const unsubscribe = realtime.subscribe((event) => received.push(event.type));
    realtime.connect();
    expect(realtime.getSnapshot().status).toBe("connecting");
    source.onopen?.(new Event("open"));
    expect(realtime.getSnapshot().status).toBe("open");
    source.emit("typing.started", {
      type: "typing.started",
      ephemeral: true,
      senderId: "bob",
      conversationId: "c1",
      payload: { isTyping: true },
      at: "2026-01-01T00:00:00.000Z",
    });
    source.emit("message.created", {
      type: "message.created",
      conversationId: "c1",
      message: {
        id: "m1",
        conversationId: "c1",
        senderId: "bob",
        body: "hello",
        role: "user",
        metadata: {},
        seq: 1,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        deletedAt: null,
      },
    });
    expect(received).toEqual([
      "typing.started",
      "typing.started",
      "message.created",
      "message.created",
    ]);
    unsubscribe();
    realtime.disconnect();
    expect(realtime.getSnapshot().status).toBe("closed");
  });

  it("parses reaction events and rejects malformed ones (ADR 0013)", () => {
    const source = new MockEventSource();
    const received: ChatpackEvent[] = [];
    const realtime = createRealtime({
      url: "/api/chat/stream",
      credentials: "same-origin",
      eventSource: () => source,
      eventTypes: ["reaction.added", "reaction.removed"],
      onEvent: (event) => received.push(event),
    });
    realtime.connect();

    const message = {
      id: "m1",
      conversationId: "c1",
      senderId: "bob",
      body: "hello",
      role: "user",
      metadata: {},
      seq: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
      editedAt: null,
      deletedAt: null,
      replyToMessageId: null,
      replyTo: null,
      reactions: [{ emoji: "👍", count: 1, userIds: ["bob"] }],
    };
    source.emit("reaction.added", {
      type: "reaction.added",
      conversationId: "c1",
      actorId: "bob",
      emoji: "👍",
      message,
    });

    expect(received).toHaveLength(1);
    const event = received[0]!;
    expect(isReactionChatEvent(event)).toBe(true);
    if (!isReactionChatEvent(event)) throw new Error("expected a reaction event");
    expect(event.actorId).toBe("bob");
    expect(event.emoji).toBe("👍");
    expect(event.message.reactions).toEqual([{ emoji: "👍", count: 1, userIds: ["bob"] }]);

    // A frame missing any required field is dropped, never half-applied.
    source.emit("reaction.added", { type: "reaction.added", conversationId: "c1", message });
    source.emit("reaction.removed", {
      type: "reaction.removed",
      conversationId: "c1",
      actorId: "bob",
      emoji: "👍",
      message: { id: "m1" },
    });
    expect(received).toHaveLength(1);

    realtime.disconnect();
  });

  it("parses conversation events and rejects malformed ones (ADR 0017)", () => {
    const source = new MockEventSource();
    const received: ChatpackEvent[] = [];
    const realtime = createRealtime({
      url: "/api/chat/stream",
      credentials: "same-origin",
      eventSource: () => source,
      eventTypes: ["participant.added", "participant.removed", "conversation.updated"],
      onEvent: (event) => received.push(event),
    });
    realtime.connect();

    const conversation = {
      id: "c1",
      type: "group",
      pairKey: null,
      name: "Standup",
      metadata: {},
      createdAt: "2026-01-01T00:00:00.000Z",
      participants: [
        {
          conversationId: "c1",
          userId: "alice",
          role: "admin",
          joinedAt: "2026-01-01T00:00:00.000Z",
          lastReadMessageId: null,
        },
        {
          conversationId: "c1",
          userId: "bob",
          role: "member",
          joinedAt: "2026-01-01T00:00:00.000Z",
          lastReadMessageId: null,
        },
      ],
    };
    source.emit("participant.added", {
      type: "participant.added",
      conversationId: "c1",
      actorId: "alice",
      affectedUserIds: ["bob"],
      conversation,
    });

    expect(received).toHaveLength(1);
    const event = received[0]!;
    expect(isConversationChatEvent(event)).toBe(true);
    if (!isConversationChatEvent(event)) throw new Error("expected a conversation event");
    expect(event.actorId).toBe("alice");
    expect(event.affectedUserIds).toEqual(["bob"]);
    expect(event.conversation.name).toBe("Standup");
    expect(event.conversation.participants.map((p) => p.role)).toEqual(["admin", "member"]);

    // A frame missing any required field is dropped, never half-applied.
    source.emit("participant.added", {
      type: "participant.added",
      conversationId: "c1",
      conversation,
    });
    source.emit("conversation.updated", {
      type: "conversation.updated",
      conversationId: "c1",
      actorId: "alice",
      affectedUserIds: [],
      conversation: { id: "c1" },
    });
    expect(received).toHaveLength(1);

    realtime.disconnect();
  });

  it("reports a stream error instead of throwing when EventSource is unavailable", () => {
    const realtime = createRealtime({
      url: "/api/chat/stream",
      credentials: "same-origin",
      eventSource: () => {
        throw new ReferenceError("EventSource is not defined");
      },
      eventTypes: ["message.created"],
      onEvent: () => undefined,
    });

    // Data hooks call connect() from an effect, so a throw here would crash the
    // mounting component in SSR/React Native runtimes.
    expect(() => realtime.connect()).not.toThrow();
    expect(realtime.getSnapshot()).toMatchObject({
      status: "closed",
      error: { code: "NETWORK_ERROR" },
    });
  });
});
