import { describe, expect, it } from "vitest";
import { createChatpackCache } from "../src/store-cache";
import type { ClientConversation, ClientMessage, ClientMessagePage } from "../src/wire";

const page: ClientMessagePage = {
  messages: [
    {
      id: "m1",
      conversationId: "c1",
      senderId: "alice",
      body: "hello",
      role: "user",
      metadata: {},
      seq: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
      editedAt: null,
      deletedAt: null,
    },
  ],
  nextCursor: null,
};

const conversation: ClientConversation = {
  id: "c1",
  pairKey: "alice:bob",
  metadata: {},
  createdAt: "2026-01-01T00:00:00.000Z",
  participants: [],
  unreadCount: 0,
};

function makeConversation(id: string, unreadCount = 0): ClientConversation {
  return { ...conversation, id, unreadCount };
}

function makeMessage(overrides: Partial<ClientMessage> & { seq: number }): ClientMessage {
  return { ...page.messages[0]!, senderId: "bob", ...overrides, id: overrides.id ?? "m_new" };
}

/** A loaded two-conversation list, oldest-active last (server ordering). */
function cacheWithList(unread: [number, number] = [0, 0]) {
  const cache = createChatpackCache({ userId: "alice" });
  cache.setConversations(
    {
      data: {
        conversations: [makeConversation("c1", unread[0]), makeConversation("c2", unread[1])],
        nextCursor: null,
      },
      error: null,
    },
    false,
  );
  return cache;
}

const listOf = (cache: ReturnType<typeof cacheWithList>) =>
  cache.getSnapshot().conversations.data!.conversations.map((c) => [c.id, c.unreadCount]);

