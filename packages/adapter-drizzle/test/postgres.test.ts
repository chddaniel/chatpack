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

  it("batches token inserts for large sends and edits", async () => {
    const conversation = await chat.api.getOrCreateConversation({
      userId: "alice",
      otherUserId: "bob",
    });
    const sentBody = Array.from({ length: 25_000 }, (_, index) => `token${index}`).join(" ");
    const message = await chat.api.sendMessage({
      userId: "alice",
      conversationId: conversation.id,
      body: sentBody,
    });

    expect(
      (await chat.api.searchMessages({ userId: "alice", query: "token24999" })).messages.map(
        (result) => result.id,
      ),
    ).toEqual([message.id]);

    const editedBody = Array.from({ length: 25_000 }, (_, index) => `edited${index}`).join(" ");
    await chat.api.editMessage({ userId: "alice", messageId: message.id, body: editedBody });

    expect(
      (await chat.api.searchMessages({ userId: "alice", query: "token24999" })).messages,
    ).toHaveLength(0);
    expect(
      (await chat.api.searchMessages({ userId: "alice", query: "edited24999" })).messages.map(
        (result) => result.id,
      ),
    ).toEqual([message.id]);
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

describe("groups on Postgres (ADR 0017)", () => {
  it("keeps pair_key unique for DMs while allowing many null-keyed groups", async () => {
    const index = await pglite.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes
       WHERE tablename = 'chatpack_conversations'
         AND indexname = 'chatpack_conversations_pair_key_unique_idx'`,
    );
    // The index must be partial; a total one would reject the second group.
    expect(index.rows[0]!.indexdef).toMatch(/WHERE \(pair_key IS NOT NULL\)/);

    const first = await chat.api.createGroupConversation({ userId: "alice", userIds: ["bob"] });
    const second = await chat.api.createGroupConversation({ userId: "alice", userIds: ["bob"] });
    expect(first.id).not.toBe(second.id);

    // ...and the DM path still converges, which is the ON CONFLICT clause that
    // has to repeat the partial predicate to match this index at all.
    const dm = await chat.api.getOrCreateConversation({ userId: "alice", otherUserId: "bob" });
    const again = await chat.api.getOrCreateConversation({ userId: "bob", otherUserId: "alice" });
    expect(again.id).toBe(dm.id);
  });

  it("persists type, name, and roles as real columns", async () => {
    const group = await chat.api.createGroupConversation({
      userId: "alice",
      userIds: ["bob", "carol"],
      name: "Standup",
    });

    const row = await pglite.query<{ type: string; name: string | null; pair_key: string | null }>(
      `SELECT "type", "name", "pair_key" FROM "chatpack_conversations" WHERE "id" = $1`,
      [group.id],
    );
    expect(row.rows[0]).toEqual({ type: "group", name: "Standup", pair_key: null });

    const roles = await pglite.query<{ user_id: string; role: string }>(
      `SELECT "user_id", "role" FROM "chatpack_conversation_participants"
       WHERE "conversation_id" = $1 ORDER BY "user_id"`,
      [group.id],
    );
    expect(roles.rows).toEqual([
      { user_id: "alice", role: "admin" },
      { user_id: "bob", role: "member" },
      { user_id: "carol", role: "member" },
    ]);
  });

  it("creates the conversation and its participants in one transaction", async () => {
    // Force the *second* of the two inserts to fail, so the only thing that can
    // keep the conversation row out of the table is a rollback.
    await pglite.exec(`
      ALTER TABLE "chatpack_conversation_participants"
        ADD CONSTRAINT "no_bob" CHECK ("user_id" <> 'bob');
    `);

    await expect(
      chat.api.createGroupConversation({ userId: "alice", userIds: ["bob"], name: "Doomed" }),
    ).rejects.toThrow();

    const rows = await pglite.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM "chatpack_conversations" WHERE "name" = 'Doomed'`,
    );
    expect(rows.rows[0]!.count).toBe(0);
  });

  it("ON CONFLICT DO NOTHING makes adding an existing member idempotent", async () => {
    const group = await chat.api.createGroupConversation({ userId: "alice", userIds: ["bob"] });
    await chat.api.setParticipantRole({
      userId: "alice",
      conversationId: group.id,
      targetUserId: "bob",
      role: "admin",
    });

    const updated = await chat.api.addParticipants({
      userId: "alice",
      conversationId: group.id,
      userIds: ["bob", "carol"],
    });

    expect(updated.participants.map((p) => [p.userId, p.role])).toEqual([
      ["alice", "admin"],
      ["bob", "admin"], // the replayed insert did NOT reset bob to member
      ["carol", "member"],
    ]);
    const rows = await pglite.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM "chatpack_conversation_participants"
       WHERE "conversation_id" = $1 AND "user_id" = 'bob'`,
      [group.id],
    );
    expect(rows.rows[0]!.count).toBe(1);
  });

  it("returns participants in a stable order across reads", async () => {
    const group = await chat.api.createGroupConversation({
      userId: "alice",
      userIds: ["zoe", "bob", "carol"],
    });
    await chat.api.addParticipants({
      userId: "alice",
      conversationId: group.id,
      userIds: ["dave"],
    });

    // Postgres gives no row order without ORDER BY, so rewriting a row is
    // enough to shuffle an unordered read. Clients diff participants
    // positionally, so the order has to survive it.
    await pglite.query(
      `UPDATE "chatpack_conversation_participants"
       SET "last_read_message_id" = NULL WHERE "user_id" = 'bob'`,
    );

    const reads = await Promise.all([
      chat.api.getConversation({ userId: "alice", conversationId: group.id }),
      chat.api.getConversation({ userId: "alice", conversationId: group.id }),
    ]);
    for (const read of reads) {
      // joined_at, then user_id: the creator's cohort alphabetically, then
      // whoever joined later.
      expect(read.participants.map((p) => p.userId)).toEqual([
        "alice",
        "bob",
        "carol",
        "zoe",
        "dave",
      ]);
    }
  });

  it("removing a participant deletes the row and leaves their messages", async () => {
    const group = await chat.api.createGroupConversation({
      userId: "alice",
      userIds: ["bob", "carol"],
    });
    await chat.api.sendMessage({ userId: "bob", conversationId: group.id, body: "before I left" });

    await chat.api.removeParticipant({
      userId: "alice",
      conversationId: group.id,
      targetUserId: "bob",
    });

    const participants = await pglite.query<{ user_id: string }>(
      `SELECT "user_id" FROM "chatpack_conversation_participants"
       WHERE "conversation_id" = $1 ORDER BY "user_id"`,
      [group.id],
    );
    expect(participants.rows.map((r) => r.user_id)).toEqual(["alice", "carol"]);

    const messages = await pglite.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM "chatpack_messages" WHERE "sender_id" = 'bob'`,
    );
    expect(messages.rows[0]!.count).toBe(1);

    // The removed user can no longer read it.
    await expect(
      chat.api.getConversation({ userId: "bob", conversationId: group.id }),
    ).rejects.toBeInstanceOf(ChatpackError);
  });

  it("counts unread per viewer across N participants", async () => {
    const group = await chat.api.createGroupConversation({
      userId: "alice",
      userIds: ["bob", "carol"],
    });
    await chat.api.sendMessage({ userId: "alice", conversationId: group.id, body: "one" });
    const second = await chat.api.sendMessage({
      userId: "bob",
      conversationId: group.id,
      body: "two",
    });
    await chat.api.sendMessage({ userId: "carol", conversationId: group.id, body: "three" });

    // Each viewer discounts only their own messages (countUnread is a real
    // aggregate query, not a two-participant special case).
    expect(
      (await chat.api.getConversation({ userId: "alice", conversationId: group.id })).unreadCount,
    ).toBe(2);
    expect(
      (await chat.api.getConversation({ userId: "bob", conversationId: group.id })).unreadCount,
    ).toBe(2);

    await chat.api.markRead({ userId: "bob", conversationId: group.id, messageId: second.id });
    expect(
      (await chat.api.getConversation({ userId: "bob", conversationId: group.id })).unreadCount,
    ).toBe(1);
  });

  it("lists and searches groups for members only", async () => {
    const group = await chat.api.createGroupConversation({
      userId: "alice",
      userIds: ["bob"],
      name: "Launch",
    });
    await chat.api.sendMessage({
      userId: "alice",
      conversationId: group.id,
      body: "deployment tomorrow",
    });

    const listed = await chat.api.listConversations({ userId: "bob" });
    expect(listed.conversations.map((c) => [c.id, c.type, c.name])).toEqual([
      [group.id, "group", "Launch"],
    ]);

    expect(
      (await chat.api.searchMessages({ userId: "bob", query: "deployment" })).messages,
    ).toHaveLength(1);
    expect(
      (await chat.api.searchMessages({ userId: "carol", query: "deployment" })).messages,
    ).toHaveLength(0);
  });

  it("renames through a real UPDATE, and clears with null", async () => {
    const group = await chat.api.createGroupConversation({ userId: "alice", name: "Old" });

    await chat.api.updateConversation({
      userId: "alice",
      conversationId: group.id,
      name: "New",
    });
    let row = await pglite.query<{ name: string | null }>(
      `SELECT "name" FROM "chatpack_conversations" WHERE "id" = $1`,
      [group.id],
    );
    expect(row.rows[0]!.name).toBe("New");

    await chat.api.updateConversation({ userId: "alice", conversationId: group.id, name: null });
    row = await pglite.query<{ name: string | null }>(
      `SELECT "name" FROM "chatpack_conversations" WHERE "id" = $1`,
      [group.id],
    );
    expect(row.rows[0]!.name).toBeNull();
  });

  it("cascades participants away when the conversation row is deleted", async () => {
    const group = await chat.api.createGroupConversation({
      userId: "alice",
      userIds: ["bob", "carol"],
    });

    await pglite.query(`DELETE FROM "chatpack_conversations" WHERE "id" = $1`, [group.id]);

    const rows = await pglite.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM "chatpack_conversation_participants"
       WHERE "conversation_id" = $1`,
      [group.id],
    );
    expect(rows.rows[0]!.count).toBe(0);
  });

  it("refuses to strip the last admin, enforced against real rows", async () => {
    const group = await chat.api.createGroupConversation({ userId: "alice", userIds: ["bob"] });

    await expect(
      chat.api.removeParticipant({
        userId: "alice",
        conversationId: group.id,
        targetUserId: "alice",
      }),
    ).rejects.toMatchObject({ code: "LAST_ADMIN_REMAINING" });

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
    expect(left.participants.map((p) => p.userId)).toEqual(["bob"]);
  });
});

describe("invites and join requests on Postgres (ADR 0019)", () => {
  async function seedGroup(): Promise<string> {
    const group = await chat.api.createGroupConversation({
      userId: "alice",
      userIds: ["bob"],
      name: "Standup",
    });
    return group.id;
  }

  it("persists an invite as real typed columns", async () => {
    const groupId = await seedGroup();
    const invite = await chat.api.createInvite({
      userId: "alice",
      conversationId: groupId,
      maxUses: 5,
      requiresApproval: true,
    });

    const row = await pglite.query<{
      conversation_id: string;
      created_by: string;
      max_uses: number | null;
      uses: number;
      requires_approval: boolean;
      expires_at: Date | null;
    }>(
      `SELECT "conversation_id", "created_by", "max_uses", "uses", "requires_approval", "expires_at"
       FROM "chatpack_conversation_invites" WHERE "code" = $1`,
      [invite.code],
    );
    // requires_approval is a real boolean, not the string 'true' - a text column
    // here would read back truthy for 'false' and silently invert the feature.
    expect(row.rows[0]).toEqual({
      conversation_id: groupId,
      created_by: "alice",
      max_uses: 5,
      uses: 0,
      requires_approval: true,
      expires_at: null,
    });
  });

  it("consumes a one-use invite exactly once under concurrent redemption", async () => {
    const groupId = await seedGroup();
    const invite = await chat.api.createInvite({
      userId: "alice",
      conversationId: groupId,
      maxUses: 1,
    });

    // The whole reason consumeInvite is a single conditional UPDATE ...
    // RETURNING (ADR 0019 §2): read-then-write would let both of these in.
    const results = await Promise.allSettled([
      chat.api.acceptInvite({ userId: "carol", code: invite.code }),
      chat.api.acceptInvite({ userId: "dave", code: invite.code }),
    ]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const row = await pglite.query<{ uses: number }>(
      `SELECT "uses" FROM "chatpack_conversation_invites" WHERE "code" = $1`,
      [invite.code],
    );
    expect(row.rows[0]!.uses).toBe(1);
    const updated = await chat.api.getConversation({ userId: "alice", conversationId: groupId });
    expect(updated.participants).toHaveLength(3);
  });

  it("never exceeds maxUses across many simultaneous redemptions", async () => {
    const groupId = await seedGroup();
    const invite = await chat.api.createInvite({
      userId: "alice",
      conversationId: groupId,
      maxUses: 3,
    });

    const results = await Promise.allSettled(
      ["c", "d", "e", "f", "g", "h", "i", "j"].map((id) =>
        chat.api.acceptInvite({ userId: `user-${id}`, code: invite.code }),
      ),
    );

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(3);
    const row = await pglite.query<{ uses: number }>(
      `SELECT "uses" FROM "chatpack_conversation_invites" WHERE "code" = $1`,
      [invite.code],
    );
    expect(row.rows[0]!.uses).toBe(3);
  });

  it("treats an expired invite as gone in SQL, not just in core", async () => {
    const groupId = await seedGroup();
    const invite = await chat.api.createInvite({ userId: "alice", conversationId: groupId });
    // Backdate past core's reach, so the WHERE clause in consumeInvite is what
    // has to reject it.
    await pglite.query(
      `UPDATE "chatpack_conversation_invites" SET "expires_at" = now() - interval '1 hour'
       WHERE "code" = $1`,
      [invite.code],
    );

    await expect(
      chat.api.acceptInvite({ userId: "carol", code: invite.code }),
    ).rejects.toMatchObject({ code: "INVITE_EXPIRED" });
    expect(
      (
        await pglite.query<{ uses: number }>(
          `SELECT "uses" FROM "chatpack_conversation_invites" WHERE "code" = $1`,
          [invite.code],
        )
      ).rows[0]!.uses,
    ).toBe(0);
  });

  it("cascades invites and join requests away with the conversation", async () => {
    const groupId = await seedGroup();
    await chat.api.createInvite({ userId: "alice", conversationId: groupId });
    await chat.api.requestToJoin({ userId: "carol", conversationId: groupId });

    await pglite.query(`DELETE FROM "chatpack_conversations" WHERE "id" = $1`, [groupId]);

    for (const table of ["chatpack_conversation_invites", "chatpack_join_requests"]) {
      const rows = await pglite.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM "${table}" WHERE "conversation_id" = $1`,
        [groupId],
      );
      expect(rows.rows[0]!.count).toBe(0);
    }
  });

  it("keeps a join request after its invite is revoked", async () => {
    const groupId = await seedGroup();
    const invite = await chat.api.createInvite({
      userId: "alice",
      conversationId: groupId,
      requiresApproval: true,
    });
    await chat.api.acceptInvite({ userId: "carol", code: invite.code });

    await chat.api.revokeInvite({ userId: "alice", conversationId: groupId, code: invite.code });

    // No foreign key on invite_code by design: an admin must still be able to
    // see where a pending request came from after cleaning up the link.
    const queue = await chat.api.listJoinRequests({ userId: "alice", conversationId: groupId });
    expect(queue).toMatchObject([{ userId: "carol", inviteCode: invite.code }]);
  });

  it("replaces a denied request rather than stacking a second row", async () => {
    const groupId = await seedGroup();
    await chat.api.requestToJoin({ userId: "carol", conversationId: groupId, message: "first" });
    await chat.api.resolveJoinRequest({
      userId: "alice",
      conversationId: groupId,
      targetUserId: "carol",
      decision: "deny",
    });

    const again = await chat.api.requestToJoin({
      userId: "carol",
      conversationId: groupId,
      message: "second",
    });

    // The unique (conversation_id, user_id) index is the upsert's arbiter, so
    // this is one row that changed - not two rows in the queue.
    expect(again).toMatchObject({ status: "pending", message: "second" });
    const rows = await pglite.query<{ count: number; resolved_by: string | null }>(
      `SELECT count(*)::int AS count, max("resolved_by") AS resolved_by
       FROM "chatpack_join_requests" WHERE "conversation_id" = $1 AND "user_id" = 'carol'`,
      [groupId],
    );
    expect(rows.rows[0]!.count).toBe(1);
    // Reset explicitly: a leftover resolved_by would make a pending row look decided.
    expect(rows.rows[0]!.resolved_by).toBeNull();
  });

  it("records an approval and adds the member", async () => {
    const groupId = await seedGroup();
    await chat.api.requestToJoin({ userId: "carol", conversationId: groupId });

    const result = await chat.api.resolveJoinRequest({
      userId: "alice",
      conversationId: groupId,
      targetUserId: "carol",
      decision: "approve",
    });

    expect(result.conversation!.participants.map((p) => p.userId)).toEqual([
      "alice",
      "bob",
      "carol",
    ]);
    const row = await pglite.query<{ status: string; resolved_by: string; resolved_at: Date }>(
      `SELECT "status", "resolved_by", "resolved_at" FROM "chatpack_join_requests"
       WHERE "conversation_id" = $1 AND "user_id" = 'carol'`,
      [groupId],
    );
    expect(row.rows[0]).toMatchObject({ status: "approved", resolved_by: "alice" });
    expect(row.rows[0]!.resolved_at).not.toBeNull();
  });

  it("filters the queue by status in SQL", async () => {
    const groupId = await seedGroup();
    await chat.api.requestToJoin({ userId: "carol", conversationId: groupId });
    await chat.api.requestToJoin({ userId: "dave", conversationId: groupId });
    await chat.api.resolveJoinRequest({
      userId: "alice",
      conversationId: groupId,
      targetUserId: "dave",
      decision: "deny",
    });

    expect(
      (await chat.api.listJoinRequests({ userId: "alice", conversationId: groupId })).map(
        (r) => r.userId,
      ),
    ).toEqual(["carol"]);
    expect(
      (
        await chat.api.listJoinRequests({
          userId: "alice",
          conversationId: groupId,
          status: "denied",
        })
      ).map((r) => r.userId),
    ).toEqual(["dave"]);
  });

  it("lists invites newest-first with a stable tiebreak", async () => {
    const groupId = await seedGroup();
    const codes: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const invite = await chat.api.createInvite({ userId: "alice", conversationId: groupId });
      codes.push(invite.code);
    }

    const listed = await chat.api.listInvites({ userId: "alice", conversationId: groupId });

    expect(listed).toHaveLength(3);
    expect([...listed].map((i) => i.code).sort()).toEqual([...codes].sort());
  });
});

