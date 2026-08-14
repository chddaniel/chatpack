/**
 * The Chatpack Postgres schema (MVP §8), defined with Drizzle ORM.
 *
 * Twelve tables carry the whole durable domain:
 *
 * - `chatpack_conversations` - one row per conversation. DMs are unique per
 *   `pair_key` (see `docs/decisions/0002-pair-key.md`); groups carry a null
 *   pair key and an optional `name` (ADR 0017). Also holds the
 *   per-conversation `last_seq` counter (atomic message ordering, ADR 0003),
 *   `last_activity_at` (most-recently-active conversation listing), and the
 *   `visibility`/`join_policy` channel columns (ADR 0020).
 * - `chatpack_conversation_participants` - exactly two rows per DM, N per
 *   group; carries each member's `role` (ADR 0017) and durable read-state
 *   (`last_read_message_id`).
 * - `chatpack_messages` - messages with monotonic `seq`, soft-delete, the
 *   optional `reply_to_message_id` quote pointer (ADR 0013), the frozen
 *   `forwarded_from_*` provenance columns (ADR 0024), and the `metadata`
 *   escape hatch.
 * - `chatpack_message_search_tokens` - canonical case-insensitive search
 *   tokens and occurrence counts maintained by the Drizzle adapter.
 * - `chatpack_message_reactions` - one row per (message, user, emoji), unique
 *   on the triple so reacting twice is idempotent (ADR 0013).
 * - `chatpack_message_mentions` - one row per (message, user), unique on the
 *   pair so a mention set is a set (ADR 0023).
 * - `chatpack_conversation_invites` - shareable invite links, keyed by their
 *   own secret `code`, with expiry and use limits (ADR 0019).
 * - `chatpack_join_requests` - pending/approved/denied requests to join a
 *   group, one row per (conversation, user) (ADR 0019).
 * - `chatpack_user_blocks` and `chatpack_conversation_mutes` - private
 *   moderation preferences.
 * - `chatpack_moderation_reports` - immutable report evidence and lifecycle.
 * - `chatpack_user_bans` - durable active and revoked bans.
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
  boolean,
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
    /**
     * `"private"` | `"public"` (`docs/decisions/0020`). Public groups appear in
     * the channel directory; everything else is unlisted, which is the default
     * so existing rows keep their current behavior after the migration.
     */
    visibility: text("visibility").notNull().default("private"),
    /**
     * `"open"` | `"approval"` (`docs/decisions/0020`). How a stranger who found
     * a public channel gets in. Inert while `visibility` is `"private"`;
     * defaults to the safer of the two.
     */
    joinPolicy: text("join_policy").notNull().default("approval"),
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
    // Partial, on the same (activity, id) keyset the directory pages by: public
    // channels are a small minority of rows, so indexing only them keeps the
    // directory query off a full scan without paying for every DM
    // (`docs/decisions/0020`).
    index("chatpack_conversations_public_idx")
      .on(table.lastActivityAt, table.id)
      .where(sql`${table.visibility} = 'public'`),
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
    /**
     * Forward provenance (ADR 0024) - all three null for an ordinary message,
     * all three set on a forward. Frozen at write time and never re-resolved, so
     * deleting the source or losing access to it changes nothing here. No
     * foreign keys, for the same reason as `reply_to_message_id`, plus one more:
     * the source conversation may be deleted while the forward must survive.
     */
    forwardedFromMessageId: text("forwarded_from_message_id"),
    forwardedFromConversationId: text("forwarded_from_conversation_id"),
    forwardedFromSenderId: text("forwarded_from_sender_id"),
    metadata: jsonb("metadata").notNull().default({}),
  },
  (table) => [
    uniqueIndex("chatpack_messages_conv_seq_idx").on(table.conversationId, table.seq),
    // "What was forwarded from this message" - not a query core makes, but the
    // one an app builds a "shared N times" affordance on. Partial, because a
    // btree indexes nulls too and almost every row here is null - the same
    // reason `pair_key`'s index is partial.
    index("chatpack_messages_forwarded_from_idx")
      .on(table.forwardedFromMessageId)
      .where(sql`${table.forwardedFromMessageId} IS NOT NULL`),
  ],
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

/**
 * `chatpack_message_mentions` - one row per (message, user) (ADR 0023 §4).
 *
 * Its own table rather than a `text[]` or a jsonb array on the message: the
 * unique index is what makes a mention set a *set*, and "messages that mention
 * me" is the query every app eventually writes, which an array column cannot
 * serve without a GIN index that costs more than this table does.
 *
 * The ids here were validated against the conversation's membership at write
 * time and are **not** re-validated on read: someone who has since left keeps
 * their mention, because it was true when it was made (ADR 0023 §3).
 */