describe("conversations list realtime updates", () => {
  it("reorders to most-recently-active and bumps unreadCount for another party's message", () => {
    const cache = cacheWithList();
    cache.applyEvent({
      type: "message.created",
      conversationId: "c2",
      message: makeMessage({ conversationId: "c2", seq: 1 }),
    });
    expect(listOf(cache)).toEqual([
      ["c2", 1],
      ["c1", 0],
    ]);
  });

  it("reorders but does not bump unread for the viewer's own message", () => {
    const cache = cacheWithList();
    cache.applyEvent({
      type: "message.created",
      conversationId: "c2",
      message: makeMessage({ conversationId: "c2", seq: 1, senderId: "alice" }),
    });
    expect(listOf(cache)).toEqual([
      ["c2", 0],
      ["c1", 0],
    ]);
  });

  it("does not bump unread for a locally sent message when userId is unknown", () => {
    const cache = createChatpackCache();
    cache.setConversations(
      { data: { conversations: [makeConversation("c1")], nextCursor: null }, error: null },
      false,
    );
    const own = makeMessage({ seq: 1, senderId: "alice" });
    cache.applyEvent(
      { type: "message.created", conversationId: "c1", message: own },
      {
        local: true,
      },
    );
    // The local echo taught the cache who the viewer is, so their own message
    // arriving again over the stream must still not count as unread.
    cache.applyEvent({ type: "message.created", conversationId: "c1", message: own });
    expect(listOf(cache)).toEqual([["c1", 0]]);
  });

  it("counts a redelivered event only once (at-least-once delivery)", () => {
    const cache = cacheWithList();
    const event = {
      type: "message.created" as const,
      conversationId: "c2",
      message: makeMessage({ conversationId: "c2", seq: 1 }),
    };
    cache.applyEvent(event);
    cache.applyEvent(event);
    expect(listOf(cache)).toEqual([
      ["c2", 1],
      ["c1", 0],
    ]);
  });

  it("does not re-count a message already present in fetched history", () => {
    const cache = cacheWithList();
    const message = makeMessage({ conversationId: "c2", seq: 7 });
    cache.setMessages(
      "c2",
      { data: { messages: [message], nextCursor: null }, error: null },
      false,
    );
    cache.applyEvent({ type: "message.created", conversationId: "c2", message });
    expect(listOf(cache)).toEqual([
      ["c1", 0],
      ["c2", 0],
    ]);
  });

  it("leaves ordering and unread alone for edits and deletes", () => {
    const cache = cacheWithList([0, 3]);
    const message = makeMessage({ conversationId: "c2", seq: 9 });
    cache.applyEvent({ type: "message.updated", conversationId: "c2", message });
    cache.applyEvent({ type: "message.deleted", conversationId: "c2", message });
    expect(listOf(cache)).toEqual([
      ["c1", 0],
      ["c2", 3],
    ]);
  });

  it("clears unreadCount on markRead of the newest known message", () => {
    const cache = cacheWithList();
    const message = makeMessage({ conversationId: "c2", id: "m9", seq: 4 });
    cache.applyEvent({ type: "message.created", conversationId: "c2", message });
    cache.setMessages(
      "c2",
      { data: { messages: [message], nextCursor: null }, error: null },
      false,
    );
    cache.applyRead("c2", "m9");
    expect(listOf(cache)).toEqual([
      ["c2", 0],
      ["c1", 0],
    ]);
  });

  it("keeps unreadCount when markRead targets an older message", () => {
    const cache = cacheWithList();
    const older = makeMessage({ conversationId: "c2", id: "m1", seq: 1 });
    const newer = makeMessage({ conversationId: "c2", id: "m2", seq: 2 });
    cache.setMessages(
      "c2",
      { data: { messages: [newer, older], nextCursor: null }, error: null },
      false,
    );
    cache.applyEvent({
      type: "message.created",
      conversationId: "c2",
      message: makeMessage({ conversationId: "c2", id: "m3", seq: 3 }),
    });
    cache.applyRead("c2", "m1");
    expect(listOf(cache)).toEqual([
      ["c2", 1],
      ["c1", 0],
    ]);
  });

  it("mirrors unread changes onto a per-id conversation entry", () => {
    const cache = cacheWithList();
    cache.setConversation("c2", { data: makeConversation("c2", 0), error: null });
    cache.applyEvent({
      type: "message.created",
      conversationId: "c2",
      message: makeMessage({ conversationId: "c2", seq: 1 }),
    });
    expect(cache.getSnapshot().conversationsById["c2"]?.data?.unreadCount).toBe(1);
    cache.applyRead("c2", "m_new");
    expect(cache.getSnapshot().conversationsById["c2"]?.data?.unreadCount).toBe(0);
  });

  it("reports a conversation missing from a loaded list, and prepends it once", () => {
    const cache = cacheWithList();
    expect(cache.isMissingFromConversations("c3")).toBe(true);
    expect(cache.isMissingFromConversations("c1")).toBe(false);
    cache.prependConversation(makeConversation("c3", 1));
    cache.prependConversation(makeConversation("c3", 1));
    expect(listOf(cache)).toEqual([
      ["c3", 1],
      ["c1", 0],
      ["c2", 0],
    ]);
  });

  it("never reports missing while the list has not loaded", () => {
    const cache = createChatpackCache();
    expect(cache.isMissingFromConversations("c1")).toBe(false);
  });

  it("ignores events for a list that has not loaded yet", () => {
    const cache = createChatpackCache({ userId: "alice" });
    cache.applyEvent({
      type: "message.created",
      conversationId: "c1",
      message: makeMessage({ seq: 1 }),
    });
    expect(cache.getSnapshot().conversations.data).toBeNull();
  });
});

describe("cache loading flags", () => {
  it("treats a never-loaded id as pending, not refetching", () => {
    const cache = createChatpackCache();
    cache.setMessagesLoading("c1");
    expect(cache.getSnapshot().messagesByConversation["c1"]).toMatchObject({
      isPending: true,
      isRefetching: false,
    });
    cache.setConversationLoading("c1");
    expect(cache.getSnapshot().conversationsById["c1"]).toMatchObject({
      isPending: true,
      isRefetching: false,
    });
  });

  it("treats a reload of cached data as refetching, not pending", () => {
    const cache = createChatpackCache();
    cache.setMessages("c1", { data: page, error: null }, false);
    cache.setMessagesLoading("c1");
    expect(cache.getSnapshot().messagesByConversation["c1"]).toMatchObject({
      isPending: false,
      isRefetching: true,
    });
    cache.setConversation("c1", { data: conversation, error: null });
    cache.setConversationLoading("c1");
    expect(cache.getSnapshot().conversationsById["c1"]).toMatchObject({
      isPending: false,
      isRefetching: true,
    });
  });
});
