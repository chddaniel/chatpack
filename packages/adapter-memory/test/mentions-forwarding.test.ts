/**
 * Mentions (`docs/decisions/0023`) and message forwarding
 * (`docs/decisions/0024`), driven through the core engine on the in-memory
 * adapter, plus the new HTTP surfaces.
 *
 * The invariants worth guarding here are the ones the two ADRs bought:
 *
 * - Mentions are **ids the caller supplied**, never parsed from `body` (ADR
 *   0022), validated against membership once, and grandfathered on edit - so
 *   fixing a typo after someone leaves still works.
 * - A forward **copies** the body and freezes three provenance ids, so nothing
 *   about it re-reads the source conversation. Deleting or editing the original
 *   must not reach across the permission boundary into the copy.
 */
import { describe, expect, it } from "vitest";

import { chatpack, MAX_MENTIONS_PER_MESSAGE, type ChatpackHandler } from "@chatpack/core";
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

/** alice + bob in a DM, with one message from alice. */
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

/** alice (admin) + bob + carol in a group. */
async function seedGroup(chat: ReturnType<typeof createChat>) {
  return chat.api.createGroupConversation({
    userId: "alice",
    userIds: ["bob", "carol"],
    name: "eng",
  });
}

describe("mentions", () => {
  it("stores the supplied ids and hydrates them on every message surface", async () => {
    const chat = createChat();
    const group = await seedGroup(chat);

    const message = await chat.api.sendMessage({
      userId: "alice",
      conversationId: group.id,
      body: "hey @bob and @carol",
      mentions: ["bob", "carol"],
    });
    expect(message.mentions).toEqual(["bob", "carol"]);

    const list = await chat.api.listMessages({ userId: "bob", conversationId: group.id });
    expect(list.messages[0]!.mentions).toEqual(["bob", "carol"]);

    // Gap-fill must match live frames, or a reconnecting client would lose the
    // highlight on replayed messages.
    const missed = await chat.api.listMessagesAfter({
      userId: "bob",
      conversationId: group.id,
      afterSeq: 0,
    });
    expect(missed[0]!.mentions).toEqual(["bob", "carol"]);

    const search = await chat.api.searchMessages({ userId: "bob", query: "hey" });
    expect(search.messages[0]!.mentions).toEqual(["bob", "carol"]);

    // A message nobody was mentioned in reports an empty array, never undefined.
    const plain = await chat.api.sendMessage({
      userId: "alice",
      conversationId: group.id,
      body: "no mentions here",
    });
    expect(plain.mentions).toEqual([]);
  });

  it("never parses the body: mentions and text may legitimately disagree", async () => {
    const chat = createChat();
    const group = await seedGroup(chat);

    // "@bob" in the text with nobody supplied stores nothing (ADR 0022 - the
    // body is opaque to core), and a mention with no "@" in the text is fine.
    const written = await chat.api.sendMessage({
      userId: "alice",
      conversationId: group.id,
      body: "@bob look at this",
    });
    expect(written.mentions).toEqual([]);

    const supplied = await chat.api.sendMessage({
      userId: "alice",
      conversationId: group.id,
      body: "look at this",
      mentions: ["bob"],
    });
    expect(supplied.mentions).toEqual(["bob"]);
    expect(supplied.body).toBe("look at this");
  });

  it("de-duplicates, allows a self-mention, and reads back as a set", async () => {
    const chat = createChat();
    const group = await seedGroup(chat);

    const message = await chat.api.sendMessage({
      userId: "alice",
      conversationId: group.id,
      // "carol" twice, and alice mentioning herself - both fine.
      body: "note to self",
      mentions: ["carol", "bob", "carol", "alice"],
    });
    // Three ids, not four. Sorted by `(createdAt, userId)`, and one call stamps
    // one timestamp, so the tiebreak decides: id order, NOT the order passed.
    // That is what makes the memory adapter and a SQL `ORDER BY` agree.
    expect(message.mentions).toEqual(["alice", "bob", "carol"]);

    // A replace that keeps two of the three drops only the third - the survivors
    // are not re-inserted, so nothing is duplicated.
    const edited = await chat.api.editMessage({
      userId: "alice",
      messageId: message.id,
      body: "note to bob and carol",
      mentions: ["carol", "bob"],
    });
    expect(edited.mentions).toEqual(["bob", "carol"]);
  });

  it("rejects a mention of someone who is not a participant", async () => {
    const chat = createChat();
    const group = await seedGroup(chat);

    // Rejected, not silently dropped: a dropped mention is invisible, so the
    // sender would assume a notification went out that never did (ADR 0023 §2).
    await expect(
      chat.api.sendMessage({
        userId: "alice",
        conversationId: group.id,
        body: "hey @dave",
        mentions: ["bob", "dave"],
      }),
    ).rejects.toMatchObject({ code: "MENTION_NOT_PARTICIPANT" });

    // And nothing was written - the validation runs before the insert.
    const list = await chat.api.listMessages({ userId: "alice", conversationId: group.id });
    expect(list.messages).toHaveLength(0);
  });

  it("caps the array length and rejects malformed entries", async () => {
    const chat = createChat();
    const group = await seedGroup(chat);

    await expect(
      chat.api.sendMessage({
        userId: "alice",
        conversationId: group.id,
        body: "spam",
        // Over the limit before de-duplication, so a hostile array is refused
        // without core walking it.
        mentions: Array.from({ length: MAX_MENTIONS_PER_MESSAGE + 1 }, () => "bob"),
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });

    await expect(
      chat.api.sendMessage({
        userId: "alice",
        conversationId: group.id,
        body: "spam",
        mentions: ["bob", "  "],
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("does not touch seq, unread counts, or conversation ordering", async () => {
    const chat = createChat();
    const group = await seedGroup(chat);
    const withCarol = await chat.api.getOrCreateConversation({
      userId: "alice",
      otherUserId: "carol",
    });
    await chat.api.sendMessage({
      userId: "carol",
      conversationId: withCarol.id,
      body: "newest activity",
    });

    const before = await chat.api.listConversations({ userId: "bob" });
    const groupBefore = before.conversations.find((c) => c.id === group.id)!;

    const plain = await chat.api.sendMessage({
      userId: "alice",
      conversationId: group.id,
      body: "one",
    });
    const mentioned = await chat.api.sendMessage({
      userId: "alice",
      conversationId: group.id,
      body: "two",
      mentions: ["bob"],
    });
    // A mention is not an extra write in the seq stream.
    expect(mentioned.seq).toBe(plain.seq + 1);

    const after = await chat.api.listConversations({ userId: "bob" });
    const groupAfter = after.conversations.find((c) => c.id === group.id)!;
    // Two messages arrived, so two unread - being named in one of them does not
    // count twice (unread is per message, ADR 0009).
    expect(groupAfter.unreadCount).toBe(groupBefore.unreadCount + 2);
  });

  describe("editing", () => {
    it("leaves the stored set alone when `mentions` is omitted", async () => {
      const chat = createChat();
      const group = await seedGroup(chat);
      const message = await chat.api.sendMessage({
        userId: "alice",
        conversationId: group.id,
        body: "hey @bob",
        mentions: ["bob"],
      });

      // A mentions-unaware client edits the body and sends nothing else. Erasing
      // the mentions here would silently un-notify bob (ADR 0023 §3).
      const edited = await chat.api.editMessage({
        userId: "alice",
        messageId: message.id,
        body: "hey @bob (typo fixed)",
      });
      expect(edited.mentions).toEqual(["bob"]);
    });

    it("replaces the set when `mentions` is passed, and clears it with []", async () => {
      const chat = createChat();
      const group = await seedGroup(chat);
      const message = await chat.api.sendMessage({
        userId: "alice",
        conversationId: group.id,
        body: "hey @bob",
        mentions: ["bob"],
      });

      const swapped = await chat.api.editMessage({
        userId: "alice",
        messageId: message.id,
        body: "hey @carol",
        mentions: ["carol"],
      });
      // A replace, not an accumulate: bob is gone.
      expect(swapped.mentions).toEqual(["carol"]);

      const cleared = await chat.api.editMessage({
        userId: "alice",
        messageId: message.id,
        body: "never mind",
        mentions: [],
      });
      expect(cleared.mentions).toEqual([]);

      // And the clear is durable, not just the returned shape.
      const list = await chat.api.listMessages({ userId: "alice", conversationId: group.id });
      expect(list.messages[0]!.mentions).toEqual([]);
    });

    it("grandfathers a stored mention of someone who has since left", async () => {
      const chat = createChat();
      const group = await seedGroup(chat);
      const message = await chat.api.sendMessage({
        userId: "alice",
        conversationId: group.id,
        body: "hey @carol",
        mentions: ["carol"],
      });

      await chat.api.removeParticipant({
        userId: "alice",
        conversationId: group.id,
        targetUserId: "carol",
      });

      // Re-validating from scratch would make this edit impossible: the mention
      // was valid when it was made, and the only alternative is dropping it
      // (ADR 0023 §3).
      const edited = await chat.api.editMessage({
        userId: "alice",
        messageId: message.id,
        body: "hey @carol (typo fixed)",
        mentions: ["carol"],
      });
      expect(edited.mentions).toEqual(["carol"]);

      // Only ids *already stored* are exempt. A brand-new mention of a
      // non-participant is still refused.
      await expect(
        chat.api.editMessage({
          userId: "alice",
          messageId: message.id,
          body: "hey @carol @dave",
          mentions: ["carol", "dave"],
        }),
      ).rejects.toMatchObject({ code: "MENTION_NOT_PARTICIPANT" });
    });
  });

  it("reports mentions to both message hooks, including on delete", async () => {
    const before: { action: string; mentions: string[] }[] = [];
    const after: { action: string; mentions: string[]; recipientIds: string[] }[] = [];
    const chat = createChat({
      hooks: {
        beforeMessageSend: (ctx) => {
          before.push({ action: ctx.action, mentions: ctx.mentions });
        },
        afterMessageMutation: (ctx) => {
          after.push({
            action: ctx.action,
            mentions: ctx.mentions,
            recipientIds: ctx.recipientIds,
          });
        },
      },
    });
    const group = await seedGroup(chat);

    const message = await chat.api.sendMessage({
      userId: "alice",
      conversationId: group.id,
      body: "hey @bob",
      mentions: ["bob"],
    });
    await chat.api.editMessage({ userId: "alice", messageId: message.id, body: "hey @bob!" });
    await chat.api.deleteMessage({ userId: "alice", messageId: message.id });

    // The before hook sees the final validated set, not the raw input.
    expect(before).toEqual([
      { action: "send", mentions: ["bob"] },
      { action: "edit", mentions: ["bob"] },
    ]);
    // `mentions` next to `recipientIds` is the whole point: a push integration
    // can tell "everyone in the room" from "the person actually named".
    expect(after).toEqual([
      { action: "send", mentions: ["bob"], recipientIds: ["bob", "carol"] },
      { action: "edit", mentions: ["bob"], recipientIds: ["bob", "carol"] },
      // Mention rows survive a delete, like reactions - the tombstone renders.
      { action: "delete", mentions: ["bob"], recipientIds: ["bob", "carol"] },
    ]);
  });

  it("accepts mentions over HTTP on send and edit, and 400s a non-participant", async () => {
    const handler = createHttpChat();
    const groupRes = await send(handler, "POST", "/conversations/group", "alice", {
      userIds: ["bob"],
      name: "eng",
    });
    const { conversation } = (await groupRes.json()) as { conversation: { id: string } };

    const sendRes = await send(
      handler,
      "POST",
      `/conversations/${conversation.id}/messages`,
      "alice",
      { body: "hey @bob", mentions: ["bob"] },
    );
    expect(sendRes.status).toBe(201);
    const { message } = (await sendRes.json()) as { message: { id: string; mentions: string[] } };
    expect(message.mentions).toEqual(["bob"]);

    const editRes = await send(handler, "PATCH", `/messages/${message.id}`, "alice", {
      body: "hey @bob!",
      mentions: [],
    });
    expect(editRes.status).toBe(200);
    expect(await editRes.json()).toMatchObject({ message: { mentions: [] } });

    const badRes = await send(
      handler,
      "POST",
      `/conversations/${conversation.id}/messages`,
      "alice",
      { body: "hey @dave", mentions: ["dave"] },
    );
    // 400, not 403: the request itself is malformed - it named someone who is
    // not in the room.
    expect(badRes.status).toBe(400);
    expect(await badRes.json()).toMatchObject({
      error: { code: "MENTION_NOT_PARTICIPANT" },
    });

    const shapeRes = await send(
      handler,
      "POST",
      `/conversations/${conversation.id}/messages`,
      "alice",
      { body: "hi", mentions: "bob" },
    );
    expect(shapeRes.status).toBe(400);
    expect(await shapeRes.json()).toMatchObject({ error: { code: "INVALID_INPUT" } });
  });
});

describe("message forwarding", () => {
  /** alice+bob DM with a message, plus an alice+carol DM to forward it into. */
  async function seedForward(chat: ReturnType<typeof createChat>) {
    const { conversation: source, message } = await seed(chat);
    const target = await chat.api.getOrCreateConversation({
      userId: "alice",
      otherUserId: "carol",
    });
    return { source, target, message };
  }

  it("copies the body into the target and freezes three provenance ids", async () => {
    const chat = createChat();
    const { source, target, message } = await seedForward(chat);

    const forwarded = await chat.api.forwardMessage({
      userId: "alice",
      messageId: message.id,
      toConversationId: target.id,
    });

    expect(forwarded.conversationId).toBe(target.id);
    expect(forwarded.body).toBe("the original");
    // The forwarder is the sender; the source's sender survives only inside the
    // provenance object (ADR 0024 §4).
    expect(forwarded.senderId).toBe("alice");
    expect(forwarded.forwardedFrom).toEqual({
      messageId: message.id,
      conversationId: source.id,
      senderId: "alice",
    });
    // A real message in the target: its own id and its own seq.
    expect(forwarded.id).not.toBe(message.id);
    expect(forwarded.seq).toBe(1);

    // Provenance is stored, so it is on every read - not a per-request
    // hydration like `replyTo`.
    const list = await chat.api.listMessages({ userId: "carol", conversationId: target.id });
    expect(list.messages[0]!.forwardedFrom).toEqual({
      messageId: message.id,
      conversationId: source.id,
      senderId: "alice",
    });
    // An ordinary message reports null, never undefined.
    const plain = await chat.api.sendMessage({
      userId: "carol",
      conversationId: target.id,
      body: "not a forward",
    });
    expect(plain.forwardedFrom).toBeNull();
  });

  it("is independent of the source: editing or deleting the original changes nothing", async () => {
    const chat = createChat();
    const { target, message } = await seedForward(chat);
    const forwarded = await chat.api.forwardMessage({
      userId: "alice",
      messageId: message.id,
      toConversationId: target.id,
    });

    await chat.api.editMessage({
      userId: "alice",
      messageId: message.id,
      body: "rewritten after the fact",
    });
    await chat.api.deleteMessage({ userId: "alice", messageId: message.id });

    // Nothing is re-read, so there is no live field to change. A hydrated
    // excerpt here would have let carol watch a conversation she cannot read
    // (ADR 0024 §2).
    const list = await chat.api.listMessages({ userId: "carol", conversationId: target.id });
    expect(list.messages[0]).toMatchObject({
      id: forwarded.id,
      body: "the original",
      deletedAt: null,
      forwardedFrom: { messageId: message.id },
    });
  });

  it("checks read on the source and write on the target", async () => {
    const chat = createChat();
    const { source, target, message } = await seedForward(chat);

    // carol cannot read the alice+bob DM, so she cannot forward out of it - and
    // the error is the one a direct fetch would have given, so a message id
    // cannot be used to probe what exists elsewhere.
    await expect(
      chat.api.forwardMessage({
        userId: "carol",
        messageId: message.id,
        toConversationId: target.id,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN_READ" });

    // bob can read the source but cannot write to alice+carol.
    await expect(
      chat.api.forwardMessage({
        userId: "bob",
        messageId: message.id,
        toConversationId: target.id,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN_WRITE" });

    await expect(
      chat.api.forwardMessage({
        userId: "alice",
        messageId: "msg_nope",
        toConversationId: target.id,
      }),
    ).rejects.toMatchObject({ code: "MESSAGE_NOT_FOUND" });

    await expect(
      chat.api.forwardMessage({
        userId: "alice",
        messageId: message.id,
        toConversationId: "conv_nope",
      }),
    ).rejects.toMatchObject({ code: "CONVERSATION_NOT_FOUND" });

    // Forwarding back into the source conversation is allowed - nothing special
    // happens, it is a message like any other.
    const samePlace = await chat.api.forwardMessage({
      userId: "alice",
      messageId: message.id,
      toConversationId: source.id,
    });
    expect(samePlace.conversationId).toBe(source.id);
  });

  it("refuses to forward a tombstone", async () => {
    const chat = createChat();
    const { target, message } = await seedForward(chat);
    await chat.api.deleteMessage({ userId: "alice", messageId: message.id });

    // Replying to a deleted message is allowed because the pointer still means
    // something; a forward's whole payload is the copied body (ADR 0024 §3).
    await expect(
      chat.api.forwardMessage({
        userId: "alice",
        messageId: message.id,
        toConversationId: target.id,
      }),
    ).rejects.toMatchObject({ code: "MESSAGE_DELETED" });
  });

  it("leaves reactions, replies, mentions, and metadata behind", async () => {
    const chat = createChat();
    const group = await seedGroup(chat);
    const target = await chat.api.getOrCreateConversation({
      userId: "alice",
      otherUserId: "dave",
    });

    const parent = await chat.api.sendMessage({
      userId: "alice",
      conversationId: group.id,
      body: "parent",
    });
    const source = await chat.api.sendMessage({
      userId: "alice",
      conversationId: group.id,
      body: "quoted, reacted, and mentioned",
      replyToMessageId: parent.id,
      mentions: ["bob"],
      metadata: { attachmentKey: "private/s3/key" },
      role: "assistant",
    });
    await chat.api.addReaction({ userId: "bob", messageId: source.id, emoji: "👍" });

    const forwarded = await chat.api.forwardMessage({
      userId: "alice",
      messageId: source.id,
      toConversationId: target.id,
    });

    // Every one of these would have named a group member, or leaked a key, to
    // dave - who was never in that room (ADR 0024 §6).
    expect(forwarded.reactions).toEqual([]);
    expect(forwarded.replyToMessageId).toBeNull();
    expect(forwarded.replyTo).toBeNull();
    expect(forwarded.mentions).toEqual([]);
    expect(forwarded.metadata).toEqual({});
    // The source's role is not copied either: a forwarded "assistant" would
    // render as though the AI had spoken in a room it was never in.
    expect(forwarded.role).toBe("user");
  });

  it("accepts a fresh mention set, validated against the target", async () => {
    const chat = createChat();
    const group = await seedGroup(chat);
    const { message } = await seed(chat);

    const forwarded = await chat.api.forwardMessage({
      userId: "alice",
      messageId: message.id,
      toConversationId: group.id,
      mentions: ["carol"],
      metadata: { forwardedBy: "alice" },
      role: "system",
    });
    expect(forwarded.mentions).toEqual(["carol"]);
    expect(forwarded.metadata).toEqual({ forwardedBy: "alice" });
    expect(forwarded.role).toBe("system");

    // "dave" is in neither conversation; the check is against the target.
    await expect(
      chat.api.forwardMessage({
        userId: "alice",
        messageId: message.id,
        toConversationId: group.id,
        mentions: ["dave"],
      }),
    ).rejects.toMatchObject({ code: "MENTION_NOT_PARTICIPANT" });
  });

  it("is one hop: forwarding a forward points at what it was forwarded from", async () => {
    const chat = createChat();
    const { source, target, message } = await seedForward(chat);
    const third = await chat.api.createGroupConversation({
      userId: "alice",
      userIds: ["carol"],
      name: "third",
    });

    const once = await chat.api.forwardMessage({
      userId: "alice",
      messageId: message.id,
      toConversationId: target.id,
    });
    const twice = await chat.api.forwardMessage({
      userId: "alice",
      messageId: once.id,
      toConversationId: third.id,
    });

    // Provenance names the immediate source, not the original origin - the same
    // flatness rule replies follow. Core does not walk chains.
    expect(twice.forwardedFrom).toEqual({
      messageId: once.id,
      conversationId: target.id,
      senderId: "alice",
    });
    expect(once.forwardedFrom?.conversationId).toBe(source.id);
  });

  it('runs beforeMessageSend with action "send" and the provenance attached', async () => {
    const seen: { action: string; body: string; forwardedFrom: unknown }[] = [];
    const chat = createChat({
      hooks: {
        beforeMessageSend: (ctx) => {
          seen.push({ action: ctx.action, body: ctx.body, forwardedFrom: ctx.forwardedFrom });
          // A host that wants to treat forwards differently branches on
          // `forwardedFrom`, which is the whole reason it is on the context.
          if (ctx.forwardedFrom !== null && ctx.body.includes("secret")) {
            throw new Error("Not forwardable.");
          }
        },
      },
    });
    const { target, message } = await seedForward(chat);

    await chat.api.forwardMessage({
      userId: "alice",
      messageId: message.id,
      toConversationId: target.id,
    });

    // `"send"`, not a third `"forward"` action: a host filtering on "send" must
    // keep covering forwards, and a new member would have silently exempted
    // every existing filter (ADR 0024 §5).
    expect(seen.at(-1)).toEqual({
      action: "send",
      body: "the original",
      forwardedFrom: {
        messageId: message.id,
        conversationId: message.conversationId,
        senderId: "alice",
      },
    });

    // Forwarding is not a route around the content rules: the hook runs, and
    // refusing it fails the whole call before anything is written.
    const secret = await chat.api.sendMessage({
      userId: "alice",
      conversationId: message.conversationId,
      body: "the secret plan",
    });
    await expect(
      chat.api.forwardMessage({
        userId: "alice",
        messageId: secret.id,
        toConversationId: target.id,
      }),
    ).rejects.toMatchObject({ code: "MESSAGE_REJECTED", message: "Not forwardable." });

    const list = await chat.api.listMessages({ userId: "carol", conversationId: target.id });
    expect(list.messages.map((entry) => entry.body)).toEqual(["the original"]);
  });

  it("publishes message.created to the target only, and never to the source", async () => {
    const chat = createChat();
    const { source, target, message } = await seedForward(chat);

    const events: { type: string; conversationId: string }[] = [];
    chat.transport.subscribe((event) => {
      if ("conversationId" in event && typeof event.conversationId === "string") {
        events.push({ type: event.type, conversationId: event.conversationId });
      }
    });

    await chat.api.forwardMessage({
      userId: "alice",
      messageId: message.id,
      toConversationId: target.id,
    });

    // Being forwarded is not an event the source can act on, and telling it
    // would leak that the target exists.
    expect(events).toEqual([{ type: "message.created", conversationId: target.id }]);
    expect(events.some((event) => event.conversationId === source.id)).toBe(false);

    // It is an ordinary message in the target: carol has one unread.
    const carolView = await chat.api.listConversations({ userId: "carol" });
    expect(carolView.conversations.find((c) => c.id === target.id)!.unreadCount).toBe(1);
  });

  it("forwards over HTTP and returns the new message", async () => {
    const handler = createHttpChat();
    const sourceRes = await send(handler, "POST", "/conversations", "alice", {
      otherUserId: "bob",
    });
    const { conversation: source } = (await sourceRes.json()) as {
      conversation: { id: string };
    };
    const targetRes = await send(handler, "POST", "/conversations", "alice", {
      otherUserId: "carol",
    });
    const { conversation: target } = (await targetRes.json()) as {
      conversation: { id: string };
    };
    const sendRes = await send(handler, "POST", `/conversations/${source.id}/messages`, "alice", {
      body: "forward me",
    });
    const { message } = (await sendRes.json()) as { message: { id: string } };

    const forwardRes = await send(handler, "POST", `/messages/${message.id}/forward`, "alice", {
      conversationId: target.id,
    });
    // 201, like a send: this created a message.
    expect(forwardRes.status).toBe(201);
    expect(await forwardRes.json()).toMatchObject({
      message: {
        conversationId: target.id,
        body: "forward me",
        senderId: "alice",
        forwardedFrom: { messageId: message.id, conversationId: source.id, senderId: "alice" },
      },
    });

    // The destination is required, and it is named `conversationId` in the body
    // because the path already names the source.
    const missing = await send(handler, "POST", `/messages/${message.id}/forward`, "alice", {});
    expect(missing.status).toBe(400);
    expect(await missing.json()).toMatchObject({ error: { code: "INVALID_INPUT" } });

    const unauthenticated = await send(
      handler,
      "POST",
      `/messages/${message.id}/forward`,
      undefined,
      { conversationId: target.id },
    );
    expect(unauthenticated.status).toBe(401);
  });
});
