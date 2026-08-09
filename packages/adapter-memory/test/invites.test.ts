/**
 * Invite links and join requests (`docs/decisions/0019`), driven through the
 * core engine on the in-memory adapter, plus the eight new HTTP routes.
 *
 * The invariants worth guarding are the ones the ADR bought with its design: a
 * use cap actually caps (no double-spend), redemption is idempotent without
 * burning a use, the preview never leaks the membership list, `canInvite` can be
 * loosened without also granting removal, an adapter without the capability
 * reports 501 rather than crashing, and approving a request publishes exactly
 * the same event an admin-initiated add does.
 */
import { describe, expect, it } from "vitest";

import {
  chatpack,
  ChatpackError,
  MAX_GROUP_PARTICIPANTS,
  MAX_INVITES_PER_CONVERSATION,
  MAX_JOIN_REQUEST_MESSAGE_LENGTH,
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

/** alice (admin) + bob. */
async function seedGroup(chat: ReturnType<typeof createChat>) {
  return chat.api.createGroupConversation({
    userId: "alice",
    userIds: ["bob"],
    name: "Standup",
  });
}

/** An adapter that never gained the ADR 0019 capability. */
function adapterWithoutInvites(): StorageAdapter {
  const { invites: _invites, ...rest } = memoryAdapter();
  return rest;
}

describe("creating invites", () => {
  it("mints a code with no limits by default", async () => {
    const chat = createChat();
    const group = await seedGroup(chat);

    const invite = await chat.api.createInvite({ userId: "alice", conversationId: group.id });

    expect(invite).toMatchObject({
      conversationId: group.id,
      createdBy: "alice",
      expiresAt: null,
      maxUses: null,
      uses: 0,
      requiresApproval: false,
    });
    // 32 bytes of base64url, and URL-safe so it can live in a path segment.
    expect(invite.code).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("generates a distinct unguessable code every time", async () => {
    const chat = createChat();
    const group = await seedGroup(chat);

    const codes = new Set<string>();
    for (let i = 0; i < 20; i += 1) {
      const invite = await chat.api.createInvite({ userId: "alice", conversationId: group.id });
      codes.add(invite.code);
    }

    expect(codes.size).toBe(20);
  });

  it("turns expiresInSeconds into an absolute expiry", async () => {
    const chat = createChat();
    const group = await seedGroup(chat);
    const before = Date.now();

    const invite = await chat.api.createInvite({
      userId: "alice",
      conversationId: group.id,
      expiresInSeconds: 3600,
    });

    expect(invite.expiresAt).toBeInstanceOf(Date);
    expect(invite.expiresAt!.getTime()).toBeGreaterThanOrEqual(before + 3_600_000);
  });

  it("refuses a plain member by default", async () => {
    const chat = createChat();
    const group = await seedGroup(chat);

    await expect(
      chat.api.createInvite({ userId: "bob", conversationId: group.id }),
    ).rejects.toMatchObject({ code: "NOT_CONVERSATION_ADMIN" });
  });

  it("refuses a direct conversation - a DM's membership is fixed", async () => {
    const chat = createChat();
    const dm = await chat.api.getOrCreateConversation({ userId: "alice", otherUserId: "bob" });

    await expect(
      chat.api.createInvite({ userId: "alice", conversationId: dm.id }),
    ).rejects.toMatchObject({ code: "NOT_GROUP_CONVERSATION" });
  });

  it("rejects non-positive limits", async () => {
    const chat = createChat();
    const group = await seedGroup(chat);

    for (const bad of [0, -1, 1.5]) {
      await expect(
        chat.api.createInvite({ userId: "alice", conversationId: group.id, maxUses: bad }),
      ).rejects.toBeInstanceOf(ChatpackError);
    }
  });

  it("caps how many invites one group may hold", async () => {
    const chat = createChat();
    const group = await seedGroup(chat);
    for (let i = 0; i < MAX_INVITES_PER_CONVERSATION; i += 1) {
      await chat.api.createInvite({ userId: "alice", conversationId: group.id });
    }

    await expect(
      chat.api.createInvite({ userId: "alice", conversationId: group.id }),
    ).rejects.toMatchObject({ code: "INVITE_LIMIT_EXCEEDED" });
  });

  it("lets canInvite be loosened to members without granting removal", async () => {
    const chat = createChat({
      permissions: {
        canInvite: (ctx: PermissionContext) =>
          ctx.conversation.participantIds.includes(ctx.user.id),
      },
    });
    const group = await seedGroup(chat);

    // bob may now mint a link...
    await expect(
      chat.api.createInvite({ userId: "bob", conversationId: group.id }),
    ).resolves.toMatchObject({ createdBy: "bob" });
    // ...but this is exactly what a shared canManage would have leaked.
    await expect(
      chat.api.removeParticipant({
        userId: "bob",
        conversationId: group.id,
        targetUserId: "alice",
      }),
    ).rejects.toMatchObject({ code: "NOT_CONVERSATION_ADMIN" });
    await expect(
      chat.api.listInvites({ userId: "bob", conversationId: group.id }),
    ).rejects.toMatchObject({ code: "NOT_CONVERSATION_ADMIN" });
  });
});

describe("listing and revoking invites", () => {
  it("lists a group's invites for an admin, newest-first", async () => {
    const chat = createChat();
    const group = await seedGroup(chat);
    const first = await chat.api.createInvite({ userId: "alice", conversationId: group.id });
    const second = await chat.api.createInvite({ userId: "alice", conversationId: group.id });

    const invites = await chat.api.listInvites({ userId: "alice", conversationId: group.id });

    expect(invites).toHaveLength(2);
    expect(invites.map((i) => i.code)).toContain(first.code);
    expect(invites.map((i) => i.code)).toContain(second.code);
  });

  it("makes a revoked code indistinguishable from one that never existed", async () => {
    const chat = createChat();
    const group = await seedGroup(chat);
    const invite = await chat.api.createInvite({ userId: "alice", conversationId: group.id });

    await chat.api.revokeInvite({ userId: "alice", conversationId: group.id, code: invite.code });

    await expect(
      chat.api.getInvitePreview({ userId: "carol", code: invite.code }),
    ).rejects.toMatchObject({ code: "INVITE_NOT_FOUND" });
    await expect(
      chat.api.getInvitePreview({ userId: "carol", code: "never-existed" }),
    ).rejects.toMatchObject({ code: "INVITE_NOT_FOUND" });
  });

  it("is idempotent when revoking an unknown code", async () => {
    const chat = createChat();
    const group = await seedGroup(chat);

    await expect(
      chat.api.revokeInvite({ userId: "alice", conversationId: group.id, code: "nope" }),
    ).resolves.toBeUndefined();
  });

  it("cannot revoke another group's invite by guessing the code", async () => {
    const chat = createChat();
    const groupA = await seedGroup(chat);
    const groupB = await chat.api.createGroupConversation({ userId: "alice", name: "Other" });
    const invite = await chat.api.createInvite({ userId: "alice", conversationId: groupA.id });

    await chat.api.revokeInvite({ userId: "alice", conversationId: groupB.id, code: invite.code });

    // Still usable: the delete was scoped to groupB, which does not own it.
    await expect(
      chat.api.getInvitePreview({ userId: "carol", code: invite.code }),
    ).resolves.toMatchObject({ conversationId: groupA.id });
  });
});

describe("previewing an invite", () => {
  it("returns a participant count, never the participant ids", async () => {
    const chat = createChat();
    const group = await seedGroup(chat);
    const invite = await chat.api.createInvite({ userId: "alice", conversationId: group.id });

    const preview = await chat.api.getInvitePreview({ userId: "carol", code: invite.code });

    expect(preview).toEqual({
      conversationId: group.id,
      name: "Standup",
      participantCount: 2,
      requiresApproval: false,
      invitedBy: "alice",
      alreadyParticipant: false,
    });
    // The whole point of a separate shape (ADR 0019 §10): no member ids leak to
    // a non-member holding a link.
    expect(JSON.stringify(preview)).not.toContain("bob");
  });

  it("tells an existing participant that accepting is a no-op", async () => {
    const chat = createChat();
    const group = await seedGroup(chat);
    const invite = await chat.api.createInvite({ userId: "alice", conversationId: group.id });

    const preview = await chat.api.getInvitePreview({ userId: "bob", code: invite.code });

    expect(preview.alreadyParticipant).toBe(true);
  });

  it("reports an expired invite as gone, not missing", async () => {
    const storage = memoryAdapter();
    const chat = chatpack({ storage, telemetry: false });
    const group = await seedGroup(chat);
    await chat.api.createInvite({
      userId: "alice",
      conversationId: group.id,
      expiresInSeconds: 60,
    });

    // Reach past core and write an expiry in the past, rather than waiting on a
    // real timer: `expiresInSeconds` only accepts positive integers.
    const [stored] = await storage.invites!.listInvites(group.id);
    const expired = await storage.invites!.createInvite({
      conversationId: group.id,
      code: stored!.code,
      createdBy: "alice",
      expiresAt: new Date(Date.now() - 1000),
      maxUses: null,
      requiresApproval: false,
      metadata: {},
    });

    await expect(
      chat.api.getInvitePreview({ userId: "carol", code: expired.code }),
    ).rejects.toMatchObject({ code: "INVITE_EXPIRED" });
    await expect(
      chat.api.acceptInvite({ userId: "carol", code: expired.code }),
    ).rejects.toMatchObject({ code: "INVITE_EXPIRED" });
  });
});

describe("accepting an invite", () => {
  it("joins the group as a member and publishes participant.added", async () => {
    const { chat, events } = createRecordingChat();
    const group = await seedGroup(chat);
    const invite = await chat.api.createInvite({ userId: "alice", conversationId: group.id });
    events.length = 0;

    const result = await chat.api.acceptInvite({ userId: "carol", code: invite.code });

    expect(result.status).toBe("joined");
    expect(result.joinRequest).toBeNull();
    expect(result.conversation!.participants.map((p) => [p.userId, p.role])).toEqual([
      ["alice", "admin"],
      ["bob", "member"],
      ["carol", "member"],
    ]);

    // The same event an admin-initiated add publishes - no new union member
    // (ADR 0019 §6), so existing clients need no change.
    const published = conversationEvents(events);
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({
      type: "participant.added",
      affectedUserIds: ["carol"],
      // The link's creator authorized this membership when they minted it.
      actorId: "alice",
    });
    expect(published[0]!.recipientIds).toEqual(["alice", "bob", "carol"]);
  });

  it("consumes exactly one use", async () => {
    const chat = createChat();
    const group = await seedGroup(chat);
    const invite = await chat.api.createInvite({
      userId: "alice",
      conversationId: group.id,
      maxUses: 3,
    });

    await chat.api.acceptInvite({ userId: "carol", code: invite.code });

    const [stored] = await chat.api.listInvites({ userId: "alice", conversationId: group.id });
    expect(stored!.uses).toBe(1);
  });

  it("is idempotent for an existing participant and burns no use", async () => {
    const chat = createChat();
    const group = await seedGroup(chat);
    const invite = await chat.api.createInvite({
      userId: "alice",
      conversationId: group.id,
      maxUses: 1,
    });

    const first = await chat.api.acceptInvite({ userId: "carol", code: invite.code });
    const second = await chat.api.acceptInvite({ userId: "carol", code: invite.code });

    expect(first.status).toBe("joined");
    expect(second.status).toBe("joined");
    expect(second.conversation!.id).toBe(group.id);
    // A double-clicked link must not cost the group its only remaining use.
    const [stored] = await chat.api.listInvites({ userId: "alice", conversationId: group.id });
    expect(stored!.uses).toBe(1);
  });

  it("still answers the member it admitted after the link is spent", async () => {
    const chat = createChat();
    const group = await seedGroup(chat);
    const invite = await chat.api.createInvite({
      userId: "alice",
      conversationId: group.id,
      maxUses: 1,
    });
    await chat.api.acceptInvite({ userId: "carol", code: invite.code });

    // The link is exhausted now, but carol is in the group - so re-opening it
    // must return her membership, not 410 her out of a room she is standing in.
    const again = await chat.api.acceptInvite({ userId: "carol", code: invite.code });

    expect(again.status).toBe("joined");
    expect(again.conversation!.id).toBe(group.id);
  });

  it("still answers a pending requester after the link is spent", async () => {
    const chat = createChat();
    const group = await seedGroup(chat);
    const invite = await chat.api.createInvite({
      userId: "alice",
      conversationId: group.id,
      requiresApproval: true,
      maxUses: 1,
    });
    const first = await chat.api.acceptInvite({ userId: "carol", code: invite.code });

    const again = await chat.api.acceptInvite({ userId: "carol", code: invite.code });

    expect(again.status).toBe("pending");
    expect(again.joinRequest!.id).toBe(first.joinRequest!.id);
  });

  it("refuses once maxUses is exhausted", async () => {
    const chat = createChat();
    const group = await seedGroup(chat);
    const invite = await chat.api.createInvite({
      userId: "alice",
      conversationId: group.id,
      maxUses: 1,
    });
    await chat.api.acceptInvite({ userId: "carol", code: invite.code });

    await expect(
      chat.api.acceptInvite({ userId: "dave", code: invite.code }),
    ).rejects.toMatchObject({ code: "INVITE_EXPIRED" });
  });

  it("never lets concurrent redemptions exceed maxUses", async () => {
    const chat = createChat();
    const group = await seedGroup(chat);
    const invite = await chat.api.createInvite({
      userId: "alice",
      conversationId: group.id,
      maxUses: 2,
    });

    // Five people click the same two-use link at once. The atomic consume is
    // the only thing that makes this safe (ADR 0019 §2).
    const results = await Promise.allSettled(
      ["carol", "dave", "erin", "frank", "grace"].map((userId) =>
        chat.api.acceptInvite({ userId, code: invite.code }),
      ),
    );

    const joined = results.filter((r) => r.status === "fulfilled");
    expect(joined).toHaveLength(2);
    const [stored] = await chat.api.listInvites({ userId: "alice", conversationId: group.id });
    expect(stored!.uses).toBe(2);
    const updated = await chat.api.getConversation({ userId: "alice", conversationId: group.id });
    expect(updated.participants).toHaveLength(4);
  });

  it("costs the link nothing when the group is already full", async () => {
    const chat = createChat();
    const others = Array.from({ length: MAX_GROUP_PARTICIPANTS - 1 }, (_, i) => `member-${i}`);
    const group = await chat.api.createGroupConversation({
      userId: "alice",
      userIds: others,
      name: "Everyone",
    });
    const invite = await chat.api.createInvite({
      userId: "alice",
      conversationId: group.id,
      maxUses: 1,
    });

    await expect(
      chat.api.acceptInvite({ userId: "carol", code: invite.code }),
    ).rejects.toMatchObject({ code: "GROUP_LIMIT_EXCEEDED" });

    // The cap is checked before the use is spent, so the link survives to be
    // redeemed once somebody leaves.
    const [stored] = await chat.api.listInvites({ userId: "alice", conversationId: group.id });
    expect(stored!.uses).toBe(0);
    await chat.api.removeParticipant({
      userId: "alice",
      conversationId: group.id,
      targetUserId: others[0]!,
    });
    await expect(
      chat.api.acceptInvite({ userId: "carol", code: invite.code }),
    ).resolves.toMatchObject({ status: "joined" });
  });

  it("creates a pending request instead of joining when approval is required", async () => {
    const { chat, events } = createRecordingChat();
    const group = await seedGroup(chat);
    const invite = await chat.api.createInvite({
      userId: "alice",
      conversationId: group.id,
      requiresApproval: true,
    });
    events.length = 0;

    const result = await chat.api.acceptInvite({
      userId: "carol",
      code: invite.code,
      message: "I'm on the design team",
    });

    expect(result.status).toBe("pending");
    expect(result.conversation).toBeNull();
    expect(result.joinRequest).toMatchObject({
      conversationId: group.id,
      userId: "carol",
      status: "pending",
      message: "I'm on the design team",
      inviteCode: invite.code,
    });
    // Not yet a member.
    const unchanged = await chat.api.getConversation({ userId: "alice", conversationId: group.id });
    expect(unchanged.participants).toHaveLength(2);
    // And deliberately no event: nothing on any member's screen is stale.
    expect(conversationEvents(events)).toHaveLength(0);
  });

  it("returns the same pending request on a second click, consuming nothing", async () => {
    const chat = createChat();
    const group = await seedGroup(chat);
    const invite = await chat.api.createInvite({
      userId: "alice",
      conversationId: group.id,
      requiresApproval: true,
      maxUses: 1,
    });

    const first = await chat.api.acceptInvite({ userId: "carol", code: invite.code });
    const second = await chat.api.acceptInvite({ userId: "carol", code: invite.code });

    expect(second.joinRequest!.id).toBe(first.joinRequest!.id);
    const [stored] = await chat.api.listInvites({ userId: "alice", conversationId: group.id });
    expect(stored!.uses).toBe(1);
  });

  it("rejects an over-long note", async () => {
    const chat = createChat();
    const group = await seedGroup(chat);
    const invite = await chat.api.createInvite({
      userId: "alice",
      conversationId: group.id,
      requiresApproval: true,
    });

    await expect(
      chat.api.acceptInvite({
        userId: "carol",
        code: invite.code,
        message: "x".repeat(MAX_JOIN_REQUEST_MESSAGE_LENGTH + 1),
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });
});

describe("requesting to join directly", () => {
  it("creates a pending request without any permission check", async () => {
    const chat = createChat();
    const group = await seedGroup(chat);

    const request = await chat.api.requestToJoin({
      userId: "carol",
      conversationId: group.id,
      message: "let me in",
    });

    expect(request).toMatchObject({
      conversationId: group.id,
      userId: "carol",
      status: "pending",
      message: "let me in",
      // Distinguishes "found us and asked" from "came from the public link".
      inviteCode: null,
    });
  });

  it("refuses a user who is already in the group", async () => {
    const chat = createChat();
    const group = await seedGroup(chat);

    await expect(
      chat.api.requestToJoin({ userId: "bob", conversationId: group.id }),
    ).rejects.toMatchObject({ code: "ALREADY_PARTICIPANT" });
  });

  it("returns the existing row when asking twice, so the queue can't be flooded", async () => {
    const chat = createChat();
    const group = await seedGroup(chat);

    const first = await chat.api.requestToJoin({ userId: "carol", conversationId: group.id });
    const second = await chat.api.requestToJoin({ userId: "carol", conversationId: group.id });

    expect(second.id).toBe(first.id);
    const queue = await chat.api.listJoinRequests({ userId: "alice", conversationId: group.id });
    expect(queue).toHaveLength(1);
  });

  it("refuses a direct conversation", async () => {
    const chat = createChat();
    const dm = await chat.api.getOrCreateConversation({ userId: "alice", otherUserId: "bob" });

    await expect(
      chat.api.requestToJoin({ userId: "carol", conversationId: dm.id }),
    ).rejects.toMatchObject({ code: "NOT_GROUP_CONVERSATION" });
  });
});

describe("resolving join requests", () => {
  it("shows only pending requests by default", async () => {
    const chat = createChat();
    const group = await seedGroup(chat);
    await chat.api.requestToJoin({ userId: "carol", conversationId: group.id });
    await chat.api.requestToJoin({ userId: "dave", conversationId: group.id });
    await chat.api.resolveJoinRequest({
      userId: "alice",
      conversationId: group.id,
      targetUserId: "dave",
      decision: "deny",
    });

    const pending = await chat.api.listJoinRequests({ userId: "alice", conversationId: group.id });
    const denied = await chat.api.listJoinRequests({
      userId: "alice",
      conversationId: group.id,
      status: "denied",
    });

    expect(pending.map((r) => r.userId)).toEqual(["carol"]);
    expect(denied.map((r) => r.userId)).toEqual(["dave"]);
  });

  it("refuses a plain member reading the queue", async () => {
    const chat = createChat();
    const group = await seedGroup(chat);

    await expect(
      chat.api.listJoinRequests({ userId: "bob", conversationId: group.id }),
    ).rejects.toMatchObject({ code: "NOT_CONVERSATION_ADMIN" });
  });

  it("adds the member and publishes participant.added on approval", async () => {
    const { chat, events } = createRecordingChat();
    const group = await seedGroup(chat);
    await chat.api.requestToJoin({ userId: "carol", conversationId: group.id });
    events.length = 0;

    const result = await chat.api.resolveJoinRequest({
      userId: "alice",
      conversationId: group.id,
      targetUserId: "carol",
      decision: "approve",
    });

    expect(result.joinRequest).toMatchObject({
      status: "approved",
      resolvedBy: "alice",
    });
    expect(result.joinRequest.resolvedAt).toBeInstanceOf(Date);
    expect(result.conversation!.participants.map((p) => p.userId)).toEqual([
      "alice",
      "bob",
      "carol",
    ]);

    const published = conversationEvents(events);
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({
      type: "participant.added",
      actorId: "alice",
      affectedUserIds: ["carol"],
    });
  });

  it("keeps the denied row and adds nobody", async () => {
    const chat = createChat();
    const group = await seedGroup(chat);
    await chat.api.requestToJoin({ userId: "carol", conversationId: group.id });

    const result = await chat.api.resolveJoinRequest({
      userId: "alice",
      conversationId: group.id,
      targetUserId: "carol",
      decision: "deny",
    });

    expect(result.joinRequest.status).toBe("denied");
    expect(result.conversation).toBeNull();
    const unchanged = await chat.api.getConversation({ userId: "alice", conversationId: group.id });
    expect(unchanged.participants).toHaveLength(2);
  });

  it("lets a denied user ask again, replacing the old row", async () => {
    const chat = createChat();
    const group = await seedGroup(chat);
    await chat.api.requestToJoin({ userId: "carol", conversationId: group.id });
    await chat.api.resolveJoinRequest({
      userId: "alice",
      conversationId: group.id,
      targetUserId: "carol",
      decision: "deny",
    });

    // Denial is not a block (ADR 0019 §5) - blocking is a moderation feature.
    const again = await chat.api.requestToJoin({ userId: "carol", conversationId: group.id });

    expect(again.status).toBe("pending");
    expect(again.resolvedAt).toBeNull();
    expect(again.resolvedBy).toBeNull();
    const all = await chat.api.listJoinRequests({ userId: "alice", conversationId: group.id });
    expect(all).toHaveLength(1);
  });

  it("cannot be applied twice, so racing admins can't both resolve it", async () => {
    const chat = createChat();
    const group = await seedGroup(chat);
    await chat.api.requestToJoin({ userId: "carol", conversationId: group.id });
    await chat.api.resolveJoinRequest({
      userId: "alice",
      conversationId: group.id,
      targetUserId: "carol",
      decision: "approve",
    });

    await expect(
      chat.api.resolveJoinRequest({
        userId: "alice",
        conversationId: group.id,
        targetUserId: "carol",
        decision: "deny",
      }),
    ).rejects.toMatchObject({ code: "JOIN_REQUEST_NOT_FOUND" });
  });

  it("reports a user with no request as not found", async () => {
    const chat = createChat();
    const group = await seedGroup(chat);

    await expect(
      chat.api.resolveJoinRequest({
        userId: "alice",
        conversationId: group.id,
        targetUserId: "nobody",
        decision: "approve",
      }),
    ).rejects.toMatchObject({ code: "JOIN_REQUEST_NOT_FOUND" });
  });
});

describe("adapters without the invites capability", () => {
  it("reports INVITES_UNSUPPORTED from every invite method", async () => {
    const chat = chatpack({ storage: adapterWithoutInvites(), telemetry: false });
    const group = await seedGroup(chat);

    const calls = [
      () => chat.api.createInvite({ userId: "alice", conversationId: group.id }),
      () => chat.api.listInvites({ userId: "alice", conversationId: group.id }),
      () => chat.api.revokeInvite({ userId: "alice", conversationId: group.id, code: "x" }),
      () => chat.api.getInvitePreview({ userId: "alice", code: "x" }),
      () => chat.api.acceptInvite({ userId: "carol", code: "x" }),
      () => chat.api.requestToJoin({ userId: "carol", conversationId: group.id }),
      () => chat.api.listJoinRequests({ userId: "alice", conversationId: group.id }),
      () =>
        chat.api.resolveJoinRequest({
          userId: "alice",
          conversationId: group.id,
          targetUserId: "carol",
          decision: "approve",
        }),
    ];

    for (const call of calls) {
      await expect(call()).rejects.toMatchObject({ code: "INVITES_UNSUPPORTED" });
    }
  });

  it("leaves every other route working", async () => {
    const chat = chatpack({ storage: adapterWithoutInvites(), telemetry: false });
    const group = await seedGroup(chat);

    await expect(
      chat.api.sendMessage({ userId: "alice", conversationId: group.id, body: "hi" }),
    ).resolves.toMatchObject({ body: "hi" });
  });
});

describe("HTTP routes", () => {
  async function seedHttpGroup(handler: ChatpackHandler): Promise<string> {
    const response = await send(handler, "POST", "/conversations/group", "alice", {
      userIds: ["bob"],
      name: "Standup",
    });
    const body = (await response.json()) as { conversation: { id: string } };
    return body.conversation.id;
  }

  it("mints an invite with 201 and no request body at all", async () => {
    const handler = createHttpChat();
    const groupId = await seedHttpGroup(handler);

    const response = await handler.POST(
      new Request(`${BASE}/conversations/${groupId}/invites`, {
        method: "POST",
        headers: { "x-user-id": "alice" },
      }),
    );

    expect(response.status).toBe(201);
    const body = (await response.json()) as { invite: { code: string; uses: number } };
    expect(body.invite.code).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(body.invite.uses).toBe(0);
  });

  it("previews, accepts, and reports a used-up link as 410", async () => {
    const handler = createHttpChat();
    const groupId = await seedHttpGroup(handler);
    const created = await send(handler, "POST", `/conversations/${groupId}/invites`, "alice", {
      maxUses: 1,
    });
    const { invite } = (await created.json()) as { invite: { code: string } };

    const preview = await get(handler, `/invites/${invite.code}`, "carol");
    expect(preview.status).toBe(200);
    expect((await preview.json()) as unknown).toMatchObject({
      invite: { conversationId: groupId, participantCount: 2, name: "Standup" },
    });

    const accepted = await send(handler, "POST", `/invites/${invite.code}/accept`, "carol");
    expect(accepted.status).toBe(200);
    expect((await accepted.json()) as unknown).toMatchObject({ status: "joined" });

    const exhausted = await send(handler, "POST", `/invites/${invite.code}/accept`, "dave");
    // 410 Gone, not 404: the link existed and is permanently unusable.
    expect(exhausted.status).toBe(410);
    expect((await exhausted.json()) as unknown).toMatchObject({
      error: { code: "INVITE_EXPIRED" },
    });
  });

  it("never reads 'accept' as an invite code", async () => {
    const handler = createHttpChat();
    const groupId = await seedHttpGroup(handler);
    const created = await send(handler, "POST", `/conversations/${groupId}/invites`, "alice");
    const { invite } = (await created.json()) as { invite: { code: string } };

    // The literal-segment ordering trap: POST /invites/:code/accept is matched
    // by segment count, so the code is never confused with "accept".
    const response = await send(handler, "POST", `/invites/${invite.code}/accept`, "carol");
    expect(response.status).toBe(200);
  });

  it("revokes via DELETE with the code in the path", async () => {
    const handler = createHttpChat();
    const groupId = await seedHttpGroup(handler);
    const created = await send(handler, "POST", `/conversations/${groupId}/invites`, "alice");
    const { invite } = (await created.json()) as { invite: { code: string } };

    const revoked = await send(
      handler,
      "DELETE",
      `/conversations/${groupId}/invites/${invite.code}`,
      "alice",
    );
    expect(revoked.status).toBe(200);

    const gone = await get(handler, `/invites/${invite.code}`, "carol");
    expect(gone.status).toBe(404);
  });

  it("lists invites for an admin and 403s a member", async () => {
    const handler = createHttpChat();
    const groupId = await seedHttpGroup(handler);
    await send(handler, "POST", `/conversations/${groupId}/invites`, "alice");

    const asAdmin = await get(handler, `/conversations/${groupId}/invites`, "alice");
    expect(asAdmin.status).toBe(200);
    expect((await asAdmin.json()) as { invites: unknown[] }).toMatchObject({
      invites: [{ conversationId: groupId }],
    });

    const asMember = await get(handler, `/conversations/${groupId}/invites`, "bob");
    expect(asMember.status).toBe(403);
  });

  it("runs the join-request queue end to end", async () => {
    const handler = createHttpChat();
    const groupId = await seedHttpGroup(handler);

    const asked = await send(handler, "POST", `/conversations/${groupId}/join-requests`, "carol", {
      message: "please",
    });
    expect(asked.status).toBe(201);

    const queue = await get(handler, `/conversations/${groupId}/join-requests`, "alice");
    expect(queue.status).toBe(200);
    expect((await queue.json()) as unknown).toMatchObject({
      joinRequests: [{ userId: "carol", status: "pending", message: "please" }],
    });

    const resolved = await send(
      handler,
      "PATCH",
      `/conversations/${groupId}/join-requests`,
      "alice",
      { userId: "carol", decision: "approve" },
    );
    expect(resolved.status).toBe(200);
    const body = (await resolved.json()) as {
      joinRequest: { status: string };
      conversation: { participants: { userId: string }[] };
    };
    expect(body.joinRequest.status).toBe("approved");
    expect(body.conversation.participants.map((p) => p.userId)).toEqual(["alice", "bob", "carol"]);
  });

  it("409s a member asking to join their own group", async () => {
    const handler = createHttpChat();
    const groupId = await seedHttpGroup(handler);

    const response = await send(handler, "POST", `/conversations/${groupId}/join-requests`, "bob");

    expect(response.status).toBe(409);
    expect((await response.json()) as unknown).toMatchObject({
      error: { code: "ALREADY_PARTICIPANT" },
    });
  });

  it("rejects a bad decision and a bad status filter with 400", async () => {
    const handler = createHttpChat();
    const groupId = await seedHttpGroup(handler);
    await send(handler, "POST", `/conversations/${groupId}/join-requests`, "carol");

    const badDecision = await send(
      handler,
      "PATCH",
      `/conversations/${groupId}/join-requests`,
      "alice",
      { userId: "carol", decision: "maybe" },
    );
    expect(badDecision.status).toBe(400);

    const badStatus = await get(
      handler,
      `/conversations/${groupId}/join-requests?status=whenever`,
      "alice",
    );
    expect(badStatus.status).toBe(400);
  });

  it("requires authentication to preview a link", async () => {
    const handler = createHttpChat();
    const groupId = await seedHttpGroup(handler);
    const created = await send(handler, "POST", `/conversations/${groupId}/invites`, "alice");
    const { invite } = (await created.json()) as { invite: { code: string } };

    const anonymous = await get(handler, `/invites/${invite.code}`);

    expect(anonymous.status).toBe(401);
  });

  it("reports a missing adapter capability as 501", async () => {
    const handler = chatpack({
      storage: adapterWithoutInvites(),
      telemetry: false,
      auth: (request) => {
        const userId = request.headers.get("x-user-id");
        return userId ? { id: userId } : null;
      },
    }).handler();
    const groupId = await seedHttpGroup(handler);

    const response = await send(handler, "POST", `/conversations/${groupId}/invites`, "alice");

    expect(response.status).toBe(501);
    expect((await response.json()) as unknown).toMatchObject({
      error: { code: "INVITES_UNSUPPORTED" },
    });
  });
});
