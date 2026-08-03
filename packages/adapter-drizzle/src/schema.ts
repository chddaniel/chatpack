/**
 * The Chatpack Postgres schema (MVP §8), defined with Drizzle ORM.
 *
 * Four tables carry the whole durable domain:
 *
 * - `chatpack_conversations` - one row per 1:1 conversation, unique per
 *   `pair_key` (see `docs/decisions/0002-pair-key.md`). Also holds the
 *   per-conversation `last_seq` counter (atomic message ordering, ADR 0003)
 *   and `last_activity_at` (most-recently-active conversation listing).
 * - `chatpack_conversation_participants` - always exactly two rows per
 *   conversation; carries durable read-state (`last_read_message_id`).
 * - `chatpack_messages` - messages with monotonic `seq`, soft-delete, the
 *   optional `reply_to_message_id` quote pointer (ADR 0013), and the
 *   `metadata` escape hatch.
 * - `chatpack_message_reactions` - one row per (message, user, emoji), unique
 *   on the triple so reacting twice is idempotent (ADR 0013).
 *
 * Users are referenced **by id only** - Chatpack never owns a users table,
 * so there are no foreign keys into your `users` table (MVP §8).
 *
 * To create the tables, add these exports to your Drizzle schema and run your
 * usual `drizzle-kit` migration flow - or, for a quick start, execute
 * {@link migrationSql} (multi-statement drivers) or
 * {@link migrationStatements} (one-statement-per-call drivers like Neon HTTP).
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

/** `chatpack_conversations` - one row per 1:1 conversation. */
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
     * insert - the source of monotonic message ordering (ADR 0003).
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

