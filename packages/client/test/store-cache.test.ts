import { describe, expect, it } from "vitest";
import { createChatpackCache } from "../src/store-cache";
import type { ClientConversation, ClientMessagePage } from "../src/wire";

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
