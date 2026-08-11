import { describe, expect, it } from "vitest";

import { chatpack } from "@chatpack/core";
import { memoryAdapter } from "../src/index";

function createChat() {
  return chatpack({
    storage: memoryAdapter(),
    telemetry: false,
    moderation: { canModerate: ({ user }) => user.id === "staff" },
  });
}

describe("moderation", () => {
  it("blocks new direct interaction but keeps existing history readable", async () => {
    const chat = createChat();
    const direct = await chat.api.getOrCreateConversation({ userId: "alice", otherUserId: "bob" });
    await chat.api.sendMessage({ userId: "alice", conversationId: direct.id, body: "before" });

    const block = await chat.api.moderation.blockUser({ userId: "alice", targetUserId: "bob" });
    expect(block.blockedUserId).toBe("bob");
    await expect(
      chat.api.getOrCreateConversation({ userId: "bob", otherUserId: "alice" }),
    ).rejects.toMatchObject({ code: "DIRECT_INTERACTION_BLOCKED" });
    await expect(
      chat.api.sendMessage({ userId: "bob", conversationId: direct.id, body: "after" }),
    ).rejects.toMatchObject({ code: "DIRECT_INTERACTION_BLOCKED" });

    const history = await chat.api.listMessages({ userId: "bob", conversationId: direct.id });
    expect(history.messages.map((message) => message.body)).toEqual(["before"]);

    await chat.api.moderation.blockUser({ userId: "bob", targetUserId: "carol" });
    await chat.api.moderation.blockUser({ userId: "bob", targetUserId: "carol" });
    expect((await chat.api.moderation.listBlockedUsers({ userId: "bob" })).blocks).toHaveLength(1);
  });

  it("does not apply user blocks inside shared groups", async () => {
    const chat = createChat();
    const group = await chat.api.createGroupConversation({
      userId: "alice",
      userIds: ["bob"],
      name: "team",
    });
    await chat.api.moderation.blockUser({ userId: "alice", targetUserId: "bob" });
    const message = await chat.api.sendMessage({
      userId: "bob",
      conversationId: group.id,
      body: "group message",
    });
    expect(message.body).toBe("group message");
  });

  it("persists mutes, reports evidence, workflow, and bans", async () => {
    const chat = createChat();
    const direct = await chat.api.getOrCreateConversation({ userId: "alice", otherUserId: "bob" });
    const message = await chat.api.sendMessage({
      userId: "bob",
      conversationId: direct.id,
      body: "abuse",
    });

    const mute = await chat.api.moderation.muteConversation({
      userId: "alice",
      conversationId: direct.id,
    });
    expect(mute.conversationId).toBe(direct.id);
    expect(
      (await chat.api.moderation.listMutedConversations({ userId: "alice" })).mutes,
    ).toHaveLength(1);

    const report = await chat.api.moderation.report({
      userId: "alice",
      targetType: "message",
      targetId: message.id,
      reason: "abuse",
    });
    expect(report.evidence).toMatchObject({
      targetType: "message",
      body: "abuse",
      senderId: "bob",
    });
    const duplicate = await chat.api.moderation.report({
      userId: "alice",
      targetType: "message",
      targetId: message.id,
      reason: "same report",
    });
    expect(duplicate.id).toBe(report.id);

    const triaged = await chat.api.moderation.updateReport({
      userId: "staff",
      reportId: report.id,
      status: "triaged",
      moderatorNote: "queued",
    });
    expect(triaged.status).toBe("triaged");
    await expect(chat.api.moderation.listReports({ userId: "alice" })).rejects.toMatchObject({
      code: "NOT_MODERATOR",
    });

    const ban = await chat.api.moderation.banUser({
      userId: "staff",
      targetUserId: "bob",
      reason: "abuse",
    });
    expect(ban.userId).toBe("bob");
    await expect(chat.api.listConversations({ userId: "bob" })).rejects.toMatchObject({
      code: "USER_BANNED",
    });
    const unbanned = await chat.api.moderation.unbanUser({ userId: "staff", banId: ban.id });
    expect(unbanned.revokedByUserId).toBe("staff");
    await expect(chat.api.listConversations({ userId: "bob" })).resolves.toBeDefined();
  });
});
