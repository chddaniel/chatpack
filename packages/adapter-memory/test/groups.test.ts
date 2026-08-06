/**
 * Group conversations (`docs/decisions/0017`), driven through the core engine on
 * the in-memory adapter, plus the five new HTTP routes.
 *
 * The invariants worth guarding here are the ones the ADR bought with its
 * design: DMs keep their old behavior exactly (pair-key uniqueness, find-or-
 * create), a group always keeps at least one admin, membership writes are
 * idempotent, fan-out is N-ary, and a removed user still hears about their own
 * removal.
 */
import { describe, expect, it, vi } from "vitest";

import {
  chatpack,
  ChatpackError,
  MAX_CONVERSATION_NAME_LENGTH,
  MAX_GROUP_PARTICIPANTS,
  type ChatpackHandler,
  type ConversationEvent,
  type PermissionContext,
  type TransportEvent,
} from "@chatpack/core";
import { memoryAdapter } from "../src/index";

const BASE = "http://test.local/api/chat";

function createChat(options: Partial<Parameters<typeof chatpack>[0]> = {}) {
  return chatpack({ storage: memoryAdapter(), telemetry: false, ...options });
}

/** A chat instance plus every event its transport published. */
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

/** alice (admin) + bob + carol. */
async function seedGroup(chat: ReturnType<typeof createChat>) {
  return chat.api.createGroupConversation({
    userId: "alice",
    userIds: ["bob", "carol"],
    name: "Standup",
  });
}

