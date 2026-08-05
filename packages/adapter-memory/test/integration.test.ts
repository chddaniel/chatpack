/**
 * M1 integration suite: the Chatpack core engine driven through the
 * in-memory adapter (MVP §10 - "core tested against the in-memory adapter").
 *
 * The first test is the M1 Definition of Done, verbatim from MVP §11:
 * "two users get a conversation and exchange messages via the core API in a test."
 */
import { describe, expect, it, vi } from "vitest";

import { ChatpackError, chatpack } from "@chatpack/core";
import { memoryAdapter } from "../src/index";

function createChat(options: Partial<Parameters<typeof chatpack>[0]> = {}) {
  return chatpack({ storage: memoryAdapter(), telemetry: false, ...options });
}

describe("M1 Definition of Done", () => {
  it("two users get a conversation and exchange messages via the core API", async () => {
    const chat = createChat();

    // Alice starts a conversation with Bob.
    const conversation = await chat.api.getOrCreateConversation({
      userId: "alice",
      otherUserId: "bob",
    });
    expect(conversation.participants.map((p) => p.userId).sort()).toEqual(["alice", "bob"]);

    // They exchange messages.
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

    // Both see the same history (newest-first).
    const aliceView = await chat.api.listMessages({
      userId: "alice",
      conversationId: conversation.id,
    });
    const bobView = await chat.api.listMessages({
      userId: "bob",
      conversationId: conversation.id,
    });

    expect(aliceView.messages.map((m) => m.body)).toEqual(["hey alice!", "hey bob!"]);
    expect(bobView.messages.map((m) => m.body)).toEqual(["hey alice!", "hey bob!"]);
  });
});

