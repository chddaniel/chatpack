/**
 * M4 integration suite: the core engine running on real Postgres.
 *
 * Uses PGlite - actual Postgres compiled to WASM, in-process - so these tests
 * exercise real SQL semantics (unique indexes, ON CONFLICT, atomic UPDATE ...
 * RETURNING) with zero external setup, locally and in CI.
 *
 * M4 DoD (MVP §11): "example app runs on Postgres." The full engine test here
 * is the strong version of that; the example server's Postgres mode is the
 * demo version.
 */
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { chatpack, ChatpackError, type ChatpackInstance } from "@chatpack/core";
import {
  backfillMessageSearchTokens,
  drizzleAdapter,
  migrationSql,
  migrationStatements,
  type DrizzlePgDatabase,
} from "../src/index";

let pglite: PGlite;
let db: DrizzlePgDatabase;
let chat: ChatpackInstance;

beforeEach(async () => {
  pglite = new PGlite();
  await pglite.exec(migrationSql);
  db = drizzle(pglite) as unknown as DrizzlePgDatabase;
  chat = chatpack({ storage: drizzleAdapter(db), telemetry: false });
});

afterEach(async () => {
  await pglite.close();
});

describe("migrationStatements (single-statement drivers, e.g. Neon HTTP)", () => {
  it("running each statement individually yields a schema equivalent to migrationSql", async () => {
    const fresh = new PGlite();
    try {
      // Simulate a driver that only accepts one statement per call.
      for (const statement of migrationStatements) {
        await fresh.query(statement);
      }
      // Both paths must be idempotent and interchangeable.
      await fresh.exec(migrationSql);

      const freshDb = drizzle(fresh) as unknown as DrizzlePgDatabase;
      const freshChat = chatpack({ storage: drizzleAdapter(freshDb), telemetry: false });
      const conversation = await freshChat.api.getOrCreateConversation({
        userId: "alice",
        otherUserId: "bob",
      });
      const message = await freshChat.api.sendMessage({
        userId: "alice",
        conversationId: conversation.id,
        body: "hello from a per-statement migration",
      });
      expect(message.seq).toBe(1);
    } finally {
      await fresh.close();
    }
  });

  it("joined statements are exactly migrationSql (no drift between the two exports)", () => {
    expect(migrationStatements.map((s) => `${s};`).join("\n\n") + "\n").toBe(migrationSql);
  });

  it("creates the canonical message-token search index", async () => {
    const result = await pglite.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'chatpack_message_search_tokens'`,
    );
    expect(result.rows.map((row) => row.indexname)).toContain(
      "chatpack_message_search_tokens_token_idx",
    );
  });
});

describe("conversations on Postgres", () => {
  it("find-or-create is idempotent per user pair (unique pair_key)", async () => {
    const first = await chat.api.getOrCreateConversation({ userId: "alice", otherUserId: "bob" });
    const again = await chat.api.getOrCreateConversation({ userId: "bob", otherUserId: "alice" });

    expect(again.id).toBe(first.id);
    expect(first.participants.map((p) => p.userId).sort()).toEqual(["alice", "bob"]);
  });

  it("concurrent find-or-create converges on a single conversation", async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        chat.api.getOrCreateConversation({ userId: "alice", otherUserId: "bob" }),
      ),
    );
    const ids = new Set(results.map((c) => c.id));
    expect(ids.size).toBe(1);
  });

  it("lists conversations most-recently-active first with keyset pagination", async () => {
    const withBob = await chat.api.getOrCreateConversation({
      userId: "alice",
      otherUserId: "bob",
    });
    const withCarol = await chat.api.getOrCreateConversation({
      userId: "alice",
      otherUserId: "carol",
    });
    const withDave = await chat.api.getOrCreateConversation({
      userId: "alice",
      otherUserId: "dave",
    });

    // Activity: bob ← oldest, dave, carol ← newest
    await chat.api.sendMessage({ userId: "alice", conversationId: withBob.id, body: "1" });
    await chat.api.sendMessage({ userId: "alice", conversationId: withDave.id, body: "2" });
    await chat.api.sendMessage({ userId: "alice", conversationId: withCarol.id, body: "3" });

    const page1 = await chat.api.listConversations({ userId: "alice", limit: 2 });
    expect(page1.conversations.map((c) => c.id)).toEqual([withCarol.id, withDave.id]);
    expect(page1.nextCursor).not.toBeNull();

    const page2 = await chat.api.listConversations({
      userId: "alice",
      limit: 2,
      cursor: page1.nextCursor!,
    });
    expect(page2.conversations.map((c) => c.id)).toEqual([withBob.id]);
    expect(page2.nextCursor).toBeNull();
  });

  it("metadata JSONB round-trips", async () => {
    const conversation = await chat.api.getOrCreateConversation({
      userId: "alice",
      otherUserId: "bob",
      metadata: { topic: "support", nested: { priority: 2 } },
    });
    const fetched = await chat.api.getConversation({
      userId: "alice",
      conversationId: conversation.id,
    });
    expect(fetched.metadata).toEqual({ topic: "support", nested: { priority: 2 } });
  });
});

describe("messages on Postgres", () => {
  it("assigns strictly increasing seq", async () => {
    const conversation = await chat.api.getOrCreateConversation({
      userId: "alice",
      otherUserId: "bob",
    });

    const sent = [];
    for (let i = 1; i <= 5; i++) {
      sent.push(
        await chat.api.sendMessage({
          userId: i % 2 ? "alice" : "bob",
          conversationId: conversation.id,
          body: `m${i}`,
        }),
      );
    }
    expect(sent.map((m) => m.seq)).toEqual([1, 2, 3, 4, 5]);
  });

  it("concurrent sends get unique seq values (atomic UPDATE ... RETURNING)", async () => {
    const conversation = await chat.api.getOrCreateConversation({
      userId: "alice",
      otherUserId: "bob",
    });

    const sent = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        chat.api.sendMessage({
          userId: i % 2 ? "alice" : "bob",
          conversationId: conversation.id,
          body: `c${i}`,
        }),
      ),
    );

    const seqs = sent.map((m) => m.seq).sort((a, b) => a - b);
    expect(seqs).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
  });

  it("paginates newest-first with a seq cursor", async () => {
    const conversation = await chat.api.getOrCreateConversation({
      userId: "alice",
      otherUserId: "bob",
    });
    for (let i = 1; i <= 5; i++) {
      await chat.api.sendMessage({
        userId: "alice",
        conversationId: conversation.id,
        body: `m${i}`,
      });
    }

    const page1 = await chat.api.listMessages({
      userId: "bob",
      conversationId: conversation.id,
      limit: 2,
    });
    expect(page1.messages.map((m) => m.body)).toEqual(["m5", "m4"]);

    const page2 = await chat.api.listMessages({
      userId: "bob",
      conversationId: conversation.id,
      limit: 2,
      cursor: page1.nextCursor!,
    });
    expect(page2.messages.map((m) => m.body)).toEqual(["m3", "m2"]);

    const page3 = await chat.api.listMessages({
      userId: "bob",
      conversationId: conversation.id,
      limit: 2,
      cursor: page2.nextCursor!,
    });
    expect(page3.messages.map((m) => m.body)).toEqual(["m1"]);
    expect(page3.nextCursor).toBeNull();
  });

  it("edit and soft-delete persist", async () => {
    const conversation = await chat.api.getOrCreateConversation({
      userId: "alice",
      otherUserId: "bob",
    });
    const message = await chat.api.sendMessage({
      userId: "alice",
      conversationId: conversation.id,
      body: "helo",
    });

    const edited = await chat.api.editMessage({
      userId: "alice",
      messageId: message.id,
      body: "hello",
    });
    expect(edited.body).toBe("hello");
    expect(edited.editedAt).not.toBeNull();

    const deleted = await chat.api.deleteMessage({ userId: "alice", messageId: message.id });
    expect(deleted.body).toBe("");
    expect(deleted.deletedAt).not.toBeNull();

    // Tombstone survives in history
    const { messages } = await chat.api.listMessages({
      userId: "bob",
      conversationId: conversation.id,
    });
    expect(messages[0]!.deletedAt).not.toBeNull();
  });

  it("listMessagesAfter replays the gap oldest-first (SSE gap-fill path)", async () => {
    const conversation = await chat.api.getOrCreateConversation({
      userId: "alice",
      otherUserId: "bob",
    });
    for (let i = 1; i <= 4; i++) {
      await chat.api.sendMessage({
        userId: "alice",
        conversationId: conversation.id,
        body: `m${i}`,
      });
    }

    const missed = await chat.api.listMessagesAfter({
      userId: "bob",
      conversationId: conversation.id,
      afterSeq: 2,
    });
    expect(missed.map((m) => m.body)).toEqual(["m3", "m4"]);
  });
});

describe("read-state & permissions on Postgres", () => {
  it("markRead persists lastReadMessageId", async () => {
    const conversation = await chat.api.getOrCreateConversation({
      userId: "alice",
      otherUserId: "bob",
    });
    const message = await chat.api.sendMessage({
      userId: "alice",
      conversationId: conversation.id,
      body: "read me",
    });

    await chat.api.markRead({
      userId: "bob",
      conversationId: conversation.id,
      messageId: message.id,
    });

    const fetched = await chat.api.getConversation({
      userId: "bob",
      conversationId: conversation.id,
    });
    const bob = fetched.participants.find((p) => p.userId === "bob");
    expect(bob!.lastReadMessageId).toBe(message.id);
  });

  it("non-participants are rejected (permission checks hit real rows)", async () => {
    const conversation = await chat.api.getOrCreateConversation({
      userId: "alice",
      otherUserId: "bob",
    });

    await expect(
      chat.api.listMessages({ userId: "mallory", conversationId: conversation.id }),
    ).rejects.toMatchObject({ code: "FORBIDDEN_READ" });

    await expect(
      chat.api.sendMessage({ userId: "mallory", conversationId: conversation.id, body: "hi" }),
    ).rejects.toThrowError(ChatpackError);
  });

  it("ignores a markRead older than the current read-state (monotonic)", async () => {
    const conversation = await chat.api.getOrCreateConversation({
      userId: "alice",
      otherUserId: "bob",
    });
    const m1 = await chat.api.sendMessage({
      userId: "alice",
      conversationId: conversation.id,
      body: "one",
    });
    const m2 = await chat.api.sendMessage({
      userId: "alice",
      conversationId: conversation.id,
      body: "two",
    });

    await chat.api.markRead({ userId: "bob", conversationId: conversation.id, messageId: m2.id });
    // Stale replay: must not regress the SQL row or the count.
    await chat.api.markRead({ userId: "bob", conversationId: conversation.id, messageId: m1.id });

    const fetched = await chat.api.getConversation({
      userId: "bob",
      conversationId: conversation.id,
    });
    expect(fetched.participants.find((p) => p.userId === "bob")!.lastReadMessageId).toBe(m2.id);
    expect(fetched.unreadCount).toBe(0);
  });
});

describe("unread counts on Postgres", () => {
  it("counts the partner's messages, never the viewer's own; null read-state counts all", async () => {
    const conversation = await chat.api.getOrCreateConversation({
      userId: "alice",
      otherUserId: "bob",
    });

    for (const body of ["one", "two", "three"]) {
      await chat.api.sendMessage({ userId: "alice", conversationId: conversation.id, body });
    }

    const bobView = await chat.api.getConversation({
      userId: "bob",
      conversationId: conversation.id,
    });
    const aliceView = await chat.api.getConversation({
      userId: "alice",
      conversationId: conversation.id,
    });
    expect(bobView.unreadCount).toBe(3);
    expect(aliceView.unreadCount).toBe(0);
  });

  it("markRead mid-history leaves the remainder; at newest leaves 0", async () => {
    const conversation = await chat.api.getOrCreateConversation({
      userId: "alice",
      otherUserId: "bob",
    });

    const sent = [];
    for (const body of ["one", "two", "three"]) {
      sent.push(
        await chat.api.sendMessage({ userId: "alice", conversationId: conversation.id, body }),
      );
    }

    await chat.api.markRead({
      userId: "bob",
      conversationId: conversation.id,
      messageId: sent[1]!.id,
    });
    let bobView = await chat.api.getConversation({
      userId: "bob",
      conversationId: conversation.id,
    });
    expect(bobView.unreadCount).toBe(1);

    await chat.api.markRead({
      userId: "bob",
      conversationId: conversation.id,
      messageId: sent[2]!.id,
    });
    bobView = await chat.api.getConversation({ userId: "bob", conversationId: conversation.id });
    expect(bobView.unreadCount).toBe(0);
  });

  it("tombstones and assistant-role messages count", async () => {
    const conversation = await chat.api.getOrCreateConversation({
      userId: "alice",
      otherUserId: "bob",
    });

    const deleted = await chat.api.sendMessage({
      userId: "alice",
      conversationId: conversation.id,
      body: "oops",
    });
    await chat.api.deleteMessage({ userId: "alice", messageId: deleted.id });
    await chat.api.sendMessage({
      userId: "alice",
      conversationId: conversation.id,
      body: "beep boop",
      role: "assistant",
    });

    const bobView = await chat.api.getConversation({
      userId: "bob",
      conversationId: conversation.id,
    });
    expect(bobView.unreadCount).toBe(2);
  });

  it("listConversations batches counts across the page (one per conversation)", async () => {
    const withBob = await chat.api.getOrCreateConversation({
      userId: "alice",
      otherUserId: "bob",
    });
    const withCarol = await chat.api.getOrCreateConversation({
      userId: "alice",
      otherUserId: "carol",
    });
    const withDave = await chat.api.getOrCreateConversation({
      userId: "alice",
      otherUserId: "dave",
    });

    await chat.api.sendMessage({ userId: "carol", conversationId: withCarol.id, body: "c1" });
    await chat.api.sendMessage({ userId: "carol", conversationId: withCarol.id, body: "c2" });
    await chat.api.sendMessage({ userId: "bob", conversationId: withBob.id, body: "b1" });

    const { conversations } = await chat.api.listConversations({ userId: "alice" });
    const byId = new Map(conversations.map((c) => [c.id, c.unreadCount]));
    expect(byId.get(withBob.id)).toBe(1);
    expect(byId.get(withCarol.id)).toBe(2);
    expect(byId.get(withDave.id)).toBe(0);
  });
});

describe("message search on Postgres", () => {
  it("matches case-insensitively, ranks relevance, paginates, and excludes tombstones", async () => {
    const withBob = await chat.api.getOrCreateConversation({
      userId: "alice",
      otherUserId: "bob",
    });
    const withCarol = await chat.api.getOrCreateConversation({
      userId: "alice",
      otherUserId: "carol",
    });

    await chat.api.sendMessage({
      userId: "alice",
      conversationId: withBob.id,
      body: "hello from bob's conversation",
    });
    const deleted = await chat.api.sendMessage({
      userId: "alice",
      conversationId: withBob.id,
      body: "HELLO deleted secret",
    });
    await chat.api.deleteMessage({ userId: "alice", messageId: deleted.id });
    await chat.api.sendMessage({
      userId: "alice",
      conversationId: withCarol.id,
      body: "HELLO hello world",
    });

    const firstPage = await chat.api.searchMessages({ userId: "alice", query: "HeLLo", limit: 1 });
    expect(firstPage.messages.map((message) => message.body)).toEqual(["HELLO hello world"]);
    expect(firstPage.nextCursor).not.toBeNull();

    const secondPage = await chat.api.searchMessages({
      userId: "alice",
      query: "hello",
      limit: 1,
      cursor: firstPage.nextCursor!,
    });
    expect(secondPage.messages.map((message) => message.body)).toEqual([
      "hello from bob's conversation",
    ]);
    expect(secondPage.nextCursor).toBeNull();

    const deletedSearch = await chat.api.searchMessages({ userId: "alice", query: "deleted" });
    expect(deletedSearch.messages).toHaveLength(0);
  });

  it("matches canonical punctuation-separated tokens", async () => {
    const conversation = await chat.api.getOrCreateConversation({
      userId: "alice",
      otherUserId: "bob",
    });
    await chat.api.sendMessage({
      userId: "alice",
      conversationId: conversation.id,
      body: "reach me at user@example.com",
    });
    await chat.api.sendMessage({
      userId: "alice",
      conversationId: conversation.id,
      body: "shipping v1.2.3 today",
    });
    await chat.api.sendMessage({
      userId: "alice",
      conversationId: conversation.id,
      body: "see the deploy-preview link",
    });

    expect(
      (await chat.api.searchMessages({ userId: "alice", query: "example" })).messages,
    ).toHaveLength(1);
    expect(
      (await chat.api.searchMessages({ userId: "alice", query: "user@example.com" })).messages,
    ).toHaveLength(1);
    expect((await chat.api.searchMessages({ userId: "alice", query: "v1" })).messages).toHaveLength(
      1,
    );
    expect(
      (await chat.api.searchMessages({ userId: "alice", query: "v1.2.3" })).messages,
    ).toHaveLength(1);
    expect(
      (await chat.api.searchMessages({ userId: "alice", query: "deploy-preview" })).messages,
    ).toHaveLength(1);
  });

  it("matches the same URL, path, phone, host, and version corpus as memory", async () => {
    const conversation = await chat.api.getOrCreateConversation({
      userId: "alice",
      otherUserId: "bob",
    });
    const bodies = [
      "path is src/index.ts here",
      "call me on +1-555-0100",
      "check https://chatpack.dev/docs/realtime for details",
      "the repo is github.com/chddaniel/chatpack",
      "read docs/decisions/0015-message-search.md",
    ];
    for (const body of bodies) {
      await chat.api.sendMessage({ userId: "alice", conversationId: conversation.id, body });
    }

    const cases = [
      ["src", [bodies[0]!]],
      ["index.ts", [bodies[0]!]],
      ["555", [bodies[1]!]],
      ["1-555-0100", [bodies[1]!]],
      ["chatpack", [bodies[2]!, bodies[3]!]],
      ["docs", [bodies[2]!, bodies[4]!]],
      ["realtime", [bodies[2]!]],
      ["chddaniel", [bodies[3]!]],
      ["decisions", [bodies[4]!]],
      ["0015-message-search.md", [bodies[4]!]],
    ] as const;

    for (const [query, expected] of cases) {
      const result = await chat.api.searchMessages({ userId: "alice", query });
      expect(result.messages.map((message) => message.body).sort()).toEqual([...expected].sort());
    }
  });

  it("maintains tokens across edits and tombstones", async () => {
    const conversation = await chat.api.getOrCreateConversation({
      userId: "alice",
      otherUserId: "bob",
    });
    const message = await chat.api.sendMessage({
      userId: "alice",
      conversationId: conversation.id,
      body: "old canonical token",
    });

    expect(
      (await chat.api.searchMessages({ userId: "alice", query: "old" })).messages,
    ).toHaveLength(1);
    await chat.api.editMessage({ userId: "alice", messageId: message.id, body: "new value" });
    expect(
      (await chat.api.searchMessages({ userId: "alice", query: "old" })).messages,
    ).toHaveLength(0);
    await chat.api.deleteMessage({ userId: "alice", messageId: message.id });
    expect(
      (await chat.api.searchMessages({ userId: "alice", query: "new" })).messages,
    ).toHaveLength(0);
  });

  it("does not search non-participant conversations yet", async () => {
    const supportChat = chatpack({
      storage: drizzleAdapter(db),
      telemetry: false,
      permissions: {
        canRead: ({ user, conversation }) =>
          user.id === "support" || conversation.participantIds.includes(user.id),
      },
    });
    const conversation = await supportChat.api.getOrCreateConversation({
      userId: "alice",
      otherUserId: "bob",
    });
    await supportChat.api.sendMessage({
      userId: "alice",
      conversationId: conversation.id,
      body: "support searchable transcript",
    });

    const support = await supportChat.api.searchMessages({
      userId: "support",
      query: "searchable",
    });
    expect(support.messages).toHaveLength(0);
  });

  it("uses creation time as the tie-break after relevance", async () => {
    vi.useFakeTimers();
    try {
      const conversation = await chat.api.getOrCreateConversation({
        userId: "alice",
        otherUserId: "bob",
      });
      vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
      const older = await chat.api.sendMessage({
        userId: "alice",
        conversationId: conversation.id,
        body: "same term",
      });
      vi.setSystemTime(new Date("2026-01-01T00:00:01.000Z"));
      const newer = await chat.api.sendMessage({
        userId: "alice",
        conversationId: conversation.id,
        body: "same term",
      });

      const result = await chat.api.searchMessages({ userId: "alice", query: "same" });
      expect(result.messages.map((message) => message.id)).toEqual([newer.id, older.id]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("reactions and replies on Postgres (ADR 0013)", () => {
  it("persists the reply pointer and hydrates the preview from a real join", async () => {
    const conversation = await chat.api.getOrCreateConversation({
      userId: "alice",
      otherUserId: "bob",
    });
    const parent = await chat.api.sendMessage({
      userId: "alice",
      conversationId: conversation.id,
      body: "the original",
    });
    const reply = await chat.api.sendMessage({
      userId: "bob",
      conversationId: conversation.id,
      body: "quoting",
      replyToMessageId: parent.id,
    });
    expect(reply.replyToMessageId).toBe(parent.id);

    // Read back through a fresh query, so the preview comes from the DB.
    const { messages } = await chat.api.listMessages({
      userId: "alice",
      conversationId: conversation.id,
    });
    expect(messages[0]).toMatchObject({
      id: reply.id,
      replyTo: { id: parent.id, senderId: "alice", excerpt: "the original", deleted: false },
    });
    expect(messages[1]!.replyTo).toBeNull();
  });

  it("batches parent lookups across a page of replies", async () => {
    const conversation = await chat.api.getOrCreateConversation({
      userId: "alice",
      otherUserId: "bob",
    });
    const parents = [];
    for (let i = 1; i <= 3; i++) {
      parents.push(
        await chat.api.sendMessage({
          userId: "alice",
          conversationId: conversation.id,
          body: `p${i}`,
        }),
      );
    }
    for (const parent of parents) {
      await chat.api.sendMessage({
        userId: "bob",
        conversationId: conversation.id,
        body: `re: ${parent.body}`,
        replyToMessageId: parent.id,
      });
    }

    const { messages } = await chat.api.listMessages({
      userId: "alice",
      conversationId: conversation.id,
    });
    const replies = messages.filter((m) => m.replyTo !== null);
    expect(replies).toHaveLength(3);
    expect(replies.map((m) => m.replyTo!.excerpt).sort()).toEqual(["p1", "p2", "p3"]);
  });

  it("ON CONFLICT DO NOTHING makes reacting twice idempotent", async () => {
    const conversation = await chat.api.getOrCreateConversation({
      userId: "alice",
      otherUserId: "bob",
    });
    const message = await chat.api.sendMessage({
      userId: "alice",
      conversationId: conversation.id,
      body: "react to me",
    });

    await chat.api.addReaction({ userId: "bob", messageId: message.id, emoji: "👍" });
    const twice = await chat.api.addReaction({
      userId: "bob",
      messageId: message.id,
      emoji: "👍",
    });
    expect(twice.reactions).toEqual([{ emoji: "👍", count: 1, userIds: ["bob"] }]);

    // The unique index is the real arbiter: exactly one row survived.
    const rows = await pglite.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM "chatpack_message_reactions"`,
    );
    expect(rows.rows[0]!.count).toBe(1);

    // Concurrent identical reactions also collapse to one row.
    await Promise.all(
      Array.from({ length: 5 }, () =>
        chat.api.addReaction({ userId: "alice", messageId: message.id, emoji: "🎉" }),
      ),
    );
    const after = await pglite.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM "chatpack_message_reactions" WHERE "emoji" = '🎉'`,
    );
    expect(after.rows[0]!.count).toBe(1);
  });

  it("removing is idempotent and scoped to the caller's own reaction", async () => {
    const conversation = await chat.api.getOrCreateConversation({
      userId: "alice",
      otherUserId: "bob",
    });
    const message = await chat.api.sendMessage({
      userId: "alice",
      conversationId: conversation.id,
      body: "hi",
    });

    await chat.api.addReaction({ userId: "alice", messageId: message.id, emoji: "👍" });
    await chat.api.addReaction({ userId: "bob", messageId: message.id, emoji: "👍" });

    const removed = await chat.api.removeReaction({
      userId: "bob",
      messageId: message.id,
      emoji: "👍",
    });
    expect(removed.reactions).toEqual([{ emoji: "👍", count: 1, userIds: ["alice"] }]);

    const again = await chat.api.removeReaction({
      userId: "bob",
      messageId: message.id,
      emoji: "👍",
    });
    expect(again.reactions).toEqual(removed.reactions);
  });

  it("groups reactions earliest-first across a message page", async () => {
    const conversation = await chat.api.getOrCreateConversation({
      userId: "alice",
      otherUserId: "bob",
    });
    const first = await chat.api.sendMessage({
      userId: "alice",
      conversationId: conversation.id,
      body: "m1",
    });
    const second = await chat.api.sendMessage({
      userId: "alice",
      conversationId: conversation.id,
      body: "m2",
    });

    await chat.api.addReaction({ userId: "bob", messageId: first.id, emoji: "👍" });
    await chat.api.addReaction({ userId: "alice", messageId: first.id, emoji: "👍" });
    await chat.api.addReaction({ userId: "bob", messageId: second.id, emoji: ":shipit:" });

    const { messages } = await chat.api.listMessages({
      userId: "alice",
      conversationId: conversation.id,
    });
    const byId = new Map(messages.map((m) => [m.id, m.reactions]));
    expect(byId.get(first.id)).toEqual([{ emoji: "👍", count: 2, userIds: ["bob", "alice"] }]);
    expect(byId.get(second.id)).toEqual([{ emoji: ":shipit:", count: 1, userIds: ["bob"] }]);
  });

  it("a reaction never advances last_seq or last_activity_at", async () => {
    const conversation = await chat.api.getOrCreateConversation({
      userId: "alice",
      otherUserId: "bob",
    });
    const message = await chat.api.sendMessage({
      userId: "alice",
      conversationId: conversation.id,
      body: "hi",
    });

    const before = await pglite.query<{ last_seq: number; last_activity_at: string }>(
      `SELECT "last_seq", "last_activity_at" FROM "chatpack_conversations" WHERE "id" = $1`,
      [conversation.id],
    );

    await chat.api.addReaction({ userId: "bob", messageId: message.id, emoji: "👍" });
    await chat.api.removeReaction({ userId: "bob", messageId: message.id, emoji: "👍" });

    const after = await pglite.query<{ last_seq: number; last_activity_at: string }>(
      `SELECT "last_seq", "last_activity_at" FROM "chatpack_conversations" WHERE "id" = $1`,
      [conversation.id],
    );
    expect(after.rows[0]).toEqual(before.rows[0]);
  });

  it("deleting a conversation cascades its reactions away", async () => {
    const conversation = await chat.api.getOrCreateConversation({
      userId: "alice",
      otherUserId: "bob",
    });
    const message = await chat.api.sendMessage({
      userId: "alice",
      conversationId: conversation.id,
      body: "hi",
    });
    await chat.api.addReaction({ userId: "bob", messageId: message.id, emoji: "👍" });

    // Chatpack never hard-deletes, but an app owning the row might (GDPR erase).
    await pglite.query(`DELETE FROM "chatpack_conversations" WHERE "id" = $1`, [conversation.id]);

    const rows = await pglite.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM "chatpack_message_reactions"`,
    );
    expect(rows.rows[0]!.count).toBe(0);
  });
});

