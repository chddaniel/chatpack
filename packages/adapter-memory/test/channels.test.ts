/**
 * Public channels (`docs/decisions/0020`), driven through the core engine on the
 * in-memory adapter, plus the two new HTTP routes.
 *
 * The invariants worth guarding are the ones the ADR bought with its design:
 * the directory lists public groups and nothing else, a preview never names a
 * member, an open channel admits instantly while an approval channel queues,
 * reading still requires joining, `visibility` cannot be set at all on an
 * adapter without the capability (the silent-downgrade failure the namespace
 * exists to prevent), and flipping the two fields needs admin authority rather
 * than invite authority.
 */
import { describe, expect, it } from "vitest";

import {
  chatpack,
  MAX_GROUP_PARTICIPANTS,
  type ChatpackHandler,
  type ConversationEvent,
  type PermissionContext,
  type StorageAdapter,
  type TransportEvent,
} from "@chatpack/core";
import { memoryAdapter } from "../src/index";

const BASE = "http://test.local/api/chat";

function createChat(options: Partial<Parameters<typeof chatpack>[0]> = {}) {
  return chatpack({ storage: memoryAdapter(), telemetry: false, ...options });
}

function createRecordingChat(options: Partial<Parameters<typeof chatpack>[0]> = {}) {
  const events: TransportEvent[] = [];
  const chat = createChat(options);
  chat.transport.subscribe((event) => events.push(event));
  return { chat, events };
}