describe("conversations", () => {
  it("find-or-create is idempotent and order-independent (no duplicate DMs)", async () => {
    const chat = createChat();

    const first = await chat.api.getOrCreateConversation({ userId: "alice", otherUserId: "bob" });
    const second = await chat.api.getOrCreateConversation({ userId: "bob", otherUserId: "alice" });

    expect(second.id).toBe(first.id);

    const { conversations } = await chat.api.listConversations({ userId: "alice" });
    expect(conversations).toHaveLength(1);
  });

  it("rejects a conversation with yourself", async () => {
    const chat = createChat();
    await expect(
      chat.api.getOrCreateConversation({ userId: "alice", otherUserId: "alice" }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("stores metadata on creation only", async () => {
    const chat = createChat();
    const created = await chat.api.getOrCreateConversation({
      userId: "alice",
      otherUserId: "bob",
      metadata: { topic: "support" },
    });
    expect(created.metadata).toEqual({ topic: "support" });

    const again = await chat.api.getOrCreateConversation({
      userId: "alice",
      otherUserId: "bob",
      metadata: { topic: "changed" },
    });
    expect(again.metadata).toEqual({ topic: "support" });
  });

  it("lists conversations most-recently-active first with pagination", async () => {
    const chat = createChat();

    const withBob = await chat.api.getOrCreateConversation({
      userId: "alice",
      otherUserId: "bob",
    });
    const withCarol = await chat.api.getOrCreateConversation({
      userId: "alice",
      otherUserId: "carol",
    });
    const withDave = await chat.api.getOrCreateConversation({
      userId: "alice",
      otherUserId: "dave",
    });

    // Activity: bob last, then carol; dave has no messages.
    await chat.api.sendMessage({ userId: "alice", conversationId: withCarol.id, body: "hi c" });
    await chat.api.sendMessage({ userId: "alice", conversationId: withBob.id, body: "hi b" });

    const page1 = await chat.api.listConversations({ userId: "alice", limit: 2 });
    expect(page1.conversations.map((c) => c.id)).toEqual([withBob.id, withCarol.id]);
    expect(page1.nextCursor).not.toBeNull();

    const page2 = await chat.api.listConversations({
      userId: "alice",
      limit: 2,
      cursor: page1.nextCursor!,
    });
    expect(page2.conversations.map((c) => c.id)).toEqual([withDave.id]);
    expect(page2.nextCursor).toBeNull();
  });

  it("getConversation enforces read permission", async () => {
    const chat = createChat();
    const conversation = await chat.api.getOrCreateConversation({
      userId: "alice",
      otherUserId: "bob",
    });

    await expect(
      chat.api.getConversation({ userId: "mallory", conversationId: conversation.id }),
    ).rejects.toMatchObject({ code: "FORBIDDEN_READ" });

    await expect(
      chat.api.getConversation({ userId: "alice", conversationId: "nope" }),
    ).rejects.toMatchObject({ code: "CONVERSATION_NOT_FOUND" });
  });
});

describe("permissions", () => {
  it("only participants can read or write by default", async () => {
    const chat = createChat();
    const conversation = await chat.api.getOrCreateConversation({
      userId: "alice",
      otherUserId: "bob",
    });

    await expect(
      chat.api.sendMessage({ userId: "mallory", conversationId: conversation.id, body: "hi" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN_WRITE" });

    await expect(
      chat.api.listMessages({ userId: "mallory", conversationId: conversation.id }),
    ).rejects.toMatchObject({ code: "FORBIDDEN_READ" });
  });

  it("permission hooks can override the defaults", async () => {
    const chat = createChat({
      permissions: {
        canRead: () => true, // world-readable
        canWrite: ({ user }) => user.id === "alice", // alice-only writes
      },
    });
    const conversation = await chat.api.getOrCreateConversation({
      userId: "alice",
      otherUserId: "bob",
    });

    await chat.api.sendMessage({ userId: "alice", conversationId: conversation.id, body: "mine" });

    // bob is a participant but the hook denies writes
    await expect(
      chat.api.sendMessage({ userId: "bob", conversationId: conversation.id, body: "denied" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN_WRITE" });

    // mallory is not a participant but the hook allows reads
    const view = await chat.api.listMessages({
      userId: "mallory",
      conversationId: conversation.id,
    });
    expect(view.messages).toHaveLength(1);
  });
});

describe("message search", () => {
  it("searches case-insensitively across conversations, ranks terms, paginates, and skips tombstones", async () => {
    const chat = createChat({ permissions: { canRead: () => true } });
    const withBob = await chat.api.getOrCreateConversation({
      userId: "alice",
      otherUserId: "bob",
    });
    const withCarol = await chat.api.getOrCreateConversation({
      userId: "alice",
      otherUserId: "carol",
    });

    await chat.api.sendMessage({
      userId: "alice",
      conversationId: withBob.id,
      body: "hello from bob's conversation",
    });
    const deleted = await chat.api.sendMessage({
      userId: "alice",
      conversationId: withBob.id,
      body: "HELLO deleted secret",
    });
    await chat.api.deleteMessage({ userId: "alice", messageId: deleted.id });
    await chat.api.sendMessage({
      userId: "alice",
      conversationId: withCarol.id,
      body: "HELLO hello world",
    });

    const firstPage = await chat.api.searchMessages({
      userId: "alice",
      query: "HeLLo",
      limit: 1,
    });
    expect(firstPage.messages).toHaveLength(1);
    expect(firstPage.messages[0]!.body).toBe("HELLO hello world");
    expect(firstPage.nextCursor).not.toBeNull();

    const secondPage = await chat.api.searchMessages({
      userId: "alice",
      query: "hello",
      limit: 1,
      cursor: firstPage.nextCursor!,
    });
    expect(secondPage.messages.map((message) => message.body)).toEqual([
      "hello from bob's conversation",
    ]);
    expect(secondPage.nextCursor).toBeNull();
  });

  it("does not search non-participant conversations yet", async () => {
    const chat = createChat({
      permissions: {
        canRead: ({ user, conversation }) =>
          user.id === "support" || conversation.participantIds.includes(user.id),
      },
    });
    const conversation = await chat.api.getOrCreateConversation({
      userId: "alice",
      otherUserId: "bob",
    });
    await chat.api.sendMessage({
      userId: "alice",
      conversationId: conversation.id,
      body: "support searchable transcript",
    });

    const support = await chat.api.searchMessages({ userId: "support", query: "searchable" });
    expect(support.messages).toHaveLength(0);

    const stranger = await chat.api.searchMessages({ userId: "mallory", query: "searchable" });
    expect(stranger.messages).toHaveLength(0);
  });

  it("uses creation time as the tie-break after relevance", async () => {
    vi.useFakeTimers();
    try {
      const chat = createChat();
      const conversation = await chat.api.getOrCreateConversation({
        userId: "alice",
        otherUserId: "bob",
      });
      vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
      const older = await chat.api.sendMessage({
        userId: "alice",
        conversationId: conversation.id,
        body: "same term",
      });
      vi.setSystemTime(new Date("2026-01-01T00:00:01.000Z"));
      const newer = await chat.api.sendMessage({
        userId: "alice",
        conversationId: conversation.id,
        body: "same term",
      });

      const result = await chat.api.searchMessages({ userId: "alice", query: "same" });
      expect(result.messages.map((message) => message.id)).toEqual([newer.id, older.id]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps filtered results reachable across pages", async () => {
    let deniedConversationId: string | undefined;
    const chat = createChat({
      permissions: {
        canRead: ({ conversation }) => conversation.id !== deniedConversationId,
      },
    });
    const conversations = await Promise.all(
      ["one", "two", "three", "four"].map((otherUserId) =>
        chat.api.getOrCreateConversation({ userId: "alice", otherUserId }),
      ),
    );

    await chat.api.sendMessage({
      userId: "alice",
      conversationId: conversations[0]!.id,
      body: "needle needle needle needle",
    });
    await chat.api.sendMessage({
      userId: "alice",
      conversationId: conversations[1]!.id,
      body: "needle needle needle",
    });
    const denied = await chat.api.sendMessage({
      userId: "alice",
      conversationId: conversations[2]!.id,
      body: "needle needle",
    });
    deniedConversationId = denied.conversationId;
    await chat.api.sendMessage({
      userId: "alice",
      conversationId: conversations[3]!.id,
      body: "needle",
    });

    const firstPage = await chat.api.searchMessages({ userId: "alice", query: "needle", limit: 2 });
    expect(firstPage.messages.map((message) => message.body)).toEqual([
      "needle needle needle needle",
      "needle needle needle",
    ]);
    expect(firstPage.nextCursor).not.toBeNull();

    const secondPage = await chat.api.searchMessages({
      userId: "alice",
      query: "needle",
      limit: 2,
      cursor: firstPage.nextCursor!,
    });
    expect(secondPage.messages.map((message) => message.body)).toEqual(["needle"]);
    expect(secondPage.nextCursor).toBeNull();
  });

  it("continues after a deleted cursor anchor", async () => {
    const chat = createChat();
    const conversation = await chat.api.getOrCreateConversation({
      userId: "alice",
      otherUserId: "bob",
    });
    const first = await chat.api.sendMessage({
      userId: "alice",
      conversationId: conversation.id,
      body: "needle needle needle",
    });
    const anchor = await chat.api.sendMessage({
      userId: "alice",
      conversationId: conversation.id,
      body: "needle needle",
    });
    await chat.api.sendMessage({
      userId: "alice",
      conversationId: conversation.id,
      body: "needle",
    });

    const firstPage = await chat.api.searchMessages({ userId: "alice", query: "needle", limit: 2 });
    expect(firstPage.messages.map((message) => message.id)).toEqual([first.id, anchor.id]);
    await chat.api.deleteMessage({ userId: "alice", messageId: anchor.id });

    const secondPage = await chat.api.searchMessages({
      userId: "alice",
      query: "needle",
      limit: 2,
      cursor: firstPage.nextCursor!,
    });
    expect(secondPage.messages).toHaveLength(1);
    expect(secondPage.messages[0]!.body).toBe("needle");
  });

  it("matches canonical punctuation-separated tokens", async () => {
    const chat = createChat();
    const conversation = await chat.api.getOrCreateConversation({
      userId: "alice",
      otherUserId: "bob",
    });
    await chat.api.sendMessage({
      userId: "alice",
      conversationId: conversation.id,
      body: "reach me at user@example.com",
    });
    await chat.api.sendMessage({
      userId: "alice",
      conversationId: conversation.id,
      body: "shipping v1.2.3 today",
    });
    await chat.api.sendMessage({
      userId: "alice",
      conversationId: conversation.id,
      body: "see the deploy-preview link",
    });

    expect(
      (await chat.api.searchMessages({ userId: "alice", query: "example" })).messages,
    ).toHaveLength(1);
    expect(
      (await chat.api.searchMessages({ userId: "alice", query: "user@example.com" })).messages,
    ).toHaveLength(1);
    expect((await chat.api.searchMessages({ userId: "alice", query: "v1" })).messages).toHaveLength(
      1,
    );
    expect(
      (await chat.api.searchMessages({ userId: "alice", query: "v1.2.3" })).messages,
    ).toHaveLength(1);
    expect(
      (await chat.api.searchMessages({ userId: "alice", query: "deploy-preview" })).messages,
    ).toHaveLength(1);
  });

  it("matches the same URL, path, phone, host, and version corpus as Drizzle", async () => {
    const chat = createChat();
    const conversation = await chat.api.getOrCreateConversation({
      userId: "alice",
      otherUserId: "bob",
    });
    const bodies = [
      "path is src/index.ts here",
      "call me on +1-555-0100",
      "check https://chatpack.dev/docs/realtime for details",
      "the repo is github.com/chddaniel/chatpack",
      "read docs/decisions/0015-message-search.md",
    ];
    for (const body of bodies) {
      await chat.api.sendMessage({ userId: "alice", conversationId: conversation.id, body });
    }

    const cases = [
      ["src", [bodies[0]!]],
      ["index.ts", [bodies[0]!]],
      ["555", [bodies[1]!]],
      ["1-555-0100", [bodies[1]!]],
      ["chatpack", [bodies[2]!, bodies[3]!]],
      ["docs", [bodies[2]!, bodies[4]!]],
      ["realtime", [bodies[2]!]],
      ["chddaniel", [bodies[3]!]],
      ["decisions", [bodies[4]!]],
      ["0015-message-search.md", [bodies[4]!]],
    ] as const;

    for (const [query, expected] of cases) {
      const result = await chat.api.searchMessages({ userId: "alice", query });
      expect(result.messages.map((message) => message.body).sort()).toEqual([...expected].sort());
    }
  });

  it("hydrates reply previews and reactions", async () => {
    const chat = createChat();
    const conversation = await chat.api.getOrCreateConversation({
      userId: "alice",
      otherUserId: "bob",
    });
    const parent = await chat.api.sendMessage({
      userId: "alice",
      conversationId: conversation.id,
      body: "original context",
    });
    const reply = await chat.api.sendMessage({
      userId: "bob",
      conversationId: conversation.id,
      body: "searchable reply",
      replyToMessageId: parent.id,
    });
    await chat.api.addReaction({ userId: "alice", messageId: reply.id, emoji: "👍" });

    const result = await chat.api.searchMessages({ userId: "alice", query: "searchable" });
    expect(result.messages[0]!.replyTo).toMatchObject({
      id: parent.id,
      excerpt: "original context",
      deleted: false,
    });
    expect(result.messages[0]!.reactions).toEqual([{ emoji: "👍", count: 1, userIds: ["alice"] }]);
  });
});

describe("messages", () => {
  it("assigns a strictly increasing seq per conversation", async () => {
    const chat = createChat();
    const conversation = await chat.api.getOrCreateConversation({
      userId: "alice",
      otherUserId: "bob",
    });

    const sent = [];
    for (let i = 0; i < 5; i++) {
      sent.push(
        await chat.api.sendMessage({
          userId: i % 2 ? "bob" : "alice",
          conversationId: conversation.id,
          body: `m${i}`,
        }),
      );
    }
    const seqs = sent.map((m) => m.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
  });

  it("rejects empty bodies", async () => {
    const chat = createChat();
    const conversation = await chat.api.getOrCreateConversation({
      userId: "alice",
      otherUserId: "bob",
    });

    await expect(
      chat.api.sendMessage({ userId: "alice", conversationId: conversation.id, body: "   " }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("defaults role to user and keeps the AI escape hatches", async () => {
    const chat = createChat();
    const conversation = await chat.api.getOrCreateConversation({
      userId: "alice",
      otherUserId: "ai-bot",
    });

    const plain = await chat.api.sendMessage({
      userId: "alice",
      conversationId: conversation.id,
      body: "hello",
    });
    expect(plain.role).toBe("user");
    expect(plain.metadata).toEqual({});

    const assistant = await chat.api.sendMessage({
      userId: "ai-bot",
      conversationId: conversation.id,
      body: "how can I help?",
      role: "assistant",
      metadata: { model: "gpt", attachmentUrl: "https://example.com/f.png" },
    });
    expect(assistant.role).toBe("assistant");
    expect(assistant.metadata).toMatchObject({ model: "gpt" });
  });

  it("paginates newest-first with a stable cursor", async () => {
    const chat = createChat();
    const conversation = await chat.api.getOrCreateConversation({
      userId: "alice",
      otherUserId: "bob",
    });

    for (let i = 1; i <= 7; i++) {
      await chat.api.sendMessage({
        userId: "alice",
        conversationId: conversation.id,
        body: `m${i}`,
      });
    }

    const page1 = await chat.api.listMessages({
      userId: "bob",
      conversationId: conversation.id,
      limit: 3,
    });
    expect(page1.messages.map((m) => m.body)).toEqual(["m7", "m6", "m5"]);

    const page2 = await chat.api.listMessages({
      userId: "bob",
      conversationId: conversation.id,
      limit: 3,
      cursor: page1.nextCursor!,
    });
    expect(page2.messages.map((m) => m.body)).toEqual(["m4", "m3", "m2"]);

    const page3 = await chat.api.listMessages({
      userId: "bob",
      conversationId: conversation.id,
      limit: 3,
      cursor: page2.nextCursor!,
    });
    expect(page3.messages.map((m) => m.body)).toEqual(["m1"]);
    expect(page3.nextCursor).toBeNull();
  });
});

describe("edit and soft-delete", () => {
  it("lets the sender edit their message", async () => {
    const chat = createChat();
    const conversation = await chat.api.getOrCreateConversation({
      userId: "alice",
      otherUserId: "bob",
    });
    const message = await chat.api.sendMessage({
      userId: "alice",
      conversationId: conversation.id,
      body: "helo",
    });

    const edited = await chat.api.editMessage({
      userId: "alice",
      messageId: message.id,
      body: "hello",
    });
    expect(edited.body).toBe("hello");
    expect(edited.editedAt).toBeInstanceOf(Date);
    expect(edited.seq).toBe(message.seq); // editing does not reorder history
  });

  it("prevents anyone but the sender from editing or deleting", async () => {
    const chat = createChat();
    const conversation = await chat.api.getOrCreateConversation({
      userId: "alice",
      otherUserId: "bob",
    });
    const message = await chat.api.sendMessage({
      userId: "alice",
      conversationId: conversation.id,
      body: "mine",
    });

    await expect(
      chat.api.editMessage({ userId: "bob", messageId: message.id, body: "hacked" }),
    ).rejects.toMatchObject({ code: "NOT_MESSAGE_SENDER" });

    await expect(
      chat.api.deleteMessage({ userId: "bob", messageId: message.id }),
    ).rejects.toMatchObject({ code: "NOT_MESSAGE_SENDER" });
  });

  it("soft-deletes: message stays in history as a tombstone", async () => {
    const chat = createChat();
    const conversation = await chat.api.getOrCreateConversation({
      userId: "alice",
      otherUserId: "bob",
    });

    await chat.api.sendMessage({ userId: "alice", conversationId: conversation.id, body: "one" });
    const target = await chat.api.sendMessage({
      userId: "alice",
      conversationId: conversation.id,
      body: "two",
    });

    const deleted = await chat.api.deleteMessage({ userId: "alice", messageId: target.id });
    expect(deleted.deletedAt).toBeInstanceOf(Date);
    expect(deleted.body).toBe("");

    // Still present in history, still ordered.
    const view = await chat.api.listMessages({ userId: "bob", conversationId: conversation.id });
    expect(view.messages).toHaveLength(2);
    expect(view.messages[0]!.deletedAt).toBeInstanceOf(Date);

    // Deleting again is idempotent; editing a deleted message fails.
    await expect(
      chat.api.deleteMessage({ userId: "alice", messageId: target.id }),
    ).resolves.toMatchObject({ id: target.id });
    await expect(
      chat.api.editMessage({ userId: "alice", messageId: target.id, body: "resurrect" }),
    ).rejects.toMatchObject({ code: "MESSAGE_DELETED" });
  });

  it("errors on unknown messages", async () => {
    const chat = createChat();
    await expect(
      chat.api.editMessage({ userId: "alice", messageId: "nope", body: "x" }),
    ).rejects.toMatchObject({ code: "MESSAGE_NOT_FOUND" });
  });
});

describe("durable read-state", () => {
  it("tracks last_read per participant", async () => {
    const chat = createChat();
    const conversation = await chat.api.getOrCreateConversation({
      userId: "alice",
      otherUserId: "bob",
    });

    const m1 = await chat.api.sendMessage({
      userId: "alice",
      conversationId: conversation.id,
      body: "one",
    });
    await chat.api.sendMessage({ userId: "alice", conversationId: conversation.id, body: "two" });

    await chat.api.markRead({ userId: "bob", conversationId: conversation.id, messageId: m1.id });

    const fresh = await chat.api.getConversation({
      userId: "alice",
      conversationId: conversation.id,
    });
    const bob = fresh.participants.find((p) => p.userId === "bob")!;
    const alice = fresh.participants.find((p) => p.userId === "alice")!;
    expect(bob.lastReadMessageId).toBe(m1.id);
    expect(alice.lastReadMessageId).toBeNull();
  });

  it("rejects marking read with a message from another conversation", async () => {
    const chat = createChat();
    const ab = await chat.api.getOrCreateConversation({ userId: "alice", otherUserId: "bob" });
    const ac = await chat.api.getOrCreateConversation({ userId: "alice", otherUserId: "carol" });
    const inAc = await chat.api.sendMessage({
      userId: "alice",
      conversationId: ac.id,
      body: "elsewhere",
    });

    await expect(
      chat.api.markRead({ userId: "bob", conversationId: ab.id, messageId: inAc.id }),
    ).rejects.toMatchObject({ code: "MESSAGE_NOT_FOUND" });
  });

  it("rejects read-state updates from non-participants", async () => {
    const chat = createChat();
    const conversation = await chat.api.getOrCreateConversation({
      userId: "alice",
      otherUserId: "bob",
    });
    const message = await chat.api.sendMessage({
      userId: "alice",
      conversationId: conversation.id,
      body: "hi",
    });

    await expect(
      chat.api.markRead({
        userId: "mallory",
        conversationId: conversation.id,
        messageId: message.id,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN_READ" });
  });

  it("ignores a markRead older than the current read-state (monotonic)", async () => {
    const chat = createChat();
    const conversation = await chat.api.getOrCreateConversation({
      userId: "alice",
      otherUserId: "bob",
    });

    const m1 = await chat.api.sendMessage({
      userId: "alice",
      conversationId: conversation.id,
      body: "one",
    });
    const m2 = await chat.api.sendMessage({
      userId: "alice",
      conversationId: conversation.id,
      body: "two",
    });

    await chat.api.markRead({ userId: "bob", conversationId: conversation.id, messageId: m2.id });
    // Stale replay (e.g. out-of-order after reconnect): silently ignored.
    await chat.api.markRead({ userId: "bob", conversationId: conversation.id, messageId: m1.id });

    const fresh = await chat.api.getConversation({
      userId: "bob",
      conversationId: conversation.id,
    });
    expect(fresh.participants.find((p) => p.userId === "bob")!.lastReadMessageId).toBe(m2.id);
    expect(fresh.unreadCount).toBe(0);
  });
});

describe("unread counts", () => {
  it("is 0 for both participants in a fresh conversation", async () => {
    const chat = createChat();
    const conversation = await chat.api.getOrCreateConversation({
      userId: "alice",
      otherUserId: "bob",
    });
    expect(conversation.unreadCount).toBe(0);

    const bobView = await chat.api.getConversation({
      userId: "bob",
      conversationId: conversation.id,
    });
    expect(bobView.unreadCount).toBe(0);
  });

  it("counts the partner's messages, never the viewer's own", async () => {
    const chat = createChat();
    const conversation = await chat.api.getOrCreateConversation({
      userId: "alice",
      otherUserId: "bob",
    });

    for (const body of ["one", "two", "three"]) {
      await chat.api.sendMessage({ userId: "alice", conversationId: conversation.id, body });
    }

    const bobView = await chat.api.getConversation({
      userId: "bob",
      conversationId: conversation.id,
    });
    const aliceView = await chat.api.getConversation({
      userId: "alice",
      conversationId: conversation.id,
    });
    expect(bobView.unreadCount).toBe(3); // null read-state: everything counts
    expect(aliceView.unreadCount).toBe(0); // own messages are never unread
  });

  it("markRead shrinks the count; mid-history leaves the remainder", async () => {
    const chat = createChat();
    const conversation = await chat.api.getOrCreateConversation({
      userId: "alice",
      otherUserId: "bob",
    });

    const sent = [];
    for (const body of ["one", "two", "three"]) {
      sent.push(
        await chat.api.sendMessage({ userId: "alice", conversationId: conversation.id, body }),
      );
    }

    await chat.api.markRead({
      userId: "bob",
      conversationId: conversation.id,
      messageId: sent[1]!.id,
    });
    let bobView = await chat.api.getConversation({
      userId: "bob",
      conversationId: conversation.id,
    });
    expect(bobView.unreadCount).toBe(1);

    await chat.api.markRead({
      userId: "bob",
      conversationId: conversation.id,
      messageId: sent[2]!.id,
    });
    bobView = await chat.api.getConversation({ userId: "bob", conversationId: conversation.id });
    expect(bobView.unreadCount).toBe(0);
  });

  it("deleted messages still count (tombstones render in lists)", async () => {
    const chat = createChat();
    const conversation = await chat.api.getOrCreateConversation({
      userId: "alice",
      otherUserId: "bob",
    });

    const message = await chat.api.sendMessage({
      userId: "alice",
      conversationId: conversation.id,
      body: "oops",
    });
    await chat.api.deleteMessage({ userId: "alice", messageId: message.id });

    const bobView = await chat.api.getConversation({
      userId: "bob",
      conversationId: conversation.id,
    });
    expect(bobView.unreadCount).toBe(1);
  });

  it("assistant-role messages count", async () => {
    const chat = createChat();
    const conversation = await chat.api.getOrCreateConversation({
      userId: "alice",
      otherUserId: "ai-bot",
    });

    await chat.api.sendMessage({
      userId: "ai-bot",
      conversationId: conversation.id,
      body: "beep boop",
      role: "assistant",
    });

    const aliceView = await chat.api.getConversation({
      userId: "alice",
      conversationId: conversation.id,
    });
    expect(aliceView.unreadCount).toBe(1);
  });

  it("every page of listConversations carries per-conversation counts", async () => {
    const chat = createChat();
    const withBob = await chat.api.getOrCreateConversation({
      userId: "alice",
      otherUserId: "bob",
    });
    const withCarol = await chat.api.getOrCreateConversation({
      userId: "alice",
      otherUserId: "carol",
    });
    const withDave = await chat.api.getOrCreateConversation({
      userId: "alice",
      otherUserId: "dave",
    });

    await chat.api.sendMessage({ userId: "carol", conversationId: withCarol.id, body: "c1" });
    await chat.api.sendMessage({ userId: "carol", conversationId: withCarol.id, body: "c2" });
    await chat.api.sendMessage({ userId: "bob", conversationId: withBob.id, body: "b1" });

    const page1 = await chat.api.listConversations({ userId: "alice", limit: 2 });
    const page2 = await chat.api.listConversations({
      userId: "alice",
      limit: 2,
      cursor: page1.nextCursor!,
    });

    const byId = new Map(
      [...page1.conversations, ...page2.conversations].map((c) => [c.id, c.unreadCount]),
    );
    expect(byId.get(withBob.id)).toBe(1);
    expect(byId.get(withCarol.id)).toBe(2);
    expect(byId.get(withDave.id)).toBe(0);
  });
});

describe("telemetry counters (MVP §12)", () => {
  it("counts conversations created and messages sent", async () => {
    const chat = createChat({ telemetry: true });

    const conversation = await chat.api.getOrCreateConversation({
      userId: "alice",
      otherUserId: "bob",
    });
    // find-or-create hit: must NOT double count
    await chat.api.getOrCreateConversation({ userId: "bob", otherUserId: "alice" });

    await chat.api.sendMessage({ userId: "alice", conversationId: conversation.id, body: "1" });
    await chat.api.sendMessage({ userId: "bob", conversationId: conversation.id, body: "2" });

    expect(chat.telemetry.snapshot()).toEqual({ conversationsCreated: 1, messagesSent: 2 });
  });

  it("never counts anything when disabled", async () => {
    const chat = createChat({ telemetry: false });
    const conversation = await chat.api.getOrCreateConversation({
      userId: "alice",
      otherUserId: "bob",
    });
    await chat.api.sendMessage({ userId: "alice", conversationId: conversation.id, body: "1" });

    expect(chat.telemetry.enabled).toBe(false);
    expect(chat.telemetry.snapshot()).toEqual({ conversationsCreated: 0, messagesSent: 0 });
  });
});

describe("error type", () => {
  it("all core errors are ChatpackError instances", async () => {
    const chat = createChat();
    try {
      await chat.api.getConversation({ userId: "alice", conversationId: "nope" });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ChatpackError);
    }
  });
});
