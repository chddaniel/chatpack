import { createPool, type Pool } from "mysql2/promise";
import type { RowDataPacket } from "mysql2";
import { drizzle } from "drizzle-orm/mysql2";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { chatpack, type ChatpackInstance } from "@chatpack/core";
import {
  backfillMessageSearchTokens,
  migrationSql,
  migrationStatements,
  mysqlAdapter,
  type DrizzleMysqlDatabase,
} from "../src/index";
import { messageSearchTokens } from "../src/schema";

const url = process.env.CHATPACK_MYSQL_URL;
const mysql = describe.skipIf(!url);
let pool: Pool;
let db: DrizzleMysqlDatabase;
let chat: ChatpackInstance;
let storage: ReturnType<typeof mysqlAdapter>;

beforeAll(async () => {
  if (!url) return;
  pool = createPool(url);
  for (const statement of migrationStatements) await pool.query(statement);
  db = drizzle(pool) as DrizzleMysqlDatabase;
  storage = mysqlAdapter(db);
  chat = chatpack({
    storage,
    telemetry: false,
    moderation: { canModerate: ({ user }) => user.id === "alice" },
  });
});

beforeEach(async () => {
  if (!url) return;
  await pool.query("SET FOREIGN_KEY_CHECKS = 0");
  for (const table of [
    "chatpack_message_search_tokens",
    "chatpack_message_mentions",
    "chatpack_message_reactions",
    "chatpack_messages",
    "chatpack_join_requests",
    "chatpack_conversation_invites",
    "chatpack_conversation_participants",
    "chatpack_conversation_mutes",
    "chatpack_user_blocks",
    "chatpack_moderation_reports",
    "chatpack_user_bans",
    "chatpack_conversations",
  ])
    await pool.query(`DELETE FROM ${table}`);
  await pool.query("SET FOREIGN_KEY_CHECKS = 1");
});

afterAll(async () => {
  if (pool) await pool.end();
});

mysql("MySQL 8 migrations", () => {
  it("applies one statement at a time and reruns on a compatible schema", async () => {
    for (const statement of migrationStatements) await pool.query(statement);
    expect(migrationStatements.map((statement) => `${statement};`).join("\n\n") + "\n").toBe(
      migrationSql,
    );
    const [rows] = await pool.query<(RowDataPacket & { TABLE_NAME: string })[]>(
      "SELECT TABLE_NAME FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name LIKE 'chatpack_%'",
    );
    expect(rows).toHaveLength(12);
  });
});

