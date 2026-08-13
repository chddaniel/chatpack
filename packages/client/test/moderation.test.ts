import { describe, expect, it } from "vitest";
import { memoryAdapter } from "@chatpack/adapter-memory";
import { chatpack, type ChatpackHandler } from "@chatpack/core";
import { createChatClient } from "../src";

function clientFor(handler: ChatpackHandler, userId: string) {
  return createChatClient({
    fetch: async (input, init) => {
      const requestURL = new URL(input instanceof Request ? input.url : input);
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

function moderationHandler() {
  const chat = chatpack({
    storage: memoryAdapter(),
    telemetry: false,
    moderation: { canModerate: ({ user }) => user.id === "mod" },
    auth: (request) => {
      const userId = request.headers.get("x-user-id");
      return userId === null ? null : { id: userId };
    },
  });
  return chat.handler({ heartbeatIntervalMs: 0 });
}

describe("moderation client routes", () => {
  it("covers blocks, mutes, reports, and moderator bans end to end", async () => {
    const handler = moderationHandler();
    const alice = clientFor(handler, "alice");
    const moderator = clientFor(handler, "mod");

    const conversation = await alice.conversations.create({ otherUserId: "bob" });
    expect(conversation.error).toBeNull();
    if (conversation.error !== null) return;

    const sent = await alice.messages.send({
      conversationId: conversation.data.id,
      body: "reported message",
    });
    expect(sent.error).toBeNull();
    if (sent.error !== null) return;

    const blockBob = await alice.moderation.blockUser({ targetUserId: "bob" });
    expect(blockBob).toMatchObject({
      error: null,
      data: { blockerUserId: "alice", blockedUserId: "bob" },
    });
    if (blockBob.error !== null) return;
    expect(typeof blockBob.data.createdAt).toBe("string");

    const blockCarol = await alice.moderation.blockUser({ targetUserId: "carol" });
    expect(blockCarol.error).toBeNull();
    const firstBlockPage = await alice.moderation.listBlockedUsers({ limit: 1 });
    expect(firstBlockPage.error).toBeNull();
    if (firstBlockPage.error !== null) return;
    expect(firstBlockPage.data.blocks).toHaveLength(1);
    expect(firstBlockPage.data.nextCursor).toEqual(expect.any(String));
    const secondBlockPage = await alice.moderation.listBlockedUsers({
      limit: 1,
      cursor: firstBlockPage.data.nextCursor!,
    });
    expect(secondBlockPage).toMatchObject({
      error: null,
      data: { blocks: [{ blockedUserId: "bob" }] },
    });

    const unblocked = await alice.moderation.unblockUser({ targetUserId: "bob" });
    expect(unblocked).toEqual({ data: { ok: true }, error: null });

    const muted = await alice.moderation.muteConversation({
      conversationId: conversation.data.id,
    });
    expect(muted).toMatchObject({
      error: null,
      data: { userId: "alice", conversationId: conversation.data.id },
    });
    const mutedPage = await alice.moderation.listMutedConversations();
    expect(mutedPage).toMatchObject({
      error: null,
      data: { mutes: [{ conversationId: conversation.data.id }], nextCursor: null },
    });
    const unmuted = await alice.moderation.unmuteConversation({
      conversationId: conversation.data.id,
    });
    expect(unmuted).toEqual({ data: { ok: true }, error: null });

    const report = await alice.moderation.report({
      targetType: "message",
      targetId: sent.data.id,
      reason: "harassment",
    });
    expect(report).toMatchObject({
      error: null,
      data: { targetType: "message", targetId: sent.data.id, status: "open" },
    });
    if (report.error !== null) return;
    expect(report.data.evidence).toMatchObject({
      targetType: "message",
      messageId: sent.data.id,
      body: "reported message",
    });

    const queue = await moderator.moderation.listReports({
      status: "open",
      targetType: "message",
      limit: 10,
    });
    expect(queue).toMatchObject({ error: null, data: { reports: [{ id: report.data.id }] } });
    const loaded = await moderator.moderation.getReport({ reportId: report.data.id });
    expect(loaded).toMatchObject({ error: null, data: { evidence: report.data.evidence } });
    const triaged = await moderator.moderation.updateReport({
      reportId: report.data.id,
      status: "triaged",
      moderatorNote: "reviewed",
    });
    expect(triaged).toMatchObject({
      error: null,
      data: { status: "triaged", moderatorNote: "reviewed" },
    });

    const ban = await moderator.moderation.banUser({
      targetUserId: "bob",
      reason: "repeat abuse",
      expiresAt: null,
    });
    expect(ban).toMatchObject({
      error: null,
      data: { userId: "bob", reason: "repeat abuse", expiresAt: null, revokedAt: null },
    });
    if (ban.error !== null) return;
    const activeBans = await moderator.moderation.listBans({ activeOnly: true });
    expect(activeBans).toMatchObject({ error: null, data: { bans: [{ id: ban.data.id }] } });

    const bannedClient = clientFor(handler, "bob");
    const banned = await bannedClient.moderation.listMutedConversations();
    expect(banned).toMatchObject({
      data: null,
      error: { code: "USER_BANNED", status: 403 },
    });

    const revoked = await moderator.moderation.unbanUser({ banId: ban.data.id });
    expect(revoked).toMatchObject({
      error: null,
      data: { id: ban.data.id, revokedByUserId: "mod" },
    });
  });

  it("keeps moderator and capability failures structured", async () => {
    const handler = moderationHandler();
    const alice = clientFor(handler, "alice");
    const selfBlock = await alice.moderation.blockUser({ targetUserId: "alice" });
    expect(selfBlock).toMatchObject({
      data: null,
      error: { code: "INVALID_INPUT", status: 400 },
    });
    const block = await alice.moderation.blockUser({ targetUserId: "bob" });
    expect(block.error).toBeNull();
    const blockedConversation = await alice.conversations.create({ otherUserId: "bob" });
    expect(blockedConversation).toMatchObject({
      data: null,
      error: { code: "DIRECT_INTERACTION_BLOCKED", status: 403 },
    });

    const missingReport = await alice.moderation.listReports();
    expect(missingReport).toEqual({
      data: null,
      error: { code: "NOT_MODERATOR", message: expect.any(String), status: 403 },
    });

    const moderator = clientFor(handler, "mod");
    const notFoundReport = await moderator.moderation.getReport({ reportId: "missing" });
    expect(notFoundReport).toMatchObject({
      data: null,
      error: { code: "REPORT_NOT_FOUND", status: 404 },
    });
    const notFoundBan = await moderator.moderation.unbanUser({ banId: "missing" });
    expect(notFoundBan).toMatchObject({
      data: null,
      error: { code: "BAN_NOT_FOUND", status: 404 },
    });

    const storage = memoryAdapter();
    const { moderation: _moderation, ...withoutModeration } = storage;
    const unsupportedChat = chatpack({
      storage: withoutModeration,
      telemetry: false,
      auth: (request) => {
        const userId = request.headers.get("x-user-id");
        return userId === null ? null : { id: userId };
      },
    });
    const unsupported = await clientFor(
      unsupportedChat.handler({ heartbeatIntervalMs: 0 }),
      "alice",
    ).moderation.listBlockedUsers();
    expect(unsupported).toMatchObject({
      data: null,
      error: { code: "MODERATION_UNSUPPORTED", status: 501 },
    });
  });
});

describe("moderation client response validation", () => {
  it("returns structured invalid-response errors for malformed envelopes", async () => {
    const badPage = createChatClient({
      fetch: async () =>
        new Response(JSON.stringify({ mutes: [], nextCursor: 42 }), { status: 200 }),
    });
    const page = await badPage.moderation.listMutedConversations();
    expect(page).toMatchObject({
      data: null,
      error: { code: "INVALID_RESPONSE", status: null },
    });

    const badOk = createChatClient({
      fetch: async () => new Response(JSON.stringify({ ok: false }), { status: 200 }),
    });
    const result = await badOk.moderation.unmuteConversation({ conversationId: "c1" });
    expect(result).toMatchObject({
      data: null,
      error: { code: "INVALID_RESPONSE", status: null },
    });
  });
});