describe("public channels on Postgres (ADR 0020)", () => {
  async function seedChannel(
    overrides: { name?: string; joinPolicy?: "open" | "approval"; userIds?: string[] } = {},
  ): Promise<string> {
    const channel = await chat.api.createGroupConversation({
      userId: "alice",
      name: overrides.name ?? "General",
      visibility: "public",
      joinPolicy: overrides.joinPolicy ?? "open",
      ...(overrides.userIds ? { userIds: overrides.userIds } : {}),
    });
    return channel.id;
  }

  it("persists visibility and join_policy as columns, defaulted on DMs", async () => {
    const channelId = await seedChannel({ joinPolicy: "approval" });
    const dm = await chat.api.getOrCreateConversation({ userId: "alice", otherUserId: "bob" });

    const rows = await pglite.query<{ id: string; visibility: string; join_policy: string }>(
      `SELECT "id", "visibility", "join_policy" FROM "chatpack_conversations" ORDER BY "id"`,
    );
    const byId = new Map(rows.rows.map((row) => [row.id, row]));
    expect(byId.get(channelId)).toMatchObject({ visibility: "public", join_policy: "approval" });
    expect(byId.get(dm.id)).toMatchObject({ visibility: "private", join_policy: "approval" });
  });

  it("creates the partial index the directory query is shaped for", async () => {
    const result = await pglite.query<{ indexname: string; indexdef: string }>(
      `SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'chatpack_conversations'`,
    );
    const index = result.rows.find((r) => r.indexname === "chatpack_conversations_public_idx");
    // Partial, not total: the directory must not pay to sort every DM in the
    // table, and private rows never enter the index at all.
    expect(index?.indexdef).toContain("WHERE (visibility = 'public'");
    expect(index?.indexdef).toContain("last_activity_at");
  });

  it("coerces an unrecognized column value instead of leaking it", async () => {
    const channelId = await seedChannel();
    // A text column can hold anything a migration or a human puts there. Reading
    // it back as-is would let `visibility: "publik"` become a value core never
    // planned for; toConversation narrows to the union instead.
    await pglite.query(
      `UPDATE "chatpack_conversations" SET "visibility" = 'publik', "join_policy" = 'whenever'
       WHERE "id" = $1`,
      [channelId],
    );

    const conversation = await chat.api.getConversation({
      userId: "alice",
      conversationId: channelId,
    });
    expect(conversation).toMatchObject({ visibility: "private", joinPolicy: "approval" });
    // And it drops out of the directory, which is the safe direction to fail.
    const { channels } = await chat.api.listPublicConversations({ userId: "carol" });
    expect(channels).toHaveLength(0);
  });

  it("lists public groups most-recently-active first with keyset pagination", async () => {
    const first = await seedChannel({ name: "First" });
    const second = await seedChannel({ name: "Second" });
    const third = await seedChannel({ name: "Third" });
    await chat.api.createGroupConversation({ userId: "alice", name: "Private" });
    await chat.api.getOrCreateConversation({ userId: "alice", otherUserId: "bob" });

    await chat.api.sendMessage({ userId: "alice", conversationId: first, body: "1" });

    const page1 = await chat.api.listPublicConversations({ userId: "carol", limit: 2 });
    expect(page1.channels.map((c) => c.conversationId)).toEqual([first, third]);
    expect(page1.nextCursor).not.toBeNull();

    const page2 = await chat.api.listPublicConversations({
      userId: "carol",
      limit: 2,
      cursor: page1.nextCursor!,
    });
    // Private groups and DMs never appear, whoever is browsing.
    expect(page2.channels.map((c) => c.conversationId)).toEqual([second]);
    expect(page2.nextCursor).toBeNull();
  });

  it("computes alreadyParticipant and requestPending per viewer", async () => {
    const open = await seedChannel({ name: "Open" });
    const gated = await seedChannel({ name: "Gated", joinPolicy: "approval" });
    await chat.api.joinConversation({ userId: "carol", conversationId: open });
    await chat.api.joinConversation({ userId: "carol", conversationId: gated });

    const carol = await chat.api.listPublicConversations({ userId: "carol" });
    const dave = await chat.api.listPublicConversations({ userId: "dave" });

    const byId = new Map(carol.channels.map((c) => [c.conversationId, c]));
    expect(byId.get(open)).toMatchObject({ alreadyParticipant: true, requestPending: false });
    expect(byId.get(gated)).toMatchObject({ alreadyParticipant: false, requestPending: true });
    // Same two rows, different answers: the flags are viewer-relative, never
    // stored (the ADR 0009 rule for unreadCount, applied again).
    for (const channel of dave.channels) {
      expect(channel).toMatchObject({ alreadyParticipant: false, requestPending: false });
    }
    expect(carol.channels.every((c) => !("participants" in c))).toBe(true);
  });

  it("admits one joiner per user under concurrent self-joins", async () => {
    const channelId = await seedChannel();

    // Eight tabs, one user: the unique (conversation_id, user_id) participant
    // index is what keeps this from creating duplicate memberships.
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () =>
        chat.api.joinConversation({ userId: "carol", conversationId: channelId }),
      ),
    );

    expect(results.filter((r) => r.status === "fulfilled").length).toBeGreaterThanOrEqual(1);
    const rows = await pglite.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM "chatpack_conversation_participants"
       WHERE "conversation_id" = $1 AND "user_id" = 'carol'`,
      [channelId],
    );
    expect(rows.rows[0]!.count).toBe(1);
  });

  it("queues an approval join as a pending row with no invite code", async () => {
    const channelId = await seedChannel({ joinPolicy: "approval" });

    const result = await chat.api.joinConversation({
      userId: "carol",
      conversationId: channelId,
      message: "found you in the directory",
    });

    expect(result.status).toBe("pending");
    const row = await pglite.query<{
      status: string;
      invite_code: string | null;
      message: string | null;
    }>(
      `SELECT "status", "invite_code", "message" FROM "chatpack_join_requests"
       WHERE "conversation_id" = $1 AND "user_id" = 'carol'`,
      [channelId],
    );
    // A null invite_code is the signal an admin reads as "walked in off the
    // directory" rather than "someone handed them a link".
    expect(row.rows[0]).toEqual({
      status: "pending",
      invite_code: null,
      message: "found you in the directory",
    });
  });

  it("keeps a repeat ask to one row", async () => {
    const channelId = await seedChannel({ joinPolicy: "approval" });
    const first = await chat.api.joinConversation({
      userId: "carol",
      conversationId: channelId,
      message: "first",
    });
    const second = await chat.api.joinConversation({
      userId: "carol",
      conversationId: channelId,
      message: "second",
    });

    expect(second.joinRequest!.id).toBe(first.joinRequest!.id);
    const rows = await pglite.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM "chatpack_join_requests"
       WHERE "conversation_id" = $1 AND "user_id" = 'carol'`,
      [channelId],
    );
    expect(rows.rows[0]!.count).toBe(1);
  });

  it("refuses to join a private group and refuses to publish a DM", async () => {
    const group = await chat.api.createGroupConversation({ userId: "alice", name: "Private" });
    const dm = await chat.api.getOrCreateConversation({ userId: "alice", otherUserId: "bob" });

    await expect(
      chat.api.joinConversation({ userId: "carol", conversationId: group.id }),
    ).rejects.toMatchObject({ code: "NOT_PUBLIC_CONVERSATION" });
    await expect(
      chat.api.updateConversation({ userId: "alice", conversationId: dm.id, visibility: "public" }),
    ).rejects.toMatchObject({ code: "NOT_GROUP_CONVERSATION" });
  });

  it("writes a flip to both columns without disturbing the name", async () => {
    const group = await chat.api.createGroupConversation({ userId: "alice", name: "Standup" });

    await chat.api.updateConversation({
      userId: "alice",
      conversationId: group.id,
      visibility: "public",
      joinPolicy: "open",
    });

    const row = await pglite.query<{
      name: string | null;
      visibility: string;
      join_policy: string;
    }>(`SELECT "name", "visibility", "join_policy" FROM "chatpack_conversations" WHERE "id" = $1`, [
      group.id,
    ]);
    expect(row.rows[0]).toEqual({
      name: "Standup",
      visibility: "public",
      join_policy: "open",
    });
  });
});