describe("upgrading a pre-ADR-0013 database", () => {
  it("adds reply_to_message_id and the reactions table to an existing schema", async () => {
    const legacy = new PGlite();
    try {
      // The v0 schema, verbatim minus everything ADR 0013 introduced.
      await legacy.exec(`
        CREATE TABLE "chatpack_conversations" (
          "id" text PRIMARY KEY,
          "pair_key" text NOT NULL,
          "created_at" timestamptz NOT NULL,
          "metadata" jsonb NOT NULL DEFAULT '{}',
          "last_seq" integer NOT NULL DEFAULT 0,
          "last_activity_at" timestamptz NOT NULL
        );
        CREATE UNIQUE INDEX "chatpack_conversations_pair_key_idx"
          ON "chatpack_conversations" ("pair_key");
        CREATE TABLE "chatpack_conversation_participants" (
          "conversation_id" text NOT NULL
            REFERENCES "chatpack_conversations"("id") ON DELETE CASCADE,
          "user_id" text NOT NULL,
          "joined_at" timestamptz NOT NULL,
          "last_read_message_id" text
        );
        CREATE UNIQUE INDEX "chatpack_participants_conv_user_idx"
          ON "chatpack_conversation_participants" ("conversation_id", "user_id");
        CREATE TABLE "chatpack_messages" (
          "id" text PRIMARY KEY,
          "conversation_id" text NOT NULL
            REFERENCES "chatpack_conversations"("id") ON DELETE CASCADE,
          "sender_id" text NOT NULL,
          "body" text NOT NULL,
          "role" text NOT NULL DEFAULT 'user',
          "seq" bigint NOT NULL,
          "created_at" timestamptz NOT NULL,
          "edited_at" timestamptz,
          "deleted_at" timestamptz,
          "metadata" jsonb NOT NULL DEFAULT '{}'
        );
        CREATE UNIQUE INDEX "chatpack_messages_conv_seq_idx"
          ON "chatpack_messages" ("conversation_id", "seq");
      `);

      // Existing data, written before the upgrade.
      const legacyDb = drizzle(legacy) as unknown as DrizzlePgDatabase;
      const before = chatpack({ storage: drizzleAdapter(legacyDb), telemetry: false });
      const conversation = await before.api.getOrCreateConversation({
        userId: "alice",
        otherUserId: "bob",
      });
      await legacy.query(
        `INSERT INTO "chatpack_messages"
           ("id", "conversation_id", "sender_id", "body", "role", "seq", "created_at")
         VALUES ('legacy_1', $1, 'alice', 'written before the upgrade', 'user', 1, now())`,
        [conversation.id],
      );
      await legacy.query(`UPDATE "chatpack_conversations" SET "last_seq" = 1 WHERE "id" = $1`, [
        conversation.id,
      ]);

      // Re-running the migration is the whole upgrade: CREATE TABLE IF NOT
      // EXISTS no-ops on chatpack_messages, so the ALTER carries the column.
      await legacy.exec(migrationSql);
      await backfillMessageSearchTokens(legacyDb);

      const upgraded = chatpack({ storage: drizzleAdapter(legacyDb), telemetry: false });
      const reply = await upgraded.api.sendMessage({
        userId: "bob",
        conversationId: conversation.id,
        body: "quoting the old message",
        replyToMessageId: "legacy_1",
      });
      expect(reply.replyTo).toMatchObject({
        id: "legacy_1",
        excerpt: "written before the upgrade",
      });
      expect(reply.seq).toBe(2); // the old seq counter is untouched

      const reacted = await upgraded.api.addReaction({
        userId: "alice",
        messageId: "legacy_1",
        emoji: "👍",
      });
      expect(reacted.reactions).toEqual([{ emoji: "👍", count: 1, userIds: ["alice"] }]);

      // Pre-existing rows read back with the new fields defaulted, not missing.
      const { messages } = await upgraded.api.listMessages({
        userId: "alice",
        conversationId: conversation.id,
      });
      const legacyMessage = messages.find((m) => m.id === "legacy_1")!;
      expect(legacyMessage.replyToMessageId).toBeNull();
      expect(legacyMessage.replyTo).toBeNull();
      expect(
        (await upgraded.api.searchMessages({ userId: "alice", query: "written" })).messages,
      ).toHaveLength(1);

      // And the migration stays idempotent when run a third time.
      await legacy.exec(migrationSql);
    } finally {
      await legacy.close();
    }
  });
});
