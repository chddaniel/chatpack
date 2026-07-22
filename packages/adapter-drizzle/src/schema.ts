/**
 * The Chatpack Postgres schema (MVP §8), defined with Drizzle ORM.
 *
 * Three tables carry the whole durable domain:
 *
 * - `chatpack_conversations` — one row per 1:1 conversation, unique per
 *   `pair_key` (see `docs/decisions/0002-pair-key.md`). Also holds the
 *   per-conversation `last_seq` counter (atomic message ordering, ADR 0003)
 *   and `last_activity_at` (most-recently-active conversation listing).
 * - `chatpack_conversation_participants` — always exactly two rows per
 *   conversation; carries durable read-state (`last_read_message_id`).
 * - `chatpack_messages` — messages with monotonic `seq`, soft-delete, and the
 *   `metadata` escape hatch.
 *
 * Users are referenced **by id only** — Chatpack never owns a users table,
 * so there are no foreign keys into your `users` table (MVP §8).
 *
 * To create the tables, add these exports to your Drizzle schema and run your
 * usual `drizzle-kit` migration flow — or execute {@link migrationSql} for a
 * quick start.
 *
 * @module
 */

import {
  bigint,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/** `chatpack_conversations` — one row per 1:1 conversation. */
export const conversations = pgTable(
  "chatpack_conversations",
  {
    id: text("id").primaryKey(),
    /** Deterministic pair key (sorted user ids joined with ":"), unique. */
    pairKey: text("pair_key").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
    metadata: jsonb("metadata").notNull().default({}),
    /**
     * The seq of the latest message (0 = none yet). Incremented atomically on
     * insert — the source of monotonic message ordering (ADR 0003).
     */
    lastSeq: integer("last_seq").notNull().default(0),
    /** Timestamp of the latest message (or creation). Drives list ordering. */
    lastActivityAt: timestamp("last_activity_at", { withTimezone: true, mode: "date" }).notNull(),
  },
  (table) => [
    uniqueIndex("chatpack_conversations_pair_key_idx").on(table.pairKey),
    index("chatpack_conversations_activity_idx").on(table.lastActivityAt, table.id),
  ],
);

/** `chatpack_conversation_participants` — two rows per conversation. */
export const conversationParticipants = pgTable(
  "chatpack_conversation_participants",
  {
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    /** The developer's user id — never a foreign key (you own the users table). */
    userId: text("user_id").notNull(),
    joinedAt: timestamp("joined_at", { withTimezone: true, mode: "date" }).notNull(),
    /** Durable read-state: last message this user has read (MVP §2). */
    lastReadMessageId: text("last_read_message_id"),
  },
  (table) => [
    uniqueIndex("chatpack_participants_conv_user_idx").on(table.conversationId, table.userId),
    index("chatpack_participants_user_idx").on(table.userId),
  ],
);

/** `chatpack_messages` — messages with monotonic per-conversation `seq`. */
export const messages = pgTable(
  "chatpack_messages",
  {
    id: text("id").primaryKey(),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    senderId: text("sender_id").notNull(),
    /** Empty string for soft-deleted messages (tombstone). */
    body: text("body").notNull(),
    /** "user" | "assistant" | "system" — AI escape hatch (MVP §5). */
    role: text("role").notNull().default("user"),
    /** Monotonic per-conversation sort key (ADR 0003). */
    seq: bigint("seq", { mode: "number" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
    editedAt: timestamp("edited_at", { withTimezone: true, mode: "date" }),
    deletedAt: timestamp("deleted_at", { withTimezone: true, mode: "date" }),
    metadata: jsonb("metadata").notNull().default({}),
  },
  (table) => [uniqueIndex("chatpack_messages_conv_seq_idx").on(table.conversationId, table.seq)],
);

/** All Chatpack tables, ready to spread into a Drizzle schema object. */
export const chatpackSchema = {
  conversations,
  conversationParticipants,
  messages,
};

/**
 * Plain-SQL DDL for the Chatpack tables (idempotent `IF NOT EXISTS`).
 *
 * Handy for examples, tests, and quick starts. For production apps, prefer
 * generating a real migration from the schema with `drizzle-kit`.
 */
export const migrationSql = `
CREATE TABLE IF NOT EXISTS "chatpack_conversations" (
  "id" text PRIMARY KEY,
  "pair_key" text NOT NULL,
  "created_at" timestamptz NOT NULL,
  "metadata" jsonb NOT NULL DEFAULT '{}',
  "last_seq" integer NOT NULL DEFAULT 0,
  "last_activity_at" timestamptz NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "chatpack_conversations_pair_key_idx"
  ON "chatpack_conversations" ("pair_key");
CREATE INDEX IF NOT EXISTS "chatpack_conversations_activity_idx"
  ON "chatpack_conversations" ("last_activity_at", "id");

CREATE TABLE IF NOT EXISTS "chatpack_conversation_participants" (
  "conversation_id" text NOT NULL REFERENCES "chatpack_conversations"("id") ON DELETE CASCADE,
  "user_id" text NOT NULL,
  "joined_at" timestamptz NOT NULL,
  "last_read_message_id" text
);
CREATE UNIQUE INDEX IF NOT EXISTS "chatpack_participants_conv_user_idx"
  ON "chatpack_conversation_participants" ("conversation_id", "user_id");
CREATE INDEX IF NOT EXISTS "chatpack_participants_user_idx"
  ON "chatpack_conversation_participants" ("user_id");

CREATE TABLE IF NOT EXISTS "chatpack_messages" (
  "id" text PRIMARY KEY,
  "conversation_id" text NOT NULL REFERENCES "chatpack_conversations"("id") ON DELETE CASCADE,
  "sender_id" text NOT NULL,
  "body" text NOT NULL,
  "role" text NOT NULL DEFAULT 'user',
  "seq" bigint NOT NULL,
  "created_at" timestamptz NOT NULL,
  "edited_at" timestamptz,
  "deleted_at" timestamptz,
  "metadata" jsonb NOT NULL DEFAULT '{}'
);
CREATE UNIQUE INDEX IF NOT EXISTS "chatpack_messages_conv_seq_idx"
  ON "chatpack_messages" ("conversation_id", "seq");
`;