function conversationEvents(events: TransportEvent[]): ConversationEvent[] {
  return events.filter((event): event is ConversationEvent => "affectedUserIds" in event);
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

function get(handler: ChatpackHandler, path: string, userId?: string): Promise<Response> {
  return handler.GET(
    new Request(`${BASE}${path}`, { headers: userId ? { "x-user-id": userId } : {} }),
  );
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

/** A public channel owned by alice, open to anyone unless told otherwise. */
async function seedChannel(
  chat: ReturnType<typeof createChat>,
  overrides: Partial<
    Parameters<ReturnType<typeof createChat>["api"]["createGroupConversation"]>[0]
  > = {},
) {
  return chat.api.createGroupConversation({
    userId: "alice",
    name: "General",
    visibility: "public",
    joinPolicy: "open",
    ...overrides,
  });
}

/** An adapter that never gained the ADR 0020 capability. */
function adapterWithoutChannels(): StorageAdapter {
  const { channels: _channels, ...rest } = memoryAdapter();
  return rest;
}

/** Channels but no invites: the combination an all-`open` directory can run on. */
function adapterWithoutInvites(): StorageAdapter {
  const { invites: _invites, ...rest } = memoryAdapter();
  return rest;
}

describe("visibility and joinPolicy on conversations", () => {
  it("defaults every conversation to private and approval", async () => {
    const chat = createChat();

    const dm = await chat.api.getOrCreateConversation({ userId: "alice", otherUserId: "bob" });
    const group = await chat.api.createGroupConversation({ userId: "alice", name: "Standup" });

    for (const conversation of [dm, group]) {
      expect(conversation.visibility).toBe("private");
      expect(conversation.joinPolicy).toBe("approval");
    }
  });

  it("defaults a public channel to approval, the recoverable option", async () => {
    const chat = createChat();

    const channel = await chat.api.createGroupConversation({
      userId: "alice",
      name: "General",
      visibility: "public",
    });

    // A developer who sets visibility without reading further gets a queue, not
    // a room full of strangers (ADR 0020 §3).
    expect(channel.joinPolicy).toBe("approval");
  });

  it("rejects values outside the two unions", async () => {
    const chat = createChat();

    await expect(
      chat.api.createGroupConversation({
        userId: "alice",
        // @ts-expect-error - deliberately outside ChannelVisibility
        visibility: "unlisted",
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });

    await expect(
      chat.api.createGroupConversation({
        userId: "alice",
        // @ts-expect-error - deliberately outside ChannelJoinPolicy
        joinPolicy: "instant",
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("flips a private group into a channel and back", async () => {
    const chat = createChat();
    const group = await chat.api.createGroupConversation({ userId: "alice", name: "Standup" });

    const opened = await chat.api.updateConversation({
      userId: "alice",
      conversationId: group.id,
      visibility: "public",
      joinPolicy: "open",
    });
    expect(opened).toMatchObject({ visibility: "public", joinPolicy: "open" });

    const closed = await chat.api.updateConversation({
      userId: "alice",
      conversationId: group.id,
      visibility: "private",
    });
    // Only visibility was named, so joinPolicy keeps its value - the fields are
    // independent, and an omitted one is not a reset.
    expect(closed).toMatchObject({ visibility: "private", joinPolicy: "open" });
  });

  it("keeps the name when only visibility changes, and vice versa", async () => {
    const chat = createChat();
    const group = await chat.api.createGroupConversation({ userId: "alice", name: "Standup" });

    const published = await chat.api.updateConversation({
      userId: "alice",
      conversationId: group.id,
      visibility: "public",
    });
    expect(published.name).toBe("Standup");

    const renamed = await chat.api.updateConversation({
      userId: "alice",
      conversationId: group.id,
      name: "Daily",
    });
    expect(renamed).toMatchObject({ name: "Daily", visibility: "public" });
  });

  it("rejects an update that changes nothing", async () => {
    const chat = createChat();
    const group = await chat.api.createGroupConversation({ userId: "alice", name: "Standup" });

    await expect(
      chat.api.updateConversation({ userId: "alice", conversationId: group.id }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("refuses to publish a DM", async () => {
    const chat = createChat();
    const dm = await chat.api.getOrCreateConversation({ userId: "alice", otherUserId: "bob" });

    await expect(
      chat.api.updateConversation({
        userId: "alice",
        conversationId: dm.id,
        visibility: "public",
      }),
    ).rejects.toMatchObject({ code: "NOT_GROUP_CONVERSATION" });
  });

  it("requires manage authority to publish, not invite authority", async () => {
    // `canInvite` loosened to every member (the ADR 0019 §8 recipe) must not
    // also let a member expose the group to every user (ADR 0020 §5).
    const chat = createChat({
      permissions: {
        canInvite: (ctx: PermissionContext) =>
          ctx.conversation.participants.some((p) => p.userId === ctx.user.id),
      },
    });
    const group = await chat.api.createGroupConversation({
      userId: "alice",
      userIds: ["bob"],
      name: "Standup",
    });

    await expect(
      chat.api.createInvite({ userId: "bob", conversationId: group.id }),
    ).resolves.toMatchObject({ conversationId: group.id });

    await expect(
      chat.api.updateConversation({
        userId: "bob",
        conversationId: group.id,
        visibility: "public",
      }),
    ).rejects.toMatchObject({ code: "NOT_CONVERSATION_ADMIN" });
  });

  it("publishes conversation.updated to members when the flip happens", async () => {
    const { chat, events } = createRecordingChat();
    const group = await chat.api.createGroupConversation({
      userId: "alice",
      userIds: ["bob"],
      name: "Standup",
    });

    await chat.api.updateConversation({
      userId: "alice",
      conversationId: group.id,
      visibility: "public",
    });

    // The existing rename event, reused: no new TransportEvent member, and the
    // full post-change conversation rides along (ADR 0020 §6).
    const updated = conversationEvents(events).filter((e) => e.type === "conversation.updated");
    expect(updated).toHaveLength(1);
    expect(updated[0]).toMatchObject({
      actorId: "alice",
      affectedUserIds: [],
      recipientIds: expect.arrayContaining(["alice", "bob"]),
    });
    expect(updated[0]!.conversation.visibility).toBe("public");
  });
});

describe("browsing the directory", () => {
  it("lists public groups and excludes private groups and DMs", async () => {
    const chat = createChat();
    const channel = await seedChannel(chat);
    await chat.api.createGroupConversation({ userId: "alice", name: "Private" });
    await chat.api.getOrCreateConversation({ userId: "alice", otherUserId: "bob" });

    const { channels } = await chat.api.listPublicConversations({ userId: "carol" });

    expect(channels).toHaveLength(1);
    expect(channels[0]!.conversationId).toBe(channel.id);
  });

  it("returns a preview, never the participant list", async () => {
    const chat = createChat();
    const channel = await seedChannel(chat, {
      userIds: ["bob"],
      metadata: { topic: "Anything goes" },
    });

    const { channels } = await chat.api.listPublicConversations({ userId: "carol" });

    expect(channels[0]).toEqual({
      conversationId: channel.id,
      name: "General",
      participantCount: 2,
      joinPolicy: "open",
      createdAt: expect.any(Date),
      metadata: { topic: "Anything goes" },
      alreadyParticipant: false,
      requestPending: false,
    });
    // The whole point of the preview shape: no ids for anyone browsing.
    expect(JSON.stringify(channels[0])).not.toContain("bob");
  });

  it("marks the caller's own channels and pending requests", async () => {
    const chat = createChat();
    const mine = await seedChannel(chat, { name: "Mine" });
    const gated = await seedChannel(chat, { name: "Gated", joinPolicy: "approval" });

    await chat.api.joinConversation({ userId: "carol", conversationId: gated.id });

    const { channels } = await chat.api.listPublicConversations({ userId: "carol" });
    const byId = new Map(channels.map((c) => [c.conversationId, c]));

    expect(byId.get(gated.id)).toMatchObject({
      alreadyParticipant: false,
      requestPending: true,
    });
    expect(byId.get(mine.id)).toMatchObject({
      alreadyParticipant: false,
      requestPending: false,
    });

    await chat.api.joinConversation({ userId: "carol", conversationId: mine.id });
    const after = await chat.api.listPublicConversations({ userId: "carol" });
    expect(after.channels.find((c) => c.conversationId === mine.id)).toMatchObject({
      alreadyParticipant: true,
    });
  });

  it("orders most-recently-active first and pages with a cursor", async () => {
    const chat = createChat();
    const first = await seedChannel(chat, { name: "First" });
    const second = await seedChannel(chat, { name: "Second" });
    const third = await seedChannel(chat, { name: "Third" });

    // Activity, not creation order: the quietest channel sinks.
    await chat.api.sendMessage({ userId: "alice", conversationId: first.id, body: "hi" });

    const page1 = await chat.api.listPublicConversations({ userId: "carol", limit: 2 });
    expect(page1.channels.map((c) => c.name)).toEqual(["First", "Third"]);
    expect(page1.nextCursor).not.toBeNull();

    const page2 = await chat.api.listPublicConversations({
      userId: "carol",
      limit: 2,
      cursor: page1.nextCursor!,
    });
    expect(page2.channels.map((c) => c.conversationId)).toEqual([second.id]);
    expect(page2.nextCursor).toBeNull();
  });

  it("works on an adapter with channels but no invites", async () => {
    // Nothing can be pending without the queue, which is the truth for this
    // adapter rather than a missing field.
    const chat = chatpack({ storage: adapterWithoutInvites(), telemetry: false });
    await seedChannel(chat);

    const { channels } = await chat.api.listPublicConversations({ userId: "carol" });
    expect(channels[0]).toMatchObject({ requestPending: false });
  });

  it("does not let browsing read messages", async () => {
    const chat = createChat();
    const channel = await seedChannel(chat);
    await chat.api.sendMessage({ userId: "alice", conversationId: channel.id, body: "secret" });

    // Discovery only (ADR 0020 §2): the permission layer is untouched, so
    // `canRead` is still a membership test.
    await expect(
      chat.api.listMessages({ userId: "carol", conversationId: channel.id }),
    ).rejects.toMatchObject({ code: "FORBIDDEN_READ" });
    await expect(
      chat.api.getConversation({ userId: "carol", conversationId: channel.id }),
    ).rejects.toMatchObject({ code: "FORBIDDEN_READ" });
  });
});

describe("joining an open channel", () => {
  it("admits the caller immediately and returns the conversation", async () => {
    const chat = createChat();
    const channel = await seedChannel(chat);

    const result = await chat.api.joinConversation({ userId: "carol", conversationId: channel.id });

    expect(result.status).toBe("joined");
    expect(result.joinRequest).toBeNull();
    expect(result.conversation!.participants.map((p) => p.userId)).toContain("carol");
    // A joiner is a member, not an admin - nobody promoted them.
    expect(result.conversation!.participants.find((p) => p.userId === "carol")!.role).toBe(
      "member",
    );
  });

  it("lets the new member read and write straight away", async () => {
    const chat = createChat();
    const channel = await seedChannel(chat);
    await chat.api.sendMessage({ userId: "alice", conversationId: channel.id, body: "welcome" });

    await chat.api.joinConversation({ userId: "carol", conversationId: channel.id });

    const { messages } = await chat.api.listMessages({
      userId: "carol",
      conversationId: channel.id,
    });
    expect(messages.map((m) => m.body)).toEqual(["welcome"]);
    await expect(
      chat.api.sendMessage({ userId: "carol", conversationId: channel.id, body: "hello" }),
    ).resolves.toMatchObject({ body: "hello" });
  });

  it("publishes participant.added, the same event an admin add does", async () => {
    const { chat, events } = createRecordingChat();
    const channel = await seedChannel(chat);

    await chat.api.joinConversation({ userId: "carol", conversationId: channel.id });

    const added = conversationEvents(events).filter((e) => e.type === "participant.added");
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({
      conversationId: channel.id,
      // The joiner is their own actor: nobody vouched for them, the channel
      // being public is the authorization.
      actorId: "carol",
      affectedUserIds: ["carol"],
      recipientIds: expect.arrayContaining(["alice", "carol"]),
    });
  });

  it("rejects a second join with ALREADY_PARTICIPANT", async () => {
    const chat = createChat();
    const channel = await seedChannel(chat);
    await chat.api.joinConversation({ userId: "carol", conversationId: channel.id });

    await expect(
      chat.api.joinConversation({ userId: "carol", conversationId: channel.id }),
    ).rejects.toMatchObject({ code: "ALREADY_PARTICIPANT" });
  });

  it("refuses a private group and a DM without confirming either exists twice", async () => {
    const chat = createChat();
    const group = await chat.api.createGroupConversation({ userId: "alice", name: "Private" });
    const dm = await chat.api.getOrCreateConversation({ userId: "alice", otherUserId: "bob" });

    await expect(
      chat.api.joinConversation({ userId: "carol", conversationId: group.id }),
    ).rejects.toMatchObject({ code: "NOT_PUBLIC_CONVERSATION" });
    // A DM gets the more specific error - it is not a room that could ever open.
    await expect(
      chat.api.joinConversation({ userId: "carol", conversationId: dm.id }),
    ).rejects.toMatchObject({ code: "NOT_GROUP_CONVERSATION" });
    await expect(
      chat.api.joinConversation({ userId: "carol", conversationId: "conv_nope" }),
    ).rejects.toMatchObject({ code: "CONVERSATION_NOT_FOUND" });
  });

  it("enforces the group participant cap", async () => {
    const chat = createChat();
    const channel = await seedChannel(chat, {
      // Fill it to the brim: creator + (cap - 1) seeded members.
      userIds: Array.from({ length: MAX_GROUP_PARTICIPANTS - 1 }, (_, i) => `member_${i}`),
    });

    await expect(
      chat.api.joinConversation({ userId: "carol", conversationId: channel.id }),
    ).rejects.toMatchObject({ code: "GROUP_LIMIT_EXCEEDED" });
  });
});

describe("joining an approval channel", () => {
  it("queues a pending request instead of admitting", async () => {
    const chat = createChat();
    const channel = await seedChannel(chat, { joinPolicy: "approval" });

    const result = await chat.api.joinConversation({
      userId: "carol",
      conversationId: channel.id,
      message: "I'm on the design team",
    });

    expect(result.status).toBe("pending");
    expect(result.conversation).toBeNull();
    expect(result.joinRequest).toMatchObject({
      conversationId: channel.id,
      userId: "carol",
      status: "pending",
      message: "I'm on the design team",
      // No invite was presented - the channel's own policy sent them here,
      // which is what tells an admin "found us in the directory".
      inviteCode: null,
    });
  });

  it("returns the same request when asked twice", async () => {
    const chat = createChat();
    const channel = await seedChannel(chat, { joinPolicy: "approval" });

    const first = await chat.api.joinConversation({
      userId: "carol",
      conversationId: channel.id,
      message: "first",
    });
    const second = await chat.api.joinConversation({
      userId: "carol",
      conversationId: channel.id,
      message: "second",
    });

    // Idempotent, and it stops a client bumping itself up a newest-first queue.
    expect(second.joinRequest!.id).toBe(first.joinRequest!.id);
    expect(second.joinRequest!.message).toBe("first");
  });

  it("lands in the same moderation queue an admin already reads", async () => {
    const chat = createChat();
    const channel = await seedChannel(chat, { joinPolicy: "approval" });
    await chat.api.joinConversation({ userId: "carol", conversationId: channel.id });

    const queue = await chat.api.listJoinRequests({
      userId: "alice",
      conversationId: channel.id,
    });
    expect(queue.map((r) => r.userId)).toEqual(["carol"]);

    const resolved = await chat.api.resolveJoinRequest({
      userId: "alice",
      conversationId: channel.id,
      targetUserId: "carol",
      decision: "approve",
    });
    expect(resolved.conversation!.participants.map((p) => p.userId)).toContain("carol");
  });

  it("reports INVITES_UNSUPPORTED when the queue has nowhere to live", async () => {
    const chat = chatpack({ storage: adapterWithoutInvites(), telemetry: false });
    const open = await seedChannel(chat);
    const gated = await seedChannel(chat, { name: "Gated", joinPolicy: "approval" });

    // An open channel needs no queue, so it still works...
    await expect(
      chat.api.joinConversation({ userId: "carol", conversationId: open.id }),
    ).resolves.toMatchObject({ status: "joined" });
    // ...and an approval channel says which capability is missing.
    await expect(
      chat.api.joinConversation({ userId: "carol", conversationId: gated.id }),
    ).rejects.toMatchObject({ code: "INVITES_UNSUPPORTED" });
  });

  it("honors a pending request that predates a policy flip", async () => {
    const chat = createChat();
    const channel = await seedChannel(chat, { joinPolicy: "approval" });
    await chat.api.joinConversation({ userId: "carol", conversationId: channel.id });

    // Opening the channel does not drain the queue - carol asked, and asking
    // again now simply lets her in.
    await chat.api.updateConversation({
      userId: "alice",
      conversationId: channel.id,
      joinPolicy: "open",
    });

    const result = await chat.api.joinConversation({
      userId: "carol",
      conversationId: channel.id,
    });
    expect(result.status).toBe("joined");
    // The stale row is still in the queue for an admin to tidy, and resolving
    // it after the fact is a no-op add.
    const queue = await chat.api.listJoinRequests({ userId: "alice", conversationId: channel.id });
    expect(queue.map((r) => r.userId)).toEqual(["carol"]);
  });
});

describe("an invite still overrides the channel policy", () => {
  it("lets a no-approval link walk straight into an approval channel", async () => {
    const chat = createChat();
    const channel = await seedChannel(chat, { joinPolicy: "approval" });
    const invite = await chat.api.createInvite({ userId: "alice", conversationId: channel.id });

    const result = await chat.api.acceptInvite({ userId: "carol", code: invite.code });

    // The admin who minted the link vouched for whoever holds it (ADR 0020 §3).
    expect(result.status).toBe("joined");
  });

  it("routes an approval-gated link through the queue in an open channel", async () => {
    const chat = createChat();
    const channel = await seedChannel(chat);
    const invite = await chat.api.createInvite({
      userId: "alice",
      conversationId: channel.id,
      requiresApproval: true,
    });

    const result = await chat.api.acceptInvite({ userId: "carol", code: invite.code });

    expect(result.status).toBe("pending");
    expect(result.joinRequest!.inviteCode).toBe(invite.code);
  });
});

describe("adapters without the channels capability", () => {
  it("refuses to set a non-default visibility or joinPolicy", async () => {
    const chat = chatpack({ storage: adapterWithoutChannels(), telemetry: false });

    // The failure mode the namespace exists to prevent: without this check the
    // adapter would drop the field, return `"private"`, and nobody would notice
    // until the channel failed to appear in a directory (ADR 0020 §4).
    await expect(
      chat.api.createGroupConversation({ userId: "alice", visibility: "public" }),
    ).rejects.toMatchObject({ code: "CHANNELS_UNSUPPORTED" });
    await expect(
      chat.api.createGroupConversation({ userId: "alice", joinPolicy: "open" }),
    ).rejects.toMatchObject({ code: "CHANNELS_UNSUPPORTED" });

    const group = await chat.api.createGroupConversation({ userId: "alice", name: "Standup" });
    await expect(
      chat.api.updateConversation({
        userId: "alice",
        conversationId: group.id,
        visibility: "public",
      }),
    ).rejects.toMatchObject({ code: "CHANNELS_UNSUPPORTED" });
  });

  it("reports CHANNELS_UNSUPPORTED from the directory and the join route", async () => {
    const chat = chatpack({ storage: adapterWithoutChannels(), telemetry: false });
    const group = await chat.api.createGroupConversation({ userId: "alice", name: "Standup" });

    await expect(chat.api.listPublicConversations({ userId: "carol" })).rejects.toMatchObject({
      code: "CHANNELS_UNSUPPORTED",
    });
    await expect(
      chat.api.joinConversation({ userId: "carol", conversationId: group.id }),
    ).rejects.toMatchObject({ code: "CHANNELS_UNSUPPORTED" });
  });

  it("leaves private groups fully working, defaults included", async () => {
    const chat = chatpack({ storage: adapterWithoutChannels(), telemetry: false });

    // Explicitly asking for the defaults asks for nothing the adapter cannot
    // do, so it must not fail - the gate is on the resolved value, not on
    // whether the field was mentioned.
    const group = await chat.api.createGroupConversation({
      userId: "alice",
      userIds: ["bob"],
      name: "Standup",
      visibility: "private",
      joinPolicy: "approval",
    });
    expect(group).toMatchObject({ visibility: "private", joinPolicy: "approval" });

    const renamed = await chat.api.updateConversation({
      userId: "alice",
      conversationId: group.id,
      name: "Daily",
    });
    expect(renamed.name).toBe("Daily");
    await expect(
      chat.api.sendMessage({ userId: "alice", conversationId: group.id, body: "hi" }),
    ).resolves.toMatchObject({ body: "hi" });
  });
});

describe("HTTP routes", () => {
  async function seedHttpChannel(
    handler: ChatpackHandler,
    body: Record<string, unknown> = {},
  ): Promise<string> {
    const response = await send(handler, "POST", "/conversations/group", "alice", {
      name: "General",
      visibility: "public",
      joinPolicy: "open",
      ...body,
    });
    expect(response.status).toBe(201);
    const parsed = (await response.json()) as { conversation: { id: string } };
    return parsed.conversation.id;
  }

  it("creates a channel through POST /conversations/group", async () => {
    const handler = createHttpChat();
    const response = await send(handler, "POST", "/conversations/group", "alice", {
      name: "General",
      visibility: "public",
    });

    expect(response.status).toBe(201);
    expect((await response.json()) as unknown).toMatchObject({
      conversation: { visibility: "public", joinPolicy: "approval" },
    });
  });

  it("browses GET /channels with limit and cursor", async () => {
    const handler = createHttpChat();
    const channelId = await seedHttpChannel(handler);
    await seedHttpChannel(handler, { name: "Second" });

    const response = await get(handler, "/channels?limit=1", "carol");
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      channels: { conversationId: string; name: string }[];
      nextCursor: string | null;
    };
    expect(body.channels).toHaveLength(1);
    expect(body.nextCursor).not.toBeNull();

    const next = await get(
      handler,
      `/channels?limit=1&cursor=${encodeURIComponent(body.nextCursor!)}`,
      "carol",
    );
    const page2 = (await next.json()) as { channels: { conversationId: string }[] };
    expect(page2.channels[0]!.conversationId).toBe(channelId);
  });

  it("requires authentication like every other route", async () => {
    const handler = createHttpChat();
    await seedHttpChannel(handler);

    // "Public" means discoverable by your users, not anonymous: the auth hook
    // runs before routing.
    const response = await get(handler, "/channels");
    expect(response.status).toBe(401);
  });

  it("joins with 200 for both outcomes, discriminated by status", async () => {
    const handler = createHttpChat();
    const open = await seedHttpChannel(handler);
    const gated = await seedHttpChannel(handler, { name: "Gated", joinPolicy: "approval" });

    const joined = await handler.POST(
      // No body at all: the message is optional, so this must not be a 400.
      new Request(`${BASE}/conversations/${open}/join`, {
        method: "POST",
        headers: { "x-user-id": "carol" },
      }),
    );
    expect(joined.status).toBe(200);
    expect((await joined.json()) as unknown).toMatchObject({
      status: "joined",
      joinRequest: null,
    });

    const pending = await send(handler, "POST", `/conversations/${gated}/join`, "carol", {
      message: "please",
    });
    expect(pending.status).toBe(200);
    expect((await pending.json()) as unknown).toMatchObject({
      status: "pending",
      conversation: null,
      joinRequest: { message: "please" },
    });
  });

  it("answers 403 for a private group and 409 for a repeat join", async () => {
    const handler = createHttpChat();
    const privateGroup = await send(handler, "POST", "/conversations/group", "alice", {
      name: "Private",
    });
    const { conversation } = (await privateGroup.json()) as { conversation: { id: string } };
    const channelId = await seedHttpChannel(handler);

    const refused = await send(handler, "POST", `/conversations/${conversation.id}/join`, "carol");
    // 403, not 404: core knows the row exists (ADR 0020 §7).
    expect(refused.status).toBe(403);
    expect((await refused.json()) as unknown).toMatchObject({
      error: { code: "NOT_PUBLIC_CONVERSATION" },
    });

    await send(handler, "POST", `/conversations/${channelId}/join`, "carol");
    const again = await send(handler, "POST", `/conversations/${channelId}/join`, "carol");
    expect(again.status).toBe(409);
  });

  it("never reads 'join' as a conversation id", async () => {
    const handler = createHttpChat();
    const channelId = await seedHttpChannel(handler);

    // The literal-segment ordering trap: /conversations/:id/join is matched by
    // segment count and the trailing literal, so the id is never confused.
    const response = await send(handler, "POST", `/conversations/${channelId}/join`, "carol");
    expect(response.status).toBe(200);
  });

  it("accepts visibility-only PATCH and still requires a field", async () => {
    const handler = createHttpChat();
    const response = await send(handler, "POST", "/conversations/group", "alice", {
      name: "Standup",
    });
    const { conversation } = (await response.json()) as { conversation: { id: string } };

    const patched = await send(handler, "PATCH", `/conversations/${conversation.id}`, "alice", {
      visibility: "public",
    });
    expect(patched.status).toBe(200);
    expect((await patched.json()) as unknown).toMatchObject({
      conversation: { visibility: "public", name: "Standup" },
    });

    // `name` stays required when it is the only field on offer, so PATCH {} is
    // the same 400 it always was.
    const empty = await send(handler, "PATCH", `/conversations/${conversation.id}`, "alice", {});
    expect(empty.status).toBe(400);

    // Explicit null still clears the title.
    const cleared = await send(handler, "PATCH", `/conversations/${conversation.id}`, "alice", {
      name: null,
    });
    expect((await cleared.json()) as unknown).toMatchObject({ conversation: { name: null } });
  });

  it("rejects a bogus visibility with 400", async () => {
    const handler = createHttpChat();
    const response = await send(handler, "POST", "/conversations/group", "alice", {
      visibility: "unlisted",
    });

    expect(response.status).toBe(400);
    expect((await response.json()) as unknown).toMatchObject({
      error: { code: "INVALID_INPUT" },
    });
  });
});