export const messageMentions = pgTable(
  "chatpack_message_mentions",
  {
    messageId: text("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    /** The mentioned user's id - never a foreign key (you own the users table). */
    userId: text("user_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
  },
  (table) => [
    // The arbiter of "a mention set is a set": the upsert targets this.
    uniqueIndex("chatpack_mentions_msg_user_idx").on(table.messageId, table.userId),
    // Batched lookup of a whole message page's mentions, earliest-first.
    index("chatpack_mentions_message_idx").on(table.messageId, table.createdAt),
    // "Messages that mention me", newest-first - core does not query this (a
    // mention inbox is out of scope, ADR 0023), but an app cannot build one
    // without it and adding an index later means locking the table.
    index("chatpack_mentions_user_idx").on(table.userId, table.createdAt),
  ],
);

/**
 * `chatpack_conversation_invites` - one row per invite link (ADR 0019).
 *
 * The `code` is the primary key because it is the identity *and* the secret:
 * possession is the permission, like a document share link. Stored in plaintext
 * rather than hashed so an admin can re-display a link they already handed out
 * (ADR 0019 §3) - revocation, `expires_at` and `max_uses` are what bound it.
 */
export const conversationInvites = pgTable(
  "chatpack_conversation_invites",
  {
    /** 32 random bytes as base64url, generated by core - never by the adapter. */
    code: text("code").primaryKey(),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    /** Who minted it - never a foreign key (you own the users table). */
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
    /** Null never expires. */
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }),
    /** Null is unlimited. */
    maxUses: integer("max_uses"),
    uses: integer("uses").notNull().default(0),
    /** When true, redeeming creates a join request instead of joining. */
    requiresApproval: boolean("requires_approval").notNull().default(false),
    metadata: jsonb("metadata").notNull().default({}),
  },
  (table) => [
    // Listing a group's invites, newest-first - the admin screen's only query.
    index("chatpack_invites_conversation_idx").on(table.conversationId, table.createdAt),
  ],
);

/**
 * `chatpack_join_requests` - one row per (conversation, user) (ADR 0019).
 *
 * Unique on the pair rather than accumulating history: a user who was denied
 * and asks again replaces their old row, so the moderation queue can never be
 * flooded by one requester (ADR 0019 §5).
 */
export const joinRequests = pgTable(
  "chatpack_join_requests",
  {
    id: text("id").primaryKey(),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    /** The requester's id - never a foreign key (you own the users table). */
    userId: text("user_id").notNull(),
    /** `"pending"` | `"approved"` | `"denied"`. */
    status: text("status").notNull().default("pending"),
    /** The requester's optional note; core caps the length. */
    message: text("message"),
    /**
     * The invite that produced this request, or null for a direct ask. No
     * foreign key: a request must outlive a revoked invite, so an admin can
     * still see where it came from.
     */
    inviteCode: text("invite_code"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true, mode: "date" }),
    resolvedBy: text("resolved_by"),
    metadata: jsonb("metadata").notNull().default({}),
  },
  (table) => [
    // The arbiter of "one request per user per group": the upsert targets this.
    uniqueIndex("chatpack_join_requests_conv_user_idx").on(table.conversationId, table.userId),
    // The moderation queue: pending requests for one group, newest-first.
    index("chatpack_join_requests_status_idx").on(
      table.conversationId,
      table.status,
      table.createdAt,
    ),
  ],
);

/** One private block relation. User ids are owned by the host application. */
export const userBlocks = pgTable(
  "chatpack_user_blocks",
  {
    blockerUserId: text("blocker_user_id").notNull(),
    blockedUserId: text("blocked_user_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.blockerUserId, table.blockedUserId],
      name: "chatpack_user_blocks_pk",
    }),
    index("chatpack_user_blocks_blocker_idx").on(table.blockerUserId, table.createdAt),
  ],
);

/** Per-user notification preference for one conversation. */
export const conversationMutes = pgTable(
  "chatpack_conversation_mutes",
  {
    userId: text("user_id").notNull(),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.userId, table.conversationId],
      name: "chatpack_conversation_mutes_pk",
    }),
    index("chatpack_conversation_mutes_user_idx").on(table.userId, table.createdAt),
  ],
);

