import { memoryAdapter } from "@chatpack/adapter-memory";
import { chatpack, type ChatpackHandler } from "@chatpack/core";
import { describe, expect, it } from "vitest";

import { createChatClient } from "../src/client";

function clientFor(handler: ChatpackHandler, userId: string) {
  return createChatClient({
    userId,
    fetch: async (input, init) => {
      const requestURL = new URL(input instanceof Request ? input.url : String(input));
      const headers = new Headers(init?.headers);
      headers.set("x-user-id", userId);
      return handler.fetch(
        new Request("http://chatpack.invalid" + requestURL.pathname + requestURL.search, {
          ...init,
          headers,
        }),
      );
    },
  });
}

function handlerFor(storage = memoryAdapter()): ChatpackHandler {
  return chatpack({
    storage,
    telemetry: false,
    auth: (request) => {
      const userId = request.headers.get("x-user-id");
      return userId === null ? null : { id: userId };
    },
  }).handler();
}

describe("mention client actions (ADR 0023)", () => {
  it("sends supplied mention ids and reads them back on the message", async () => {
    const client = clientFor(handlerFor(), "alice");
    const group = await client.conversations.createGroup({
      name: "eng",
      userIds: ["bob", "carol"],
    });
    expect(group.error).toBeNull();
    if (group.error !== null) return;

    const sent = await client.messages.send({
      conversationId: group.data.id,
      body: "@bob @carol ship it",
      mentions: ["bob", "carol"],
    });
    expect(sent).toMatchObject({ error: null, data: { mentions: ["bob", "carol"] } });

    const page = await client.messages.list({ conversationId: group.data.id });
    expect(page).toMatchObject({
      error: null,
      data: { messages: [{ mentions: ["bob", "carol"] }] },
    });
  });

  it("omits `mentions` from the PATCH body unless the caller passed it", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const client = createChatClient({
      fetch: async (input, init) => {
        if (init?.method === "PATCH" && typeof init.body === "string") {
          bodies.push(JSON.parse(init.body) as Record<string, unknown>);
        }
        return new Response(
          JSON.stringify({ message: { id: "msg_1", conversationId: "conv_1" } }),
          {
            status: 200,
          },
        );
      },
    });

    // A mentions-unaware caller must not be able to erase a stored set, so the
    // field is absent rather than sent as `[]` (ADR 0023 §3).
    await client.messages.edit({ messageId: "msg_1", body: "fixed a typo" });
    await client.messages.edit({ messageId: "msg_1", body: "cleared", mentions: [] });
    await client.messages.edit({ messageId: "msg_1", body: "named", mentions: ["bob"] });

    expect(bodies).toEqual([
      { body: "fixed a typo" },
      { body: "cleared", mentions: [] },
      { body: "named", mentions: ["bob"] },
    ]);
  });

  it("surfaces MENTION_NOT_PARTICIPANT as a structured error, not a throw", async () => {
    const client = clientFor(handlerFor(), "alice");
    const conversation = await client.conversations.create({ otherUserId: "bob" });
    expect(conversation.error).toBeNull();
    if (conversation.error !== null) return;

    const sent = await client.messages.send({
      conversationId: conversation.data.id,
      body: "@zed are you there",
      mentions: ["zed"],
    });
    expect(sent.data).toBeNull();
    expect(sent.error).toMatchObject({ code: "MENTION_NOT_PARTICIPANT" });

    // The rejected send stored nothing.
    const page = await client.messages.list({ conversationId: conversation.data.id });
    expect(page).toMatchObject({ error: null, data: { messages: [] } });
  });
});