/** `chatpack_conversation_participants` - two rows per conversation. */
export const conversationParticipants = pgTable(
  "chatpack_conversation_participants",
  {
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    /** The developer's user id - never a foreign key (you own the users table). */
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

/** `chatpack_messages` - messages with monotonic per-conversation `seq`. */
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
    /** "user" | "assistant" | "system" - AI escape hatch (MVP §5). */
    role: text("role").notNull().default("user"),
    /** Monotonic per-conversation sort key (ADR 0003). */
    seq: bigint("seq", { mode: "number" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
    editedAt: timestamp("edited_at", { withTimezone: true, mode: "date" }),
    deletedAt: timestamp("deleted_at", { withTimezone: true, mode: "date" }),
    /**
     * Quote-reply pointer (ADR 0013), or null for a normal message. No foreign
     * key: a reply must outlive its parent's row, and messages are only ever
     * soft-deleted anyway.
     */
    replyToMessageId: text("reply_to_message_id"),
    metadata: jsonb("metadata").notNull().default({}),
  },
  (table) => [uniqueIndex("chatpack_messages_conv_seq_idx").on(table.conversationId, table.seq)],
);

/** `chatpack_message_reactions` - one row per (message, user, emoji). */
export const messageReactions = pgTable(
  "chatpack_message_reactions",
  {
    messageId: text("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    /** The reacting user's id - never a foreign key (you own the users table). */
    userId: text("user_id").notNull(),
    /** Any non-empty string up to 32 chars; core validates (ADR 0013 §3). */
    emoji: text("emoji").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
  },
  (table) => [
    // The arbiter of idempotent reacting: ON CONFLICT DO NOTHING targets this.
    uniqueIndex("chatpack_reactions_msg_user_emoji_idx").on(
      table.messageId,
      table.userId,
      table.emoji,
    ),
    // Batched lookup of a whole message page's reactions, earliest-first.
    index("chatpack_reactions_message_idx").on(table.messageId, table.createdAt),
  ],
);

/** All Chatpack tables, ready to spread into a Drizzle schema object. */
export const chatpackSchema = {
  conversations,
  conversationParticipants,
  messages,
  messageReactions,
};

/**
 * The Chatpack DDL as individual statements (idempotent `IF NOT EXISTS`),
 * in dependency order.
 *
 * Use this instead of {@link migrationSql} with drivers that execute **one
 * statement per call** - e.g. Neon's HTTP driver (`@neondatabase/serverless`
 * `sql`), Cloudflare D1, or `@vercel/postgres` `sql`:
 *
 * ```ts
 * for (const statement of migrationStatements) await sql(statement);
 * ```
 */
export const migrationStatements: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS "chatpack_conversations" (
  "id" text PRIMARY KEY,
  "pair_key" text NOT NULL,
  "created_at" timestamptz NOT NULL,
  "metadata" jsonb NOT NULL DEFAULT '{}',
  "last_seq" integer NOT NULL DEFAULT 0,
  "last_activity_at" timestamptz NOT NULL
)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "chatpack_conversations_pair_key_idx"
  ON "chatpack_conversations" ("pair_key")`,
  `CREATE INDEX IF NOT EXISTS "chatpack_conversations_activity_idx"
  ON "chatpack_conversations" ("last_activity_at", "id")`,
  `CREATE TABLE IF NOT EXISTS "chatpack_conversation_participants" (
  "conversation_id" text NOT NULL REFERENCES "chatpack_conversations"("id") ON DELETE CASCADE,
  "user_id" text NOT NULL,
  "joined_at" timestamptz NOT NULL,
  "last_read_message_id" text
)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "chatpack_participants_conv_user_idx"
  ON "chatpack_conversation_participants" ("conversation_id", "user_id")`,
  `CREATE INDEX IF NOT EXISTS "chatpack_participants_user_idx"
  ON "chatpack_conversation_participants" ("user_id")`,
  `CREATE TABLE IF NOT EXISTS "chatpack_messages" (
  "id" text PRIMARY KEY,
  "conversation_id" text NOT NULL REFERENCES "chatpack_conversations"("id") ON DELETE CASCADE,
  "sender_id" text NOT NULL,
  "body" text NOT NULL,
  "role" text NOT NULL DEFAULT 'user',
  "seq" bigint NOT NULL,
  "created_at" timestamptz NOT NULL,
  "edited_at" timestamptz,
  "deleted_at" timestamptz,
  "reply_to_message_id" text,
  "metadata" jsonb NOT NULL DEFAULT '{}'
)`,
  // Upgrade path for deployments created before ADR 0013: the CREATE TABLE
  // above is a no-op on an existing table, so the new column needs its own
  // idempotent statement.
  `ALTER TABLE "chatpack_messages"
  ADD COLUMN IF NOT EXISTS "reply_to_message_id" text`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "chatpack_messages_conv_seq_idx"
  ON "chatpack_messages" ("conversation_id", "seq")`,
  `CREATE TABLE IF NOT EXISTS "chatpack_message_reactions" (
  "message_id" text NOT NULL REFERENCES "chatpack_messages"("id") ON DELETE CASCADE,
  "user_id" text NOT NULL,
  "emoji" text NOT NULL,
  "created_at" timestamptz NOT NULL
)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "chatpack_reactions_msg_user_emoji_idx"
  ON "chatpack_message_reactions" ("message_id", "user_id", "emoji")`,
  `CREATE INDEX IF NOT EXISTS "chatpack_reactions_message_idx"
  ON "chatpack_message_reactions" ("message_id", "created_at")`,
];

/**
 * Plain-SQL DDL for the Chatpack tables (idempotent `IF NOT EXISTS`), as one
 * multi-statement script.
 *
 * Handy for examples, tests, and quick starts with drivers that accept
 * multi-statement queries (node-postgres, postgres.js, PGlite). For drivers
 * that execute one statement per call (Neon HTTP, D1, Vercel Postgres), use
 * {@link migrationStatements} instead. For production apps, prefer generating
 * a real migration from the schema with `drizzle-kit`.
 */
export const migrationSql: string =
  migrationStatements.map((statement) => `${statement};`).join("\n\n") + "\n";
