import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { chatpack, type ChatpackInstance } from "@chatpack/core";
import {
  migrationSql,
  migrationStatements,
  tursoAdapter,
  type DrizzleTursoDatabase,
} from "../src/index";

let client: Client;
let tempDir: string;
let db: DrizzleTursoDatabase;
let chat: ChatpackInstance;

beforeEach(async () => {
  tempDir = mkdtempSync(join(tmpdir(), "chatpack-turso-"));
  client = createClient({ url: "file:" + join(tempDir, "chatpack.db") });
  for (const statement of migrationStatements) await client.execute(statement);
  db = drizzle({ client }) as DrizzleTursoDatabase;
  chat = chatpack({
    storage: tursoAdapter(db),
    telemetry: false,
    moderation: { canModerate: ({ user }) => user.id === "alice" },
  });
});

afterEach(() => {
  client.close();
  rmSync(tempDir, { recursive: true, force: true });
});

describe("Turso migrations", () => {
  it("supports one-statement application and stays idempotent", async () => {
    const freshDir = mkdtempSync(join(tmpdir(), "chatpack-turso-migration-"));
    const fresh = createClient({ url: "file:" + join(freshDir, "chatpack.db") });
    try {
      for (const statement of migrationStatements) await fresh.execute(statement);
      for (const statement of migrationStatements) await fresh.execute(statement);
      expect(migrationStatements.map((statement) => statement + ";").join("\n\n") + "\n").toBe(
        migrationSql,
      );
      const tables = await fresh.execute(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'chatpack_%' ORDER BY name",
      );
      expect(tables.rows).toHaveLength(12);
    } finally {
      fresh.close();
      rmSync(freshDir, { recursive: true, force: true });
    }
  });
});

describe("Turso storage", () => {
  it("serializes mixed writes on one adapter without SQLITE_BUSY", async () => {
    const conversation = await chat.api.getOrCreateConversation({
      userId: "alice",
      otherUserId: "bob",
    });
    const seed = await chat.api.sendMessage({
      userId: "alice",
      conversationId: conversation.id,
      body: "seed",
    });

    const results = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        Promise.all([
          chat.api.sendMessage({
            userId: "alice",
            conversationId: conversation.id,
            body: "message " + index,
          }),
          chat.api.addReaction({ userId: "bob", messageId: seed.id, emoji: "👍" }),
          chat.api.markRead({
            userId: "bob",
            conversationId: conversation.id,
            messageId: seed.id,
          }),
        ]),
      ),
    );

    expect(results).toHaveLength(20);
  });

  it("persists direct conversations, ordered messages, edits, and search", async () => {
    const conversation = await chat.api.getOrCreateConversation({
      userId: "alice",
      otherUserId: "bob",
      metadata: { topic: "support" },
    });
    const again = await chat.api.getOrCreateConversation({
      userId: "bob",
      otherUserId: "alice",
      metadata: { topic: "changed" },
    });
    expect(again.id).toBe(conversation.id);
    expect(again.metadata).toEqual({ topic: "support" });
    const concurrent = await Promise.all(
      Array.from({ length: 3 }, () =>
        chat.api.getOrCreateConversation({ userId: "alice", otherUserId: "bob" }),
      ),
    );
    expect(new Set(concurrent.map((item) => item.id)).size).toBe(1);

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

    const edited = await chat.api.editMessage({
      userId: "alice",
      messageId: sent[0]!.id,
      body: "ONE",
    });
    expect(edited.body).toBe("ONE");
    expect(
      (await chat.api.searchMessages({ userId: "bob", query: "one", limit: 10 })).messages,
    ).toHaveLength(1);
  });

  it("supports groups, mentions, reactions, invites, read state, and moderation", async () => {
    const group = await chat.api.createGroupConversation({
      userId: "alice",
      userIds: ["bob"],
      name: "Turso team",
      visibility: "public",
      joinPolicy: "open",
    });
    const message = await chat.api.sendMessage({
      userId: "alice",
      conversationId: group.id,
      body: "Turso search works",
      mentions: ["bob"],
    });
    expect(message.mentions).toEqual(["bob"]);
    expect(
      (await chat.api.addReaction({ userId: "bob", messageId: message.id, emoji: "👍" })).reactions,
    ).toEqual([{ emoji: "👍", count: 1, userIds: ["bob"] }]);

    const invite = await chat.api.createInvite({
      userId: "alice",
      conversationId: group.id,
      maxUses: 2,
    });
    expect(
      (await chat.api.getInvitePreview({ userId: "alice", code: invite.code })).conversationId,
    ).toBe(group.id);
    await chat.api.markRead({ userId: "bob", conversationId: group.id, messageId: message.id });
    expect(
      (await chat.api.getConversation({ userId: "bob", conversationId: group.id })).unreadCount,
    ).toBe(0);

    const block = await chat.api.moderation.blockUser({
      userId: "alice",
      targetUserId: "mallory",
    });
    expect(block.createdAt).toBeInstanceOf(Date);
  });
});