describe("moderation on Postgres", () => {
  it("persists blocks, reports, workflow updates, and ban revocation", async () => {
    const staffChat = chatpack({
      storage: drizzleAdapter(db),
      telemetry: false,
      moderation: { canModerate: ({ user }) => user.id === "staff" },
    });
    const direct = await staffChat.api.getOrCreateConversation({
      userId: "alice",
      otherUserId: "bob",
    });
    const message = await staffChat.api.sendMessage({
      userId: "bob",
      conversationId: direct.id,
      body: "abuse",
    });

    await staffChat.api.moderation.blockUser({ userId: "alice", targetUserId: "bob" });
    expect(
      (await staffChat.api.moderation.listBlockedUsers({ userId: "alice" })).blocks,
    ).toHaveLength(1);

    const report = await staffChat.api.moderation.report({
      userId: "alice",
      targetType: "message",
      targetId: message.id,
      reason: "abuse",
    });
    expect(report.evidence).toMatchObject({ body: "abuse", senderId: "bob" });
    await staffChat.api.moderation.updateReport({
      userId: "staff",
      reportId: report.id,
      status: "resolved",
    });

    const ban = await staffChat.api.moderation.banUser({
      userId: "staff",
      targetUserId: "bob",
      reason: "abuse",
    });
    await expect(staffChat.api.listConversations({ userId: "bob" })).rejects.toMatchObject({
      code: "USER_BANNED",
    });
    await staffChat.api.moderation.unbanUser({ userId: "staff", banId: ban.id });
    await expect(staffChat.api.listConversations({ userId: "bob" })).resolves.toBeDefined();
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

      // Existing data, written before the upgrade - in raw SQL, because the
      // current adapter writes columns this old schema does not have yet
      // (`type`, `name`, `role`). Seeding through the adapter would only ever
      // test the adapter against a schema it just migrated.
      const legacyDb = drizzle(legacy) as unknown as DrizzlePgDatabase;
      const conversationId = "legacy_conv_1";
      await legacy.query(
        `INSERT INTO "chatpack_conversations"
           ("id", "pair_key", "created_at", "last_seq", "last_activity_at")
         VALUES ($1, 'alice:bob', now(), 1, now())`,
        [conversationId],
      );
      await legacy.query(
        `INSERT INTO "chatpack_conversation_participants"
           ("conversation_id", "user_id", "joined_at")
         VALUES ($1, 'alice', now()), ($1, 'bob', now())`,
        [conversationId],
      );
      await legacy.query(
        `INSERT INTO "chatpack_messages"
           ("id", "conversation_id", "sender_id", "body", "role", "seq", "created_at")
         VALUES ('legacy_1', $1, 'alice', 'written before the upgrade', 'user', 1, now())`,
        [conversationId],
      );
      const conversation = { id: conversationId };

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

      // ADR 0017: the pre-existing row is a DM, and the migration backfills both
      // its participants to admin so the roles are not silently wrong.
      const legacyConversation = await upgraded.api.getConversation({
        userId: "alice",
        conversationId: conversation.id,
      });
      expect(legacyConversation).toMatchObject({
        type: "direct",
        pairKey: "alice:bob",
        name: null,
      });
      expect(legacyConversation.participants.map((p) => p.role)).toEqual(["admin", "admin"]);

      // And groups work on the upgraded schema: the total unique index on
      // pair_key was replaced by a partial one, so a null pair key is allowed.
      const group = await upgraded.api.createGroupConversation({
        userId: "alice",
        userIds: ["bob"],
        name: "Post-upgrade group",
      });
      expect(group).toMatchObject({ type: "group", pairKey: null, name: "Post-upgrade group" });
      // DM uniqueness still holds after the index swap.
      expect(
        (await upgraded.api.getOrCreateConversation({ userId: "bob", otherUserId: "alice" })).id,
      ).toBe(conversation.id);

      // ADR 0020: the two channel columns arrive with defaults, so every row
      // written before the upgrade reads back as a private, approval-gated
      // conversation rather than as undefined.
      expect(legacyConversation).toMatchObject({
        visibility: "private",
        joinPolicy: "approval",
      });
      const published = await upgraded.api.updateConversation({
        userId: "alice",
        conversationId: group.id,
        visibility: "public",
        joinPolicy: "open",
      });
      expect(published).toMatchObject({ visibility: "public", joinPolicy: "open" });
      const { channels } = await upgraded.api.listPublicConversations({ userId: "carol" });
      expect(channels.map((c) => c.conversationId)).toEqual([group.id]);

      // And the migration stays idempotent when run a third time.
      await legacy.exec(migrationSql);
    } finally {
      await legacy.close();
    }
  });
});