describe("forward client action (ADR 0024)", () => {
  it("names the destination in the body and resolves with the copy", async () => {
    const handler = handlerFor();
    const alice = clientFor(handler, "alice");
    const source = await alice.conversations.create({ otherUserId: "bob" });
    const target = await alice.conversations.createGroup({ name: "eng", userIds: ["carol"] });
    expect(source.error).toBeNull();
    expect(target.error).toBeNull();
    if (source.error !== null || target.error !== null) return;

    const original = await alice.messages.send({
      conversationId: source.data.id,
      body: "the original",
    });
    expect(original.error).toBeNull();
    if (original.error !== null) return;

    const forwarded = await alice.messages.forward({
      messageId: original.data.id,
      toConversationId: target.data.id,
    });
    expect(forwarded).toMatchObject({
      error: null,
      data: {
        body: "the original",
        conversationId: target.data.id,
        senderId: "alice",
        forwardedFrom: {
          messageId: original.data.id,
          conversationId: source.data.id,
          senderId: "alice",
        },
      },
    });
    if (forwarded.error !== null) return;
    expect(forwarded.data.id).not.toBe(original.data.id);
  });

  it("sends `toConversationId` on the wire as a plain `conversationId`", async () => {
    let sentBody: unknown;
    let sentPath = "";
    const client = createChatClient({
      fetch: async (input, init) => {
        sentPath = new URL(input instanceof Request ? input.url : String(input)).pathname;
        sentBody = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
        return new Response(
          JSON.stringify({ message: { id: "msg_2", conversationId: "conv_2" } }),
          {
            status: 201,
          },
        );
      },
    });

    await client.messages.forward({
      messageId: "msg/1",
      toConversationId: "conv_2",
      role: "assistant",
      mentions: ["carol"],
      metadata: { via: "share sheet" },
    });

    // The route already names the source, so the body's `conversationId` can
    // only mean the destination - and `toConversationId` never reaches the wire.
    expect(sentPath).toBe("/api/chat/messages/msg%2F1/forward");
    expect(sentBody).toEqual({
      conversationId: "conv_2",
      role: "assistant",
      mentions: ["carol"],
      metadata: { via: "share sheet" },
    });
  });

  it("echoes the forward into the target thread and marks it recently active", async () => {
    const handler = handlerFor();
    const alice = clientFor(handler, "alice");
    const source = await alice.conversations.create({ otherUserId: "bob" });
    const target = await alice.conversations.createGroup({ name: "eng", userIds: ["carol"] });
    expect(source.error).toBeNull();
    expect(target.error).toBeNull();
    if (source.error !== null || target.error !== null) return;

    const original = await alice.messages.send({
      conversationId: source.data.id,
      body: "worth sharing",
    });
    expect(original.error).toBeNull();
    if (original.error !== null) return;

    // Load both threads so the cache has somewhere to put the echo.
    await alice.messages.list({ conversationId: source.data.id });
    await alice.messages.list({ conversationId: target.data.id });
    await alice.conversations.list();

    await alice.messages.forward({
      messageId: original.data.id,
      toConversationId: target.data.id,
    });

    const snapshot = alice.$store.getSnapshot();
    const thread = snapshot.messagesByConversation[target.data.id]?.data;
    expect(thread?.messages.map((message) => message.body)).toEqual(["worth sharing"]);
    // Sending into a conversation is what makes it recently active, and a
    // forward is a send - so the target sorts ahead of the source it came from.
    expect(
      snapshot.conversations.data?.conversations.map((conversation) => conversation.id),
    ).toEqual([target.data.id, source.data.id]);
  });

  it("surfaces a forward into a conversation you cannot write to", async () => {
    const handler = handlerFor();
    const alice = clientFor(handler, "alice");
    const carol = clientFor(handler, "carol");

    const source = await alice.conversations.create({ otherUserId: "bob" });
    const theirs = await carol.conversations.create({ otherUserId: "dave" });
    expect(source.error).toBeNull();
    expect(theirs.error).toBeNull();
    if (source.error !== null || theirs.error !== null) return;

    const original = await alice.messages.send({
      conversationId: source.data.id,
      body: "not for them",
    });
    expect(original.error).toBeNull();
    if (original.error !== null) return;

    const forwarded = await alice.messages.forward({
      messageId: original.data.id,
      toConversationId: theirs.data.id,
    });
    expect(forwarded.data).toBeNull();
    expect(forwarded.error?.code).toBe("FORBIDDEN_WRITE");
  });
});
