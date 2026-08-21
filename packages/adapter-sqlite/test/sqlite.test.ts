import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { chatpack, type ChatpackInstance } from "@chatpack/core";
import {
  migrationSql,
  migrationStatements,
  sqliteAdapter,
  type DrizzleSqliteDatabase,
} from "../src/index";

let database: Database.Database;
let db: DrizzleSqliteDatabase;
let chat: ChatpackInstance;

beforeEach(() => {
  database = new Database(":memory:");
  database.exec(migrationSql);
  db = drizzle(database) as DrizzleSqliteDatabase;
  chat = chatpack({
    storage: sqliteAdapter(db),
    telemetry: false,
    moderation: { canModerate: ({ user }) => user.id === "alice" },
  });
});

afterEach(() => {
  database.close();
});

describe("SQLite migrations", () => {
  it("supports one-statement application and stays idempotent", () => {
    const fresh = new Database(":memory:");
    try {
      for (const statement of migrationStatements) fresh.exec(statement);
      fresh.exec(migrationSql);
      const tables = fresh
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'chatpack_%' ORDER BY name",
        )
        .all() as { name: string }[];
      expect(tables).toHaveLength(12);
      expect(migrationStatements.map((statement) => `${statement};`).join("\n\n") + "\n").toBe(
        migrationSql,
      );
    } finally {
      fresh.close();
    }
  });
});

describe("SQLite storage", () => {
  it("persists direct conversations, metadata, ordered messages, edits, and tombstones", async () => {
    const conversation = await chat.api.getOrCreateConversation({
      userId: "alice",
      otherUserId: "bob",
      metadata: { topic: "support", nested: { priority: 2 } },
    });
    const again = await chat.api.getOrCreateConversation({
      userId: "bob",
      otherUserId: "alice",
      metadata: { topic: "changed" },
    });
    expect(again.id).toBe(conversation.id);
    expect(again.metadata).toEqual({ topic: "support", nested: { priority: 2 } });

    const sent = await Promise.all(
      ["one", "two", "three"].map((body) =>
        chat.api.sendMessage({ userId: "alice", conversationId: conversation.id, body }),
      ),
    );
    expect(sent.map((message) => message.seq).sort((a, b) => a - b)).toEqual([1, 2, 3]);
    expect(sent.every((message) => message.createdAt instanceof Date)).toBe(true);

    const page = await chat.api.listMessages({
      userId: "bob",
      conversationId: conversation.id,
      limit: 2,
    });
    expect(page.messages.map((message) => message.body)).toEqual(["three", "two"]);
    const next = await chat.api.listMessages({
      userId: "bob",
      conversationId: conversation.id,
      limit: 2,
      cursor: page.nextCursor!,
    });
    expect(next.messages.map((message) => message.body)).toEqual(["one"]);

    const edited = await chat.api.editMessage({
      userId: "alice",
      messageId: sent[0]!.id,
      body: "ONE",
    });
    expect(edited.body).toBe("ONE");
    const deleted = await chat.api.deleteMessage({ userId: "alice", messageId: sent[1]!.id });
    expect(deleted.body).toBe("");
    expect(deleted.deletedAt).toBeInstanceOf(Date);
  });

  it("supports search, reactions, groups, channels, invites, and read state", async () => {
    const group = await chat.api.createGroupConversation({
      userId: "alice",
      userIds: ["bob"],
      name: "SQLite team",
      visibility: "public",
      joinPolicy: "open",
      metadata: { purpose: "testing" },
    });
    const message = await chat.api.sendMessage({
      userId: "alice",
      conversationId: group.id,
      body: "SQLite search works",
      mentions: ["bob"],
    });
    expect(message.mentions).toEqual(["bob"]);
    const reacted = await chat.api.addReaction({
      userId: "bob",
      messageId: message.id,
      emoji: "👍",
    });
    expect(reacted.reactions).toEqual([{ emoji: "👍", count: 1, userIds: ["bob"] }]);

    const search = await chat.api.searchMessages({ userId: "bob", query: "sqlite", limit: 10 });
    expect(search.messages.map((item) => item.body)).toEqual(["SQLite search works"]);
    expect(search.messages[0]!.forwardedFrom).toBeNull();

    const invite = await chat.api.createInvite({
      userId: "alice",
      conversationId: group.id,
      maxUses: 2,
      requiresApproval: false,
    });
    expect(
      (await chat.api.getInvitePreview({ userId: "alice", code: invite.code })).conversationId,
    ).toBe(group.id);

    await chat.api.markRead({
      userId: "bob",
      conversationId: group.id,
      messageId: message.id,
    });
    expect(
      (await chat.api.getConversation({ userId: "bob", conversationId: group.id })).unreadCount,
    ).toBe(0);
  });

  it("keeps moderation state durable and idempotent", async () => {
    const block = await chat.api.moderation.blockUser({ userId: "alice", targetUserId: "bob" });
    expect(block.createdAt).toBeInstanceOf(Date);
    expect((await chat.api.moderation.listBlockedUsers({ userId: "alice" })).blocks).toHaveLength(
      1,
    );

    const ban = await chat.api.moderation.banUser({
      userId: "alice",
      targetUserId: "mallory",
      reason: "abuse",
      expiresAt: null,
    });
    expect(ban.createdAt).toBeInstanceOf(Date);
    expect((await chat.api.moderation.listBans({ userId: "alice" })).bans[0]!.id).toBe(ban.id);
    await chat.api.moderation.unbanUser({ userId: "alice", banId: ban.id });
    expect((await chat.api.moderation.listBans({ userId: "alice" })).bans).toHaveLength(0);
  });
});