/** Durable abuse report with immutable submit-time evidence. */
export const moderationReports = pgTable(
  "chatpack_moderation_reports",
  {
    id: text("id").primaryKey(),
    reporterUserId: text("reporter_user_id").notNull(),
    targetType: text("target_type").notNull(),
    targetId: text("target_id").notNull(),
    reason: text("reason").notNull(),
    status: text("status").notNull().default("open"),
    moderatorNote: text("moderator_note"),
    evidence: jsonb("evidence").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull(),
  },
  (table) => [
    index("chatpack_moderation_reports_queue_idx").on(table.status, table.createdAt, table.id),
    index("chatpack_moderation_reports_target_idx").on(
      table.reporterUserId,
      table.targetType,
      table.targetId,
      table.status,
    ),
  ],
);

/** Durable account bans. Revocation is recorded instead of deleting history. */
export const userBans = pgTable(
  "chatpack_user_bans",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    createdByUserId: text("created_by_user_id").notNull(),
    reason: text("reason"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }),
    revokedAt: timestamp("revoked_at", { withTimezone: true, mode: "date" }),
    revokedByUserId: text("revoked_by_user_id"),
  },
  (table) => [
    index("chatpack_user_bans_active_idx").on(table.userId, table.revokedAt, table.expiresAt),
    index("chatpack_user_bans_created_idx").on(table.createdAt, table.id),
  ],
);

