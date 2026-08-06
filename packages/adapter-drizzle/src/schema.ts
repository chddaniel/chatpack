/**
 * The Chatpack Postgres schema (MVP §8), defined with Drizzle ORM.
 *
 * Five tables carry the whole durable domain:
 *
 * - `chatpack_conversations` - one row per conversation. DMs are unique per
 *   `pair_key` (see `docs/decisions/0002-pair-key.md`); groups carry a null
 *   pair key and an optional `name` (ADR 0017). Also holds the
 *   per-conversation `last_seq` counter (atomic message ordering, ADR 0003)
 *   and `last_activity_at` (most-recently-active conversation listing).
 * - `chatpack_conversation_participants` - exactly two rows per DM, N per
 *   group; carries each member's `role` (ADR 0017) and durable read-state
 *   (`last_read_message_id`).
 * - `chatpack_messages` - messages with monotonic `seq`, soft-delete, the
 *   optional `reply_to_message_id` quote pointer (ADR 0013), and the
 *   `metadata` escape hatch.
 * - `chatpack_message_search_tokens` - canonical case-insensitive search
 *   tokens and occurrence counts maintained by the Drizzle adapter.
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

import { sql } from "drizzle-orm";
import {
  bigint,
  index,
  integer,
  jsonb,
  primaryKey,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/** `chatpack_conversations` - one row per conversation (DM or group). */
export const conversations = pgTable(
  "chatpack_conversations",
  {
    id: text("id").primaryKey(),
    /** `"direct"` | `"group"` (`docs/decisions/0017`). */
    type: text("type").notNull().default("direct"),
    /**
     * Deterministic pair key (sorted user ids joined with ":") for DMs, unique
     * among them. **Null for groups**: two groups with identical membership are
     * still different groups (`docs/decisions/0017`).
     */
    pairKey: text("pair_key"),
    /** Group title, or null. DMs never carry one - the UI derives it. */
    name: text("name"),
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
    // Partial: DM uniqueness is still enforced by the database, while any number
    // of groups can coexist with a null pair key (`docs/decisions/0017`).
    // Renamed from `..._pair_key_idx`: a partial index cannot replace a total
    // one under the same name, so the migration drops the old name and creates
    // this one (both steps stay idempotent).
    uniqueIndex("chatpack_conversations_pair_key_unique_idx")
      .on(table.pairKey)
      .where(sql`${table.pairKey} IS NOT NULL`),
    index("chatpack_conversations_activity_idx").on(table.lastActivityAt, table.id),
  ],
);

/** `chatpack_conversation_participants` - two rows per DM, N per group. */
export const conversationParticipants = pgTable(
  "chatpack_conversation_participants",
  {
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    /** The developer's user id - never a foreign key (you own the users table). */
    userId: text("user_id").notNull(),
    /**
     * `"admin"` | `"member"` (`docs/decisions/0017`). Both DM participants are
     * admins: a DM has nothing to administer, and it keeps the column non-null.
     */
    role: text("role").notNull().default("member"),
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

/** Canonical tokens used by the Postgres search implementation. */
export const messageSearchTokens = pgTable(
  "chatpack_message_search_tokens",
  {
    messageId: text("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    token: text("token").notNull(),
    occurrences: integer("occurrences").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.messageId, table.token],
      name: "chatpack_message_search_tokens_pk",
    }),
    index("chatpack_message_search_tokens_token_idx").on(table.token, table.messageId),
  ],
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
  messageSearchTokens,
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
  "type" text NOT NULL DEFAULT 'direct',
  "pair_key" text,
  "name" text,
  "created_at" timestamptz NOT NULL,
  "metadata" jsonb NOT NULL DEFAULT '{}',
  "last_seq" integer NOT NULL DEFAULT 0,
  "last_activity_at" timestamptz NOT NULL
)`,
  // Upgrade path for deployments created before ADR 0017. The CREATE TABLE
  // above is a no-op on an existing table, so each change needs its own
  // idempotent statement. Every pre-0017 row is a DM with a pair key, which is
  // exactly what the `type` default and the NOT NULL drop preserve - no
  // backfill needed.
  `ALTER TABLE "chatpack_conversations"
  ADD COLUMN IF NOT EXISTS "type" text NOT NULL DEFAULT 'direct'`,
  `ALTER TABLE "chatpack_conversations"
  ADD COLUMN IF NOT EXISTS "name" text`,
  `ALTER TABLE "chatpack_conversations"
  ALTER COLUMN "pair_key" DROP NOT NULL`,
  // Replace the old total unique index with a partial one under a new name.
  // The rename is what makes the swap actually happen: `CREATE UNIQUE INDEX IF
  // NOT EXISTS` under the *old* name would silently no-op on an existing
  // deployment and leave the total index in place. The partial index states the
  // real invariant - "DMs are unique by pair key" - and keeps group rows, whose
  // pair key is null, out of the index entirely.
  `DROP INDEX IF EXISTS "chatpack_conversations_pair_key_idx"`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "chatpack_conversations_pair_key_unique_idx"
  ON "chatpack_conversations" ("pair_key") WHERE "pair_key" IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS "chatpack_conversations_activity_idx"
  ON "chatpack_conversations" ("last_activity_at", "id")`,
  `CREATE TABLE IF NOT EXISTS "chatpack_conversation_participants" (
  "conversation_id" text NOT NULL REFERENCES "chatpack_conversations"("id") ON DELETE CASCADE,
  "user_id" text NOT NULL,
  "role" text NOT NULL DEFAULT 'member',
  "joined_at" timestamptz NOT NULL,
  "last_read_message_id" text
)`,
  // Pre-0017 rows are all DM participants, and both DM participants are admins
  // (ADR 0017 §3) - so the new column is added as 'member' by default and then
  // backfilled to 'admin' for existing conversations. New groups write their
  // own roles explicitly, and the `type` filter keeps this from touching them.
  `ALTER TABLE "chatpack_conversation_participants"
  ADD COLUMN IF NOT EXISTS "role" text NOT NULL DEFAULT 'member'`,
  `UPDATE "chatpack_conversation_participants" AS p
  SET "role" = 'admin'
  WHERE "role" = 'member'
    AND EXISTS (
      SELECT 1 FROM "chatpack_conversations" AS c
      WHERE c."id" = p."conversation_id" AND c."type" = 'direct'
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
  `DROP INDEX IF EXISTS "chatpack_messages_body_search_idx"`,
  `CREATE TABLE IF NOT EXISTS "chatpack_message_search_tokens" (
  "message_id" text NOT NULL REFERENCES "chatpack_messages"("id") ON DELETE CASCADE,
  "token" text NOT NULL,
  "occurrences" integer NOT NULL,
  PRIMARY KEY ("message_id", "token")
)`,
  `CREATE INDEX IF NOT EXISTS "chatpack_message_search_tokens_token_idx"
  ON "chatpack_message_search_tokens" ("token", "message_id")`,
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