describe("creating groups", () => {
  it("makes the creator an admin and everyone else a member", async () => {
    const group = await seedGroup(createChat());

    expect(group).toMatchObject({ type: "group", pairKey: null, name: "Standup" });
    expect(group.participants.map((p) => [p.userId, p.role])).toEqual([
      ["alice", "admin"],
      ["bob", "member"],
      ["carol", "member"],
    ]);
  });

  it("can start with only its creator", async () => {
    const group = await createChat().api.createGroupConversation({ userId: "alice" });

    expect(group.participants.map((p) => p.userId)).toEqual(["alice"]);
    expect(group.name).toBeNull();
  });

  it("is never find-or-create: identical membership yields distinct groups", async () => {
    const chat = createChat();
    const first = await seedGroup(chat);
    const second = await seedGroup(chat);

    expect(first.id).not.toBe(second.id);
  });

  it("drops the creator's own id and duplicates from userIds", async () => {
    const group = await createChat().api.createGroupConversation({
      userId: "alice",
      userIds: ["bob", "bob", "alice"],
    });

    expect(group.participants.map((p) => p.userId)).toEqual(["alice", "bob"]);
  });

  it("trims the name and rejects an empty or oversized one", async () => {
    const chat = createChat();

    const trimmed = await chat.api.createGroupConversation({ userId: "alice", name: "  Team  " });
    expect(trimmed.name).toBe("Team");

    await expect(
      chat.api.createGroupConversation({ userId: "alice", name: "   " }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(
      chat.api.createGroupConversation({
        userId: "alice",
        name: "x".repeat(MAX_CONVERSATION_NAME_LENGTH + 1),
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("refuses to create a group larger than the participant cap", async () => {
    const userIds = Array.from({ length: MAX_GROUP_PARTICIPANTS }, (_, i) => `u${i}`);

    await expect(
      createChat().api.createGroupConversation({ userId: "alice", userIds }),
    ).rejects.toMatchObject({ code: "GROUP_LIMIT_EXCEEDED" });
  });

  it("tells seeded members about the group over the transport", async () => {
    const { chat, events } = createRecordingChat();
    const group = await seedGroup(chat);

    expect(conversationEvents(events)).toMatchObject([
      {
        type: "participant.added",
        conversationId: group.id,
        actorId: "alice",
        affectedUserIds: ["bob", "carol"],
        recipientIds: ["alice", "bob", "carol"],
      },
    ]);
  });

  it("publishes nothing for a creator-only group - there is no one to tell", async () => {
    const { chat, events } = createRecordingChat();
    await chat.api.createGroupConversation({ userId: "alice" });

    expect(events).toEqual([]);
  });
});

describe("DMs are unchanged by groups", () => {
  it("stay find-or-create, keep their pair key, and carry no name", async () => {
    const chat = createChat();
    const first = await chat.api.getOrCreateConversation({ userId: "alice", otherUserId: "bob" });
    const second = await chat.api.getOrCreateConversation({ userId: "bob", otherUserId: "alice" });

    expect(second.id).toBe(first.id);
    expect(first).toMatchObject({ type: "direct", pairKey: "alice:bob", name: null });
  });

  it("reject every group-only operation with NOT_GROUP_CONVERSATION", async () => {
    const chat = createChat();
    const dm = await chat.api.getOrCreateConversation({ userId: "alice", otherUserId: "bob" });

    await expect(
      chat.api.addParticipants({ userId: "alice", conversationId: dm.id, userIds: ["carol"] }),
    ).rejects.toMatchObject({ code: "NOT_GROUP_CONVERSATION" });
    await expect(
      chat.api.removeParticipant({ userId: "alice", conversationId: dm.id, targetUserId: "bob" }),
    ).rejects.toMatchObject({ code: "NOT_GROUP_CONVERSATION" });
    await expect(
      chat.api.setParticipantRole({
        userId: "alice",
        conversationId: dm.id,
        targetUserId: "bob",
        role: "member",
      }),
    ).rejects.toMatchObject({ code: "NOT_GROUP_CONVERSATION" });
    await expect(
      chat.api.updateConversation({ userId: "alice", conversationId: dm.id, name: "nope" }),
    ).rejects.toMatchObject({ code: "NOT_GROUP_CONVERSATION" });
  });
});

describe("membership", () => {
  it("adds members as members, idempotently", async () => {
    const chat = createChat();
    const group = await seedGroup(chat);

    const added = await chat.api.addParticipants({
      userId: "alice",
      conversationId: group.id,
      userIds: ["dave"],
    });
    expect(added.participants.map((p) => p.userId)).toEqual(["alice", "bob", "carol", "dave"]);
    expect(added.participants.find((p) => p.userId === "dave")?.role).toBe("member");

    // Replayed request: same membership, no duplicate row.
    const again = await chat.api.addParticipants({
      userId: "alice",
      conversationId: group.id,
      userIds: ["dave"],
    });
    expect(again.participants.map((p) => p.userId)).toEqual(["alice", "bob", "carol", "dave"]);
  });

  it("never demotes an existing admin on a replayed add", async () => {
    const chat = createChat();
    const group = await seedGroup(chat);
    await chat.api.setParticipantRole({
      userId: "alice",
      conversationId: group.id,
      targetUserId: "bob",
      role: "admin",
    });

    const updated = await chat.api.addParticipants({
      userId: "alice",
      conversationId: group.id,
      userIds: ["bob"],
    });

    expect(updated.participants.find((p) => p.userId === "bob")?.role).toBe("admin");
  });

  it("publishes no event when every requested member is already in", async () => {
    const { chat, events } = createRecordingChat();
    const group = await seedGroup(chat);
    events.length = 0;

    await chat.api.addParticipants({
      userId: "alice",
      conversationId: group.id,
      userIds: ["bob"],
    });

    expect(events).toEqual([]);
  });

  it("removes a member, idempotently, and leaves their messages in place", async () => {
    const chat = createChat();
    const group = await seedGroup(chat);
    const message = await chat.api.sendMessage({
      userId: "bob",
      conversationId: group.id,
      body: "before I left",
    });

    const removed = await chat.api.removeParticipant({
      userId: "alice",
      conversationId: group.id,
      targetUserId: "bob",
    });
    expect(removed.participants.map((p) => p.userId)).toEqual(["alice", "carol"]);

    // Removing a non-member is a silent no-op, not an error.
    const again = await chat.api.removeParticipant({
      userId: "alice",
      conversationId: group.id,
      targetUserId: "bob",
    });
    expect(again.participants.map((p) => p.userId)).toEqual(["alice", "carol"]);

    // Departure does not rewrite history.
    const { messages } = await chat.api.listMessages({
      userId: "alice",
      conversationId: group.id,
    });
    expect(messages.map((m) => m.id)).toContain(message.id);
  });

  it("lets a member leave without being an admin", async () => {
    const chat = createChat();
    const group = await seedGroup(chat);

    const left = await chat.api.removeParticipant({
      userId: "bob",
      conversationId: group.id,
      targetUserId: "bob",
    });

    expect(left.participants.map((p) => p.userId)).toEqual(["alice", "carol"]);
  });

  it("delivers participant.removed to the removed user too", async () => {
    const { chat, events } = createRecordingChat();
    const group = await seedGroup(chat);
    events.length = 0;

    await chat.api.removeParticipant({
      userId: "alice",
      conversationId: group.id,
      targetUserId: "bob",
    });

    // The one place recipientIds deliberately contains a non-participant: it is
    // the only signal telling bob's client to drop the conversation.
    expect(conversationEvents(events)).toMatchObject([
      {
        type: "participant.removed",
        actorId: "alice",
        affectedUserIds: ["bob"],
        recipientIds: ["alice", "bob", "carol"],
      },
    ]);
    expect(conversationEvents(events)[0]?.conversation.participants.map((p) => p.userId)).toEqual([
      "alice",
      "carol",
    ]);
  });

  it("stops a removed member from reading or writing", async () => {
    const chat = createChat();
    const group = await seedGroup(chat);
    await chat.api.removeParticipant({
      userId: "alice",
      conversationId: group.id,
      targetUserId: "bob",
    });

    await expect(
      chat.api.getConversation({ userId: "bob", conversationId: group.id }),
    ).rejects.toMatchObject({ code: "FORBIDDEN_READ" });
    await expect(
      chat.api.sendMessage({ userId: "bob", conversationId: group.id, body: "still here?" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN_WRITE" });
  });

  it("refuses to exceed the participant cap on add", async () => {
    const chat = createChat();
    const group = await chat.api.createGroupConversation({
      userId: "alice",
      userIds: Array.from({ length: MAX_GROUP_PARTICIPANTS - 1 }, (_, i) => `u${i}`),
    });

    await expect(
      chat.api.addParticipants({
        userId: "alice",
        conversationId: group.id,
        userIds: ["one-too-many"],
      }),
    ).rejects.toMatchObject({ code: "GROUP_LIMIT_EXCEEDED" });
  });
});

describe("roles and the last-admin invariant", () => {
  it("promotes and demotes, and is a no-op when the role already matches", async () => {
    const { chat, events } = createRecordingChat();
    const group = await seedGroup(chat);

    const promoted = await chat.api.setParticipantRole({
      userId: "alice",
      conversationId: group.id,
      targetUserId: "bob",
      role: "admin",
    });
    expect(promoted.participants.find((p) => p.userId === "bob")?.role).toBe("admin");

    events.length = 0;
    await chat.api.setParticipantRole({
      userId: "alice",
      conversationId: group.id,
      targetUserId: "bob",
      role: "admin",
    });
    expect(events).toEqual([]);
  });

  it("announces a role change as conversation.updated naming the target", async () => {
    const { chat, events } = createRecordingChat();
    const group = await seedGroup(chat);
    events.length = 0;

    await chat.api.setParticipantRole({
      userId: "alice",
      conversationId: group.id,
      targetUserId: "bob",
      role: "admin",
    });

    // Not participant.* - membership didn't change, authority did. The target
    // is named in affectedUserIds so a client knows whose badge to re-render
    // without diffing the whole participant list.
    expect(conversationEvents(events)).toMatchObject([
      {
        type: "conversation.updated",
        actorId: "alice",
        affectedUserIds: ["bob"],
        recipientIds: ["alice", "bob", "carol"],
      },
    ]);
  });

  it("refuses to remove the last admin rather than auto-promoting someone", async () => {
    const chat = createChat();
    const group = await seedGroup(chat);

    await expect(
      chat.api.removeParticipant({
        userId: "alice",
        conversationId: group.id,
        targetUserId: "alice",
      }),
    ).rejects.toMatchObject({ code: "LAST_ADMIN_REMAINING" });
  });

  it("refuses to demote the last admin", async () => {
    const chat = createChat();
    const group = await seedGroup(chat);

    await expect(
      chat.api.setParticipantRole({
        userId: "alice",
        conversationId: group.id,
        targetUserId: "alice",
        role: "member",
      }),
    ).rejects.toMatchObject({ code: "LAST_ADMIN_REMAINING" });
  });

  it("lets the last admin leave once someone else is promoted", async () => {
    const chat = createChat();
    const group = await seedGroup(chat);
    await chat.api.setParticipantRole({
      userId: "alice",
      conversationId: group.id,
      targetUserId: "bob",
      role: "admin",
    });

    const left = await chat.api.removeParticipant({
      userId: "alice",
      conversationId: group.id,
      targetUserId: "alice",
    });

    expect(left.participants.map((p) => p.userId)).toEqual(["bob", "carol"]);
  });

  it("blocks plain members from every admin-only action", async () => {
    const chat = createChat();
    const group = await seedGroup(chat);

    await expect(
      chat.api.addParticipants({ userId: "bob", conversationId: group.id, userIds: ["dave"] }),
    ).rejects.toMatchObject({ code: "NOT_CONVERSATION_ADMIN" });
    await expect(
      chat.api.removeParticipant({
        userId: "bob",
        conversationId: group.id,
        targetUserId: "carol",
      }),
    ).rejects.toMatchObject({ code: "NOT_CONVERSATION_ADMIN" });
    await expect(
      chat.api.setParticipantRole({
        userId: "bob",
        conversationId: group.id,
        targetUserId: "carol",
        role: "admin",
      }),
    ).rejects.toMatchObject({ code: "NOT_CONVERSATION_ADMIN" });
    await expect(
      chat.api.updateConversation({ userId: "bob", conversationId: group.id, name: "Renamed" }),
    ).rejects.toMatchObject({ code: "NOT_CONVERSATION_ADMIN" });
  });

  it("honors a canManage override that ignores roles entirely", async () => {
    const seen: PermissionContext[] = [];
    const chat = createChat({
      permissions: {
        canManage: (ctx) => {
          seen.push(ctx);
          return ctx.user.id === "bob";
        },
      },
    });
    const group = await seedGroup(chat);

    // bob is a plain member, but the app says he administers.
    const renamed = await chat.api.updateConversation({
      userId: "bob",
      conversationId: group.id,
      name: "Bob's call",
    });
    expect(renamed.name).toBe("Bob's call");
    expect(seen[0]?.conversation.participantIds).toEqual(["alice", "bob", "carol"]);

    // ...and alice, the actual admin, does not.
    await expect(
      chat.api.updateConversation({ userId: "alice", conversationId: group.id, name: "nope" }),
    ).rejects.toMatchObject({ code: "NOT_CONVERSATION_ADMIN" });
  });

  it("still lets a member leave when canManage denies them", async () => {
    const chat = createChat({ permissions: { canManage: () => false } });
    const group = await seedGroup(chat);

    const left = await chat.api.removeParticipant({
      userId: "bob",
      conversationId: group.id,
      targetUserId: "bob",
    });

    expect(left.participants.map((p) => p.userId)).toEqual(["alice", "carol"]);
  });
});

describe("renaming", () => {
  it("sets, trims, and clears the name", async () => {
    const chat = createChat();
    const group = await seedGroup(chat);

    expect(
      (
        await chat.api.updateConversation({
          userId: "alice",
          conversationId: group.id,
          name: "  Retro  ",
        })
      ).name,
    ).toBe("Retro");
    expect(
      (
        await chat.api.updateConversation({
          userId: "alice",
          conversationId: group.id,
          name: null,
        })
      ).name,
    ).toBeNull();
  });

  it("publishes conversation.updated to every participant", async () => {
    const { chat, events } = createRecordingChat();
    const group = await seedGroup(chat);
    events.length = 0;

    await chat.api.updateConversation({
      userId: "alice",
      conversationId: group.id,
      name: "Retro",
    });

    expect(conversationEvents(events)).toMatchObject([
      {
        type: "conversation.updated",
        actorId: "alice",
        affectedUserIds: [],
        recipientIds: ["alice", "bob", "carol"],
        conversation: { name: "Retro" },
      },
    ]);
  });
});

describe("messaging in a group", () => {
  it("fans out to every participant except the sender", async () => {
    const { chat, events } = createRecordingChat();
    const group = await seedGroup(chat);
    events.length = 0;

    await chat.api.sendMessage({ userId: "bob", conversationId: group.id, body: "morning" });

    const message = events.find((event) => "message" in event);
    // Message events go to everyone including the sender; the send hook is what
    // narrows to "who should be notified".
    expect(message?.recipientIds).toEqual(["alice", "bob", "carol"]);
  });

  it("gives afterMessageMutation every recipient except the sender", async () => {
    const recipients: string[][] = [];
    const others: string[] = [];
    const chat = createChat({
      hooks: {
        afterMessageMutation: ({ recipientIds, otherParticipantId }) => {
          recipients.push(recipientIds);
          others.push(otherParticipantId);
        },
      },
    });
    const group = await seedGroup(chat);

    await chat.api.sendMessage({ userId: "bob", conversationId: group.id, body: "morning" });

    expect(recipients).toEqual([["alice", "carol"]]);
    // The deprecated field is the first non-sender participant - it silently
    // drops carol, which is exactly why it is deprecated (ADR 0017 §5).
    expect(others).toEqual(["alice"]);
  });

  it("counts unread per viewer, and never counts your own messages", async () => {
    const chat = createChat();
    const group = await seedGroup(chat);
    await chat.api.sendMessage({ userId: "alice", conversationId: group.id, body: "one" });
    const second = await chat.api.sendMessage({
      userId: "bob",
      conversationId: group.id,
      body: "two",
    });

    const forCarol = await chat.api.getConversation({ userId: "carol", conversationId: group.id });
    expect(forCarol.unreadCount).toBe(2);

    const forAlice = await chat.api.getConversation({ userId: "alice", conversationId: group.id });
    expect(forAlice.unreadCount).toBe(1);

    await chat.api.markRead({ userId: "carol", conversationId: group.id, messageId: second.id });
    expect(
      (await chat.api.getConversation({ userId: "carol", conversationId: group.id })).unreadCount,
    ).toBe(0);
  });

  it("lets any member react, and aggregates all reactors", async () => {
    const chat = createChat();
    const group = await seedGroup(chat);
    const message = await chat.api.sendMessage({
      userId: "alice",
      conversationId: group.id,
      body: "ship it",
    });

    await chat.api.addReaction({ userId: "bob", messageId: message.id, emoji: "🚀" });
    const reacted = await chat.api.addReaction({
      userId: "carol",
      messageId: message.id,
      emoji: "🚀",
    });

    expect(reacted.reactions).toEqual([{ emoji: "🚀", count: 2, userIds: ["bob", "carol"] }]);
  });

  it("finds group messages in search for members only", async () => {
    const chat = createChat();
    const group = await seedGroup(chat);
    await chat.api.sendMessage({
      userId: "alice",
      conversationId: group.id,
      body: "deployment tomorrow",
    });

    expect(
      (await chat.api.searchMessages({ userId: "carol", query: "deployment" })).messages,
    ).toHaveLength(1);
    expect(
      (await chat.api.searchMessages({ userId: "stranger", query: "deployment" })).messages,
    ).toHaveLength(0);
  });

  it("lists groups alongside DMs, most recently active first", async () => {
    const chat = createChat();
    const dm = await chat.api.getOrCreateConversation({ userId: "alice", otherUserId: "bob" });
    const group = await seedGroup(chat);
    await chat.api.sendMessage({ userId: "alice", conversationId: dm.id, body: "dm first" });
    await chat.api.sendMessage({ userId: "alice", conversationId: group.id, body: "group last" });

    const { conversations } = await chat.api.listConversations({ userId: "alice" });
    expect(conversations.map((c) => [c.id, c.type])).toEqual([
      [group.id, "group"],
      [dm.id, "direct"],
    ]);
  });
});

describe("group HTTP routes", () => {
  it("creates a group with 201 and the full conversation", async () => {
    const handler = createHttpChat();

    const res = await send(handler, "POST", "/conversations/group", "alice", {
      userIds: ["bob"],
      name: "Launch",
    });

    expect(res.status).toBe(201);
    const { conversation } = (await res.json()) as {
      conversation: {
        type: string;
        name: string;
        participants: { userId: string; role: string }[];
      };
    };
    expect(conversation).toMatchObject({ type: "group", name: "Launch" });
    expect(conversation.participants.map((p) => [p.userId, p.role])).toEqual([
      ["alice", "admin"],
      ["bob", "member"],
    ]);
  });

  it("does not mistake /conversations/group for a conversation id", async () => {
    const handler = createHttpChat();

    // GET on the same path is a lookup for a conversation whose *id* is
    // "group", which does not exist - the POST route must not shadow it or
    // vice versa. The bodyless POST also proves group creation needs no body.
    expect((await get(handler, "/conversations/group", "alice")).status).toBe(404);
    expect((await send(handler, "POST", "/conversations/group", "alice")).status).toBe(201);
  });

  it("adds, promotes, and removes over HTTP", async () => {
    const handler = createHttpChat();
    const created = await send(handler, "POST", "/conversations/group", "alice", {
      userIds: ["bob"],
    });
    const { conversation } = (await created.json()) as { conversation: { id: string } };
    const path = `/conversations/${conversation.id}/participants`;

    const added = await send(handler, "POST", path, "alice", { userIds: ["carol"] });
    expect(added.status).toBe(200);

    const promoted = await send(handler, "PATCH", path, "alice", {
      userId: "carol",
      role: "admin",
    });
    expect(promoted.status).toBe(200);
    const promotedBody = (await promoted.json()) as {
      conversation: { participants: { userId: string; role: string }[] };
    };
    expect(promotedBody.conversation.participants.find((p) => p.userId === "carol")?.role).toBe(
      "admin",
    );

    const removed = await send(handler, "DELETE", path, "alice", { userId: "bob" });
    expect(removed.status).toBe(200);
    const removedBody = (await removed.json()) as {
      conversation: { participants: { userId: string }[] };
    };
    expect(removedBody.conversation.participants.map((p) => p.userId)).toEqual(["alice", "carol"]);
  });

  it("renames over HTTP, and clears with an explicit null", async () => {
    const handler = createHttpChat();
    const created = await send(handler, "POST", "/conversations/group", "alice", { name: "Old" });
    const { conversation } = (await created.json()) as { conversation: { id: string } };

    const renamed = await send(handler, "PATCH", `/conversations/${conversation.id}`, "alice", {
      name: "New",
    });
    expect(renamed.status).toBe(200);
    expect(
      ((await renamed.json()) as { conversation: { name: string | null } }).conversation.name,
    ).toBe("New");

    const cleared = await send(handler, "PATCH", `/conversations/${conversation.id}`, "alice", {
      name: null,
    });
    expect(
      ((await cleared.json()) as { conversation: { name: string | null } }).conversation.name,
    ).toBeNull();

    // Omitting the field entirely is a client bug, not a clear.
    const missing = await send(handler, "PATCH", `/conversations/${conversation.id}`, "alice", {});
    expect(missing.status).toBe(400);
  });

  it("maps every group error code to its documented status", async () => {
    const handler = createHttpChat();
    const created = await send(handler, "POST", "/conversations/group", "alice", {
      userIds: ["bob"],
    });
    const { conversation } = (await created.json()) as { conversation: { id: string } };
    const path = `/conversations/${conversation.id}/participants`;

    // 403: a plain member attempting an admin action.
    expect((await send(handler, "POST", path, "bob", { userIds: ["carol"] })).status).toBe(403);

    // 409: removing the only admin.
    expect((await send(handler, "DELETE", path, "alice", { userId: "alice" })).status).toBe(409);

    // 409: a group operation on a DM.
    const dmRes = await send(handler, "POST", "/conversations", "alice", { otherUserId: "bob" });
    const { conversation: dm } = (await dmRes.json()) as { conversation: { id: string } };
    expect(
      (
        await send(handler, "POST", `/conversations/${dm.id}/participants`, "alice", {
          userIds: ["carol"],
        })
      ).status,
    ).toBe(409);

    // 400: malformed bodies.
    expect((await send(handler, "POST", path, "alice", { userIds: "carol" })).status).toBe(400);
    expect(
      (await send(handler, "PATCH", path, "alice", { userId: "bob", role: "owner" })).status,
    ).toBe(400);
  });

  it("requires auth on every group route", async () => {
    const handler = createHttpChat();

    expect((await send(handler, "POST", "/conversations/group", undefined, {})).status).toBe(401);
    expect(
      (await send(handler, "POST", "/conversations/c1/participants", undefined, { userIds: ["a"] }))
        .status,
    ).toBe(401);
  });
});

describe("the group SSE frame", () => {
  it("carries no id: line, so it cannot rewind gap-fill", async () => {
    const chat = chatpack({
      storage: memoryAdapter(),
      telemetry: false,
      auth: (request) => {
        const userId = request.headers.get("x-user-id");
        return userId ? { id: userId } : null;
      },
    });
    const handler = chat.handler({ heartbeatIntervalMs: 0 });
    const group = await chat.api.createGroupConversation({
      userId: "alice",
      userIds: ["bob"],
      name: "Launch",
    });

    const controller = new AbortController();
    const res = await handler.GET(
      new Request(`${BASE}/stream`, {
        headers: { "x-user-id": "bob" },
        signal: controller.signal,
      }),
    );
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    // Drain the ": connected" preamble before triggering the event.
    await reader.read();

    await chat.api.updateConversation({
      userId: "alice",
      conversationId: group.id,
      name: "Renamed",
    });

    const { value } = await reader.read();
    const frame = decoder.decode(value);

    expect(frame).toContain("event: conversation.updated");
    expect(frame).toContain(`"name":"Renamed"`);
    // The whole point of ADR 0017 §4: no seq was allocated, so no id: frame.
    expect(frame).not.toContain("id:");

    controller.abort();
    await reader.cancel().catch(() => undefined);
  });
});

describe("adapter contract errors surface, not silent success", () => {
  it("throws when a membership write targets a vanished conversation", async () => {
    const storage = memoryAdapter();
    const chat = chatpack({ storage, telemetry: false });
    const group = await chat.api.createGroupConversation({ userId: "alice", userIds: ["bob"] });

    // Simulate a concurrent delete between the read and the write.
    const original = storage.addParticipants.bind(storage);
    vi.spyOn(storage, "addParticipants").mockImplementation(async (input) => {
      return original({ ...input, conversationId: "conv_gone" });
    });

    await expect(
      chat.api.addParticipants({
        userId: "alice",
        conversationId: group.id,
        userIds: ["carol"],
      }),
    ).rejects.toThrow(/unknown conversation/);
    vi.restoreAllMocks();
  });

  it("rejects a role change for someone who is not a member", async () => {
    const chat = createChat();
    const group = await seedGroup(chat);

    await expect(
      chat.api.setParticipantRole({
        userId: "alice",
        conversationId: group.id,
        targetUserId: "stranger",
        role: "admin",
      }),
    ).rejects.toBeInstanceOf(ChatpackError);
  });
});
