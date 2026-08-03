/**
 * Reactions and quote-replies (`docs/decisions/0013`), driven through the core
 * engine on the in-memory adapter, plus the two new HTTP routes.
 *
 * The invariants worth guarding here are the ones the ADR bought with its
 * design: a reaction must not disturb `seq`, conversation ordering, or unread
 * counts, and a `replyTo` preview must be hydrated per request (never stale).
 */
import { describe, expect, it } from "vitest";

import { chatpack, type ChatpackHandler } from "@chatpack/core";
import { memoryAdapter } from "../src/index";

const BASE = "http://test.local/api/chat";

function createChat(options: Partial<Parameters<typeof chatpack>[0]> = {}) {
  return chatpack({ storage: memoryAdapter(), telemetry: false, ...options });
}

function createHttpChat(): ChatpackHandler {
  return chatpack({
    storage: memoryAdapter(),
    telemetry: false,
    auth: (request) => {
      const userId = request.headers.get("x-user-id");
      return userId ? { id: userId } : null;
    },
  }).handler();
}

function send(
  handler: ChatpackHandler,
  method: "POST" | "PATCH" | "DELETE",
  path: string,
  userId?: string,
  body?: unknown,
): Promise<Response> {
  return handler.fetch(
    new Request(`${BASE}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        ...(userId ? { "x-user-id": userId } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }),
  );
}

/** alice + bob, with one message from alice. */
async function seed(chat: ReturnType<typeof createChat>) {
  const conversation = await chat.api.getOrCreateConversation({
    userId: "alice",
    otherUserId: "bob",
  });
  const message = await chat.api.sendMessage({
    userId: "alice",
    conversationId: conversation.id,
    body: "the original",
  });
  return { conversation, message };
}

describe("quote-replies", () => {
  it("stores the pointer and hydrates a preview of the parent", async () => {
    const chat = createChat();
    const { conversation, message } = await seed(chat);

    const reply = await chat.api.sendMessage({
      userId: "bob",
      conversationId: conversation.id,
      body: "replying to that",
      replyToMessageId: message.id,
    });

    expect(reply.replyToMessageId).toBe(message.id);
    expect(reply.replyTo).toEqual({
      id: message.id,
      senderId: "alice",
      excerpt: "the original",
      deleted: false,
    });
    // A normal message carries the same fields, both empty.
    const plain = await chat.api.sendMessage({
      userId: "bob",
      conversationId: conversation.id,
      body: "unrelated",
    });
    expect(plain.replyToMessageId).toBeNull();
    expect(plain.replyTo).toBeNull();
  });

  it("hydrates the preview per request, so editing the parent is never stale", async () => {
    const chat = createChat();
    const { conversation, message } = await seed(chat);
    await chat.api.sendMessage({
      userId: "bob",
      conversationId: conversation.id,
      body: "quoting",
      replyToMessageId: message.id,
    });

    await chat.api.editMessage({ userId: "alice", messageId: message.id, body: "edited original" });

    const view = await chat.api.listMessages({ userId: "bob", conversationId: conversation.id });
    expect(view.messages[0]!.replyTo?.excerpt).toBe("edited original");
  });

  it("shows a deleted parent as an empty tombstone preview, keeping the reply", async () => {
    const chat = createChat();
    const { conversation, message } = await seed(chat);
    const reply = await chat.api.sendMessage({
      userId: "bob",
      conversationId: conversation.id,
      body: "quoting",
      replyToMessageId: message.id,
    });

    await chat.api.deleteMessage({ userId: "alice", messageId: message.id });

    const view = await chat.api.listMessages({ userId: "bob", conversationId: conversation.id });
    const refetched = view.messages.find((m) => m.id === reply.id)!;
    expect(refetched.body).toBe("quoting"); // the reply itself survives
    expect(refetched.replyTo).toEqual({
      id: message.id,
      senderId: "alice",
      excerpt: "",
      deleted: true,
    });
  });

  it("allows replying to an already-deleted message", async () => {
    const chat = createChat();
    const { conversation, message } = await seed(chat);
    await chat.api.deleteMessage({ userId: "alice", messageId: message.id });

    const reply = await chat.api.sendMessage({
      userId: "bob",
      conversationId: conversation.id,
      body: "what was that?",
      replyToMessageId: message.id,
    });
    expect(reply.replyTo?.deleted).toBe(true);
  });

  it("truncates a long excerpt at 140 characters with an ellipsis", async () => {
    const chat = createChat();
    const conversation = await chat.api.getOrCreateConversation({
      userId: "alice",
      otherUserId: "bob",
    });
    const long = "x".repeat(200);
    const parent = await chat.api.sendMessage({
      userId: "alice",
      conversationId: conversation.id,
      body: long,
    });
    const reply = await chat.api.sendMessage({
      userId: "bob",
      conversationId: conversation.id,
      body: "long one",
      replyToMessageId: parent.id,
    });

    expect(reply.replyTo!.excerpt).toBe(`${"x".repeat(140)}…`);

    // A body exactly at the limit is not truncated.
    const exact = await chat.api.sendMessage({
      userId: "alice",
      conversationId: conversation.id,
      body: "y".repeat(140),
    });
    const exactReply = await chat.api.sendMessage({
      userId: "bob",
      conversationId: conversation.id,
      body: "exact",
      replyToMessageId: exact.id,
    });
    expect(exactReply.replyTo!.excerpt).toBe("y".repeat(140));
  });

  it("rejects a parent from another conversation or one that does not exist", async () => {
    const chat = createChat();
    const { conversation } = await seed(chat);
    const other = await chat.api.getOrCreateConversation({
      userId: "alice",
      otherUserId: "carol",
    });
    const elsewhere = await chat.api.sendMessage({
      userId: "alice",
      conversationId: other.id,
      body: "different room",
    });

    await expect(
      chat.api.sendMessage({
        userId: "bob",
        conversationId: conversation.id,
        body: "cross-conversation quote",
        replyToMessageId: elsewhere.id,
      }),
    ).rejects.toMatchObject({ code: "MESSAGE_NOT_FOUND" });

    await expect(
      chat.api.sendMessage({
        userId: "bob",
        conversationId: conversation.id,
        body: "ghost quote",
        replyToMessageId: "nope",
      }),
    ).rejects.toMatchObject({ code: "MESSAGE_NOT_FOUND" });

    await expect(
      chat.api.sendMessage({
        userId: "bob",
        conversationId: conversation.id,
        body: "blank quote",
        replyToMessageId: "   ",
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("stays flat: a reply to a reply points at its immediate parent only", async () => {
    const chat = createChat();
    const { conversation, message } = await seed(chat);
    const first = await chat.api.sendMessage({
      userId: "bob",
      conversationId: conversation.id,
      body: "one hop",
      replyToMessageId: message.id,
    });
    const second = await chat.api.sendMessage({
      userId: "alice",
      conversationId: conversation.id,
      body: "two hops",
      replyToMessageId: first.id,
    });

    expect(second.replyTo?.id).toBe(first.id);
    // Ordering is still one flat seq axis - no thread grouping.
    const view = await chat.api.listMessages({ userId: "bob", conversationId: conversation.id });
    expect(view.messages.map((m) => m.body)).toEqual(["two hops", "one hop", "the original"]);
  });

  it("editing a reply never moves the pointer", async () => {
    const chat = createChat();
    const { conversation, message } = await seed(chat);
    const reply = await chat.api.sendMessage({
      userId: "bob",
      conversationId: conversation.id,
      body: "typo",
      replyToMessageId: message.id,
    });

    const edited = await chat.api.editMessage({
      userId: "bob",
      messageId: reply.id,
      body: "fixed",
    });
    expect(edited.replyToMessageId).toBe(message.id);
    expect(edited.replyTo?.id).toBe(message.id);
  });
});

describe("reactions", () => {
  it("adds, groups, and removes reactions idempotently", async () => {
    const chat = createChat();
    const { message } = await seed(chat);

    const once = await chat.api.addReaction({
      userId: "bob",
      messageId: message.id,
      emoji: "👍",
    });
    expect(once.reactions).toEqual([{ emoji: "👍", count: 1, userIds: ["bob"] }]);

    // Reacting again with the same key is one reaction, not two.
    const twice = await chat.api.addReaction({
      userId: "bob",
      messageId: message.id,
      emoji: "👍",
    });
    expect(twice.reactions).toEqual([{ emoji: "👍", count: 1, userIds: ["bob"] }]);

    // The other participant joining the same key groups under one summary.
    const both = await chat.api.addReaction({
      userId: "alice",
      messageId: message.id,
      emoji: "👍",
    });
    expect(both.reactions).toEqual([{ emoji: "👍", count: 2, userIds: ["bob", "alice"] }]);

    // A different key is its own bucket, appended after the first.
    const two = await chat.api.addReaction({
      userId: "bob",
      messageId: message.id,
      emoji: "🎉",
    });
    expect(two.reactions).toEqual([
      { emoji: "👍", count: 2, userIds: ["bob", "alice"] },
      { emoji: "🎉", count: 1, userIds: ["bob"] },
    ]);

    // Removing only removes the caller's own reaction...
    const removed = await chat.api.removeReaction({
      userId: "bob",
      messageId: message.id,
      emoji: "👍",
    });
    expect(removed.reactions).toEqual([
      { emoji: "👍", count: 1, userIds: ["alice"] },
      { emoji: "🎉", count: 1, userIds: ["bob"] },
    ]);

    // ...and removing a reaction that isn't there is a silent no-op.
    const again = await chat.api.removeReaction({
      userId: "bob",
      messageId: message.id,
      emoji: "👍",
    });
    expect(again.reactions).toEqual(removed.reactions);
  });

  it("persists reactions into subsequent reads", async () => {
    const chat = createChat();
    const { conversation, message } = await seed(chat);
    await chat.api.addReaction({ userId: "bob", messageId: message.id, emoji: "👍" });

    const view = await chat.api.listMessages({ userId: "alice", conversationId: conversation.id });
    expect(view.messages[0]!.reactions).toEqual([{ emoji: "👍", count: 1, userIds: ["bob"] }]);

    // A message nobody reacted to reports an empty array, never undefined.
    const plain = await chat.api.sendMessage({
      userId: "alice",
      conversationId: conversation.id,
      body: "no reactions here",
    });
    expect(plain.reactions).toEqual([]);
  });

  it("accepts any short string as a key and rejects empty or overlong ones", async () => {
    const chat = createChat();
    const { message } = await seed(chat);

    for (const emoji of ["👍", ":shipit:", "custom_1234", "x".repeat(32)]) {
      const result = await chat.api.addReaction({ userId: "bob", messageId: message.id, emoji });
      expect(result.reactions.some((r) => r.emoji === emoji)).toBe(true);
    }

    for (const emoji of ["", "   ", "x".repeat(33)]) {
      await expect(
        chat.api.addReaction({ userId: "bob", messageId: message.id, emoji }),
      ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    }

    // Trimming means "👍" and "👍 " are the same bucket, not two.
    await chat.api.addReaction({ userId: "alice", messageId: message.id, emoji: " 👍 " });
    const summary = await chat.api.addReaction({
      userId: "bob",
      messageId: message.id,
      emoji: "👍",
    });
    expect(summary.reactions.filter((r) => r.emoji === "👍")).toHaveLength(1);
  });

  it("requires write permission and an existing message", async () => {
    const chat = createChat();
    const { message } = await seed(chat);

    await expect(
      chat.api.addReaction({ userId: "mallory", messageId: message.id, emoji: "👍" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN_WRITE" });
    await expect(
      chat.api.removeReaction({ userId: "mallory", messageId: message.id, emoji: "👍" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN_WRITE" });
    await expect(
      chat.api.addReaction({ userId: "bob", messageId: "nope", emoji: "👍" }),
    ).rejects.toMatchObject({ code: "MESSAGE_NOT_FOUND" });
  });

  it("reacting to a tombstone is allowed", async () => {
    const chat = createChat();
    const { message } = await seed(chat);
    await chat.api.deleteMessage({ userId: "alice", messageId: message.id });

    const reacted = await chat.api.addReaction({
      userId: "bob",
      messageId: message.id,
      emoji: "🫡",
    });
    expect(reacted.reactions).toEqual([{ emoji: "🫡", count: 1, userIds: ["bob"] }]);
  });

  it("never touches seq, conversation ordering, or unread counts", async () => {
    const chat = createChat();
    const withBob = await chat.api.getOrCreateConversation({
      userId: "alice",
      otherUserId: "bob",
    });
    const withCarol = await chat.api.getOrCreateConversation({
      userId: "alice",
      otherUserId: "carol",
    });

    const inBob = await chat.api.sendMessage({
      userId: "alice",
      conversationId: withBob.id,
      body: "to bob",
    });
    await chat.api.sendMessage({ userId: "carol", conversationId: withCarol.id, body: "to alice" });

    const before = await chat.api.listConversations({ userId: "alice" });
    expect(before.conversations.map((c) => c.id)).toEqual([withCarol.id, withBob.id]);
    const carolUnreadBefore = before.conversations[0]!.unreadCount;

    // Bob reacts in the *older* conversation - which must not resurface it.
    const reacted = await chat.api.addReaction({
      userId: "bob",
      messageId: inBob.id,
      emoji: "👍",
    });
    expect(reacted.seq).toBe(inBob.seq);

    const after = await chat.api.listConversations({ userId: "alice" });
    expect(after.conversations.map((c) => c.id)).toEqual([withCarol.id, withBob.id]);
    expect(after.conversations[0]!.unreadCount).toBe(carolUnreadBefore);
    // Bob's reaction on alice's own message is not something alice "unread".
    expect(after.conversations[1]!.unreadCount).toBe(0);

    // A message sent after a reaction still gets the next seq.
    const next = await chat.api.sendMessage({
      userId: "alice",
      conversationId: withBob.id,
      body: "after",
    });
    expect(next.seq).toBe(inBob.seq + 1);
  });

  it("publishes a reaction event carrying the full post-change set", async () => {
    const chat = createChat();
    const { conversation, message } = await seed(chat);

    const events: unknown[] = [];
    chat.transport.subscribe((event) => events.push(event));

    await chat.api.addReaction({ userId: "bob", messageId: message.id, emoji: "👍" });
    await chat.api.removeReaction({ userId: "bob", messageId: message.id, emoji: "👍" });

    expect(events).toEqual([
      {
        type: "reaction.added",
        conversationId: conversation.id,
        recipientIds: expect.arrayContaining(["alice", "bob"]),
        actorId: "bob",
        emoji: "👍",
        message: expect.objectContaining({
          id: message.id,
          reactions: [{ emoji: "👍", count: 1, userIds: ["bob"] }],
        }),
      },
      {
        type: "reaction.removed",
        conversationId: conversation.id,
        recipientIds: expect.arrayContaining(["alice", "bob"]),
        actorId: "bob",
        emoji: "👍",
        message: expect.objectContaining({ id: message.id, reactions: [] }),
      },
    ]);
  });
});

describe("details on every message-returning surface", () => {
  it("send, edit, delete, list, and gap-fill all carry replyTo and reactions", async () => {
    const chat = createChat();
    const { conversation, message } = await seed(chat);
    const reply = await chat.api.sendMessage({
      userId: "bob",
      conversationId: conversation.id,
      body: "quoted",
      replyToMessageId: message.id,
    });
    await chat.api.addReaction({ userId: "alice", messageId: reply.id, emoji: "👍" });

    // send (already asserted above), edit, delete
    const edited = await chat.api.editMessage({
      userId: "bob",
      messageId: reply.id,
      body: "quoted (edited)",
    });
    expect(edited.replyTo?.id).toBe(message.id);
    expect(edited.reactions).toEqual([{ emoji: "👍", count: 1, userIds: ["alice"] }]);

    // Gap-fill must match live frames, or a reconnecting client would lose the
    // quote bar on replayed messages (ADR 0013 §2).
    const missed = await chat.api.listMessagesAfter({
      userId: "bob",
      conversationId: conversation.id,
      afterSeq: message.seq,
    });
    expect(missed[0]).toMatchObject({
      id: reply.id,
      replyTo: { id: message.id },
      reactions: [{ emoji: "👍", count: 1, userIds: ["alice"] }],
    });

    const deleted = await chat.api.deleteMessage({ userId: "bob", messageId: reply.id });
    expect(deleted.replyTo?.id).toBe(message.id);
    // Deleting the message leaves its reactions alone - the tombstone renders.
    expect(deleted.reactions).toEqual([{ emoji: "👍", count: 1, userIds: ["alice"] }]);

    // Deleting again is idempotent and still decorated.
    const twice = await chat.api.deleteMessage({ userId: "bob", messageId: reply.id });
    expect(twice.replyTo?.id).toBe(message.id);
  });
});

describe("reactions and replies over HTTP", () => {
  it("POST and DELETE /messages/:id/reactions return the decorated message", async () => {
    const handler = createHttpChat();
    const createRes = await send(handler, "POST", "/conversations", "alice", {
      otherUserId: "bob",
    });
    const { conversation } = (await createRes.json()) as { conversation: { id: string } };
    const sendRes = await send(
      handler,
      "POST",
      `/conversations/${conversation.id}/messages`,
      "alice",
      { body: "react to me" },
    );
    const { message } = (await sendRes.json()) as { message: { id: string } };

    const added = await send(handler, "POST", `/messages/${message.id}/reactions`, "bob", {
      emoji: "👍",
    });
    expect(added.status).toBe(200);
    expect(await added.json()).toMatchObject({
      message: { id: message.id, reactions: [{ emoji: "👍", count: 1, userIds: ["bob"] }] },
    });

    const removed = await send(handler, "DELETE", `/messages/${message.id}/reactions`, "bob", {
      emoji: "👍",
    });
    expect(removed.status).toBe(200);
    expect(await removed.json()).toMatchObject({ message: { reactions: [] } });
  });

  it("maps reaction failures onto the existing status codes", async () => {
    const handler = createHttpChat();
    const createRes = await send(handler, "POST", "/conversations", "alice", {
      otherUserId: "bob",
    });
    const { conversation } = (await createRes.json()) as { conversation: { id: string } };
    const sendRes = await send(
      handler,
      "POST",
      `/conversations/${conversation.id}/messages`,
      "alice",
      { body: "hi" },
    );
    const { message } = (await sendRes.json()) as { message: { id: string } };

    // No new error codes: 400 invalid, 401 unauthenticated, 403 forbidden, 404 unknown.
    expect(
      (await send(handler, "POST", `/messages/${message.id}/reactions`, "alice", {})).status,
    ).toBe(400);
    expect(
      (
        await send(handler, "POST", `/messages/${message.id}/reactions`, "alice", {
          emoji: "x".repeat(33),
        })
      ).status,
    ).toBe(400);
    expect(
      (await send(handler, "POST", `/messages/${message.id}/reactions`, undefined, { emoji: "👍" }))
        .status,
    ).toBe(401);
    expect(
      (await send(handler, "POST", `/messages/${message.id}/reactions`, "mallory", { emoji: "👍" }))
        .status,
    ).toBe(403);
    expect(
      (await send(handler, "POST", "/messages/nope/reactions", "alice", { emoji: "👍" })).status,
    ).toBe(404);
  });

  it("accepts replyToMessageId on send and echoes the preview", async () => {
    const handler = createHttpChat();
    const createRes = await send(handler, "POST", "/conversations", "alice", {
      otherUserId: "bob",
    });
    const { conversation } = (await createRes.json()) as { conversation: { id: string } };
    const parentRes = await send(
      handler,
      "POST",
      `/conversations/${conversation.id}/messages`,
      "alice",
      { body: "the original" },
    );
    const { message: parent } = (await parentRes.json()) as { message: { id: string } };

    const replyRes = await send(
      handler,
      "POST",
      `/conversations/${conversation.id}/messages`,
      "bob",
      { body: "quoting", replyToMessageId: parent.id },
    );
    expect(replyRes.status).toBe(201);
    expect(await replyRes.json()).toMatchObject({
      message: {
        replyToMessageId: parent.id,
        replyTo: { id: parent.id, senderId: "alice", excerpt: "the original", deleted: false },
      },
    });

    // A non-string pointer is a 400, an unknown one is a 404.
    expect(
      (
        await send(handler, "POST", `/conversations/${conversation.id}/messages`, "bob", {
          body: "bad",
          replyToMessageId: 7,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await send(handler, "POST", `/conversations/${conversation.id}/messages`, "bob", {
          body: "ghost",
          replyToMessageId: "nope",
        })
      ).status,
    ).toBe(404);
  });
});