mysql("MySQL 8 storage", () => {
  it("converges concurrent DMs and gives concurrent messages strict sequences", async () => {
    const conversations = await Promise.all(
      Array.from({ length: 12 }, () =>
        chat.api.getOrCreateConversation({ userId: "alice", otherUserId: "bob" }),
      ),
    );
    expect(new Set(conversations.map((conversation) => conversation.id)).size).toBe(1);
    const sent = await Promise.all(
      Array.from({ length: 24 }, (_, index) =>
        chat.api.sendMessage({
          userId: "alice",
          conversationId: conversations[0]!.id,
          body: `message ${index}`,
        }),
      ),
    );
    expect(sent.map((message) => message.seq).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 24 }, (_, index) => index + 1),
    );
    expect(sent.every((message) => message.createdAt instanceof Date)).toBe(true);
  });

  it("keeps group creation atomic and participant adds idempotent", async () => {
    const group = await chat.api.createGroupConversation({
      userId: "alice",
      userIds: ["bob"],
      name: "MySQL",
      visibility: "public",
      joinPolicy: "open",
    });
    const secondGroup = await chat.api.createGroupConversation({
      userId: "alice",
      userIds: ["bob"],
      name: "MySQL again",
      visibility: "private",
      joinPolicy: "approval",
    });
    expect(secondGroup.id).not.toBe(group.id);
    expect(group.participants.map((participant) => participant.userId)).toEqual(["alice", "bob"]);
    const updated = await storage.addParticipants({
      conversationId: group.id,
      userIds: ["alice", "bob", "carol"],
    });
    expect(updated.participants.find((participant) => participant.userId === "alice")?.role).toBe(
      "admin",
    );
    expect(updated.participants.map((participant) => participant.userId).sort()).toEqual([
      "alice",
      "bob",
      "carol",
    ]);
    const message = await chat.api.sendMessage({
      userId: "alice",
      conversationId: group.id,
      body: "mysql search token",
      mentions: ["bob"],
    });
    expect(message.mentions).toEqual(["bob"]);
    await chat.api.editMessage({
      userId: "alice",
      messageId: message.id,
      body: "mysql edited",
      mentions: [],
    });
    expect(await storage.listMentionsByMessageIds([message.id])).toEqual([]);
    await chat.api.addReaction({ userId: "bob", messageId: message.id, emoji: "👍" });
    await chat.api.addReaction({ userId: "bob", messageId: message.id, emoji: "👍" });
    expect(await storage.listReactionsByMessageIds([message.id])).toHaveLength(1);
  });

  it("searches and backfills tokens, including deterministic cursor pages", async () => {
    const conversation = await chat.api.getOrCreateConversation({
      userId: "alice",
      otherUserId: "bob",
    });
    const messages = await Promise.all(
      ["mysql alpha", "mysql beta", "mysql gamma"].map((body) =>
        chat.api.sendMessage({ userId: "alice", conversationId: conversation.id, body }),
      ),
    );
    await db.delete(messageSearchTokens);
    await backfillMessageSearchTokens(db);
    const first = await chat.api.searchMessages({ userId: "bob", query: "mysql", limit: 2 });
    expect(first.messages).toHaveLength(2);
    const second = await chat.api.searchMessages({
      userId: "bob",
      query: "mysql",
      limit: 2,
      cursor: first.nextCursor!,
    });
    expect(new Set([...first.messages, ...second.messages].map((message) => message.id))).toEqual(
      new Set(messages.map((message) => message.id)),
    );
  });

  it("caps invite uses atomically and resets join-request resolution", async () => {
    const group = await chat.api.createGroupConversation({
      userId: "alice",
      userIds: [],
      name: "Invites",
      visibility: "public",
      joinPolicy: "open",
    });
    const invite = await chat.api.createInvite({
      userId: "alice",
      conversationId: group.id,
      maxUses: 1,
    });
    const consumed = await Promise.all([
      storage.invites!.consumeInvite(invite.code),
      storage.invites!.consumeInvite(invite.code),
    ]);
    expect(consumed.filter(Boolean)).toHaveLength(1);
    const request = await storage.invites!.createJoinRequest({
      conversationId: group.id,
      userId: "bob",
      message: "first",
      inviteCode: invite.code,
      metadata: {},
    });
    await storage.invites!.resolveJoinRequest({
      conversationId: group.id,
      userId: "bob",
      status: "denied",
      resolvedBy: "alice",
      resolvedAt: new Date(),
    });
    const again = await storage.invites!.createJoinRequest({
      conversationId: group.id,
      userId: "bob",
      message: "again",
      inviteCode: null,
      metadata: { retry: true },
    });
    expect(again.id).toBe(request.id);
    expect(again.status).toBe("pending");
    expect(again.resolvedAt).toBeNull();
    expect(again.resolvedBy).toBeNull();
  });

  it("serializes active bans and keeps moderation operations idempotent", async () => {
    const bans = await Promise.all(
      Array.from({ length: 8 }, () =>
        storage.moderation!.createBan({
          userId: "mallory",
          createdByUserId: "alice",
          reason: "abuse",
          expiresAt: null,
        }),
      ),
    );
    expect(new Set(bans.map((ban) => ban.id)).size).toBe(1);
    const block = await storage.moderation!.createBlock({
      blockerUserId: "alice",
      blockedUserId: "mallory",
    });
    await storage.moderation!.removeBlock({ blockerUserId: "alice", blockedUserId: "mallory" });
    await storage.moderation!.removeBlock({ blockerUserId: "alice", blockedUserId: "mallory" });
    expect(block.createdAt).toBeInstanceOf(Date);
  });
});