/** All Chatpack tables, ready to spread into a Drizzle schema object. */
export const chatpackSchema = {
  conversations,
  conversationParticipants,
  messages,
  messageSearchTokens,
  messageReactions,
  messageMentions,
  conversationInvites,
  joinRequests,
  userBlocks,
  conversationMutes,
  moderationReports,
  userBans,
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
  "visibility" text NOT NULL DEFAULT 'private',
  "join_policy" text NOT NULL DEFAULT 'approval',
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
  // ADR 0020. Two column additions with defaults that reproduce today's
  // behavior, so existing rows need no backfill: every conversation that
  // predates channels is unlisted, which is what 'private' says. Postgres 11+
  // adds a defaulted column without rewriting the table.
  `ALTER TABLE "chatpack_conversations"
  ADD COLUMN IF NOT EXISTS "visibility" text NOT NULL DEFAULT 'private'`,
  `ALTER TABLE "chatpack_conversations"
  ADD COLUMN IF NOT EXISTS "join_policy" text NOT NULL DEFAULT 'approval'`,
  `CREATE INDEX IF NOT EXISTS "chatpack_conversations_public_idx"
  ON "chatpack_conversations" ("last_activity_at", "id") WHERE "visibility" = 'public'`,
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
  "forwarded_from_message_id" text,
  "forwarded_from_conversation_id" text,
  "forwarded_from_sender_id" text,
  "metadata" jsonb NOT NULL DEFAULT '{}'
)`,
  // Upgrade path for deployments created before ADR 0013: the CREATE TABLE
  // above is a no-op on an existing table, so the new column needs its own
  // idempotent statement.
  `ALTER TABLE "chatpack_messages"
  ADD COLUMN IF NOT EXISTS "reply_to_message_id" text`,
  // ADR 0024. Three nullable columns, no default and no backfill: every message
  // that predates forwarding was not forwarded, which is what null says. Pure
  // addition, so this is safe to run before deploying the new code.
  `ALTER TABLE "chatpack_messages"
  ADD COLUMN IF NOT EXISTS "forwarded_from_message_id" text`,
  `ALTER TABLE "chatpack_messages"
  ADD COLUMN IF NOT EXISTS "forwarded_from_conversation_id" text`,
  `ALTER TABLE "chatpack_messages"
  ADD COLUMN IF NOT EXISTS "forwarded_from_sender_id" text`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "chatpack_messages_conv_seq_idx"
  ON "chatpack_messages" ("conversation_id", "seq")`,
  `CREATE INDEX IF NOT EXISTS "chatpack_messages_forwarded_from_idx"
  ON "chatpack_messages" ("forwarded_from_message_id")
  WHERE "forwarded_from_message_id" IS NOT NULL`,
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
  // ADR 0023. A pure table addition, like the 0019 tables - safe to run before
  // deploying the new code.
  `CREATE TABLE IF NOT EXISTS "chatpack_message_mentions" (
  "message_id" text NOT NULL REFERENCES "chatpack_messages"("id") ON DELETE CASCADE,
  "user_id" text NOT NULL,
  "created_at" timestamptz NOT NULL
)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "chatpack_mentions_msg_user_idx"
  ON "chatpack_message_mentions" ("message_id", "user_id")`,
  `CREATE INDEX IF NOT EXISTS "chatpack_mentions_message_idx"
  ON "chatpack_message_mentions" ("message_id", "created_at")`,
  `CREATE INDEX IF NOT EXISTS "chatpack_mentions_user_idx"
  ON "chatpack_message_mentions" ("user_id", "created_at")`,
  // ADR 0019. Unlike the 0017 migration these are pure table additions - no
  // column changes and no index swaps on existing tables - so running this
  // before deploying the new code is safe.
  `CREATE TABLE IF NOT EXISTS "chatpack_conversation_invites" (
  "code" text PRIMARY KEY,
  "conversation_id" text NOT NULL REFERENCES "chatpack_conversations"("id") ON DELETE CASCADE,
  "created_by" text NOT NULL,
  "created_at" timestamptz NOT NULL,
  "expires_at" timestamptz,
  "max_uses" integer,
  "uses" integer NOT NULL DEFAULT 0,
  "requires_approval" boolean NOT NULL DEFAULT false,
  "metadata" jsonb NOT NULL DEFAULT '{}'
)`,
  `CREATE INDEX IF NOT EXISTS "chatpack_invites_conversation_idx"
  ON "chatpack_conversation_invites" ("conversation_id", "created_at")`,
  `CREATE TABLE IF NOT EXISTS "chatpack_join_requests" (
  "id" text PRIMARY KEY,
  "conversation_id" text NOT NULL REFERENCES "chatpack_conversations"("id") ON DELETE CASCADE,
  "user_id" text NOT NULL,
  "status" text NOT NULL DEFAULT 'pending',
  "message" text,
  "invite_code" text,
  "created_at" timestamptz NOT NULL,
  "resolved_at" timestamptz,
  "resolved_by" text,
  "metadata" jsonb NOT NULL DEFAULT '{}'
)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "chatpack_join_requests_conv_user_idx"
  ON "chatpack_join_requests" ("conversation_id", "user_id")`,
  `CREATE INDEX IF NOT EXISTS "chatpack_join_requests_status_idx"
  ON "chatpack_join_requests" ("conversation_id", "status", "created_at")`,
  `CREATE TABLE IF NOT EXISTS "chatpack_user_blocks" (
  "blocker_user_id" text NOT NULL,
  "blocked_user_id" text NOT NULL,
  "created_at" timestamptz NOT NULL,
  PRIMARY KEY ("blocker_user_id", "blocked_user_id")
)`,
  `CREATE INDEX IF NOT EXISTS "chatpack_user_blocks_blocker_idx"
  ON "chatpack_user_blocks" ("blocker_user_id", "created_at")`,
  `CREATE TABLE IF NOT EXISTS "chatpack_conversation_mutes" (
  "user_id" text NOT NULL,
  "conversation_id" text NOT NULL REFERENCES "chatpack_conversations"("id") ON DELETE CASCADE,
  "created_at" timestamptz NOT NULL,
  PRIMARY KEY ("user_id", "conversation_id")
)`,
  `CREATE INDEX IF NOT EXISTS "chatpack_conversation_mutes_user_idx"
  ON "chatpack_conversation_mutes" ("user_id", "created_at")`,
  `CREATE TABLE IF NOT EXISTS "chatpack_moderation_reports" (
  "id" text PRIMARY KEY,
  "reporter_user_id" text NOT NULL,
  "target_type" text NOT NULL,
  "target_id" text NOT NULL,
  "reason" text NOT NULL,
  "status" text NOT NULL DEFAULT 'open',
  "moderator_note" text,
  "evidence" jsonb NOT NULL,
  "created_at" timestamptz NOT NULL,
  "updated_at" timestamptz NOT NULL
)`,
  `CREATE INDEX IF NOT EXISTS "chatpack_moderation_reports_queue_idx"
  ON "chatpack_moderation_reports" ("status", "created_at", "id")`,
  `CREATE INDEX IF NOT EXISTS "chatpack_moderation_reports_target_idx"
  ON "chatpack_moderation_reports" ("reporter_user_id", "target_type", "target_id", "status")`,
  `CREATE TABLE IF NOT EXISTS "chatpack_user_bans" (
  "id" text PRIMARY KEY,
  "user_id" text NOT NULL,
  "created_by_user_id" text NOT NULL,
  "reason" text,
  "created_at" timestamptz NOT NULL,
  "expires_at" timestamptz,
  "revoked_at" timestamptz,
  "revoked_by_user_id" text
)`,
  `CREATE INDEX IF NOT EXISTS "chatpack_user_bans_active_idx"
  ON "chatpack_user_bans" ("user_id", "revoked_at", "expires_at")`,
  `CREATE INDEX IF NOT EXISTS "chatpack_user_bans_created_idx"
  ON "chatpack_user_bans" ("created_at", "id")`,
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
