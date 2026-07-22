/**
 * M4 integration suite: the core engine running on real Postgres.
 *
 * Uses PGlite — actual Postgres compiled to WASM, in-process — so these tests
 * exercise real SQL semantics (unique indexes, ON CONFLICT, atomic UPDATE ...
 * RETURNING) with zero external setup, locally and in CI.
 *
 * M4 DoD (MVP §11): "example app runs on Postgres." The full engine test here
 * is the strong version of that; the example server's Postgres mode is the
 * demo version.
 */
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { chatpack, ChatpackError, type ChatpackInstance } from "@chatpack/core";
import { drizzleAdapter, migrationSql, type DrizzlePgDatabase } from "../src/index";

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
});
