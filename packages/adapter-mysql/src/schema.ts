/** Chatpack MySQL 8 schema. User ids are opaque application-owned strings. */
import {
  boolean,
  datetime,
  index,
  int,
  json,
  mysqlTable,
  primaryKey,
  text,
  uniqueIndex,
  varchar,
} from "drizzle-orm/mysql-core";
import type { Metadata, ModerationReport } from "@chatpack/core";

const id = (name: string) => varchar(name, { length: 255 });
const stamp = (name: string) => datetime(name, { mode: "date", fsp: 3 });
const nullableStamp = (name: string) => datetime(name, { mode: "date", fsp: 3 });
const metadataColumn = () => json("metadata").$type<Metadata>().notNull().default({});

export const conversations = mysqlTable(
  "chatpack_conversations",
  {
    id: id("id").primaryKey(),
    type: varchar("type", { length: 16 }).notNull().default("direct"),
    pairKey: varchar("pair_key", { length: 511 }),
    name: varchar("name", { length: 255 }),
    visibility: varchar("visibility", { length: 16 }).notNull().default("private"),
    joinPolicy: varchar("join_policy", { length: 16 }).notNull().default("approval"),
    createdAt: stamp("created_at").notNull(),
    metadata: metadataColumn(),
    lastSeq: int("last_seq").notNull().default(0),
    lastActivityAt: stamp("last_activity_at").notNull(),
  },
  (table) => [
    uniqueIndex("chatpack_conversations_pair_key_unique_idx").on(table.pairKey),
    index("chatpack_conversations_activity_idx").on(table.lastActivityAt, table.id),
    index("chatpack_conversations_public_idx").on(
      table.visibility,
      table.type,
      table.lastActivityAt,
      table.id,
    ),
  ],
);

export const conversationParticipants = mysqlTable(
  "chatpack_conversation_participants",
  {
    conversationId: id("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    userId: id("user_id").notNull(),
    role: varchar("role", { length: 16 }).notNull().default("member"),
    joinedAt: stamp("joined_at").notNull(),
    lastReadMessageId: id("last_read_message_id"),
  },
  (table) => [
    uniqueIndex("chatpack_participants_conv_user_idx").on(table.conversationId, table.userId),
    index("chatpack_participants_user_idx").on(table.userId),
  ],
);

export const messages = mysqlTable(
  "chatpack_messages",
  {
    id: id("id").primaryKey(),
    conversationId: id("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    senderId: id("sender_id").notNull(),
    body: text("body").notNull(),
    role: varchar("role", { length: 16 }).notNull().default("user"),
    seq: int("seq").notNull(),
    createdAt: stamp("created_at").notNull(),
    editedAt: nullableStamp("edited_at"),
    deletedAt: nullableStamp("deleted_at"),
    replyToMessageId: id("reply_to_message_id"),
    forwardedFromMessageId: id("forwarded_from_message_id"),
    forwardedFromConversationId: id("forwarded_from_conversation_id"),
    forwardedFromSenderId: id("forwarded_from_sender_id"),
    metadata: metadataColumn(),
  },
  (table) => [
    uniqueIndex("chatpack_messages_conv_seq_idx").on(table.conversationId, table.seq),
    index("chatpack_messages_forwarded_from_idx").on(table.forwardedFromMessageId),
  ],
);

export const messageSearchTokens = mysqlTable(
  "chatpack_message_search_tokens",
  {
    messageId: id("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    token: varchar("token", { length: 255 }).notNull(),
    occurrences: int("occurrences").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.messageId, table.token],
      name: "chatpack_message_search_tokens_pk",
    }),
    index("chatpack_message_search_tokens_token_idx").on(table.token, table.messageId),
  ],
);

export const messageReactions = mysqlTable(
  "chatpack_message_reactions",
  {
    messageId: id("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    userId: id("user_id").notNull(),
    emoji: varchar("emoji", { length: 32 }).notNull(),
    createdAt: stamp("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("chatpack_reactions_msg_user_emoji_idx").on(
      table.messageId,
      table.userId,
      table.emoji,
    ),
    index("chatpack_reactions_message_idx").on(table.messageId, table.createdAt),
  ],
);

export const messageMentions = mysqlTable(
  "chatpack_message_mentions",
  {
    messageId: id("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    userId: id("user_id").notNull(),
    createdAt: stamp("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("chatpack_mentions_msg_user_idx").on(table.messageId, table.userId),
    index("chatpack_mentions_message_idx").on(table.messageId, table.createdAt),
    index("chatpack_mentions_user_idx").on(table.userId, table.createdAt),
  ],
);

export const conversationInvites = mysqlTable(
  "chatpack_conversation_invites",
  {
    code: id("code").primaryKey(),
    conversationId: id("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    createdBy: id("created_by").notNull(),
    createdAt: stamp("created_at").notNull(),
    expiresAt: nullableStamp("expires_at"),
    maxUses: int("max_uses"),
    uses: int("uses").notNull().default(0),
    requiresApproval: boolean("requires_approval").notNull().default(false),
    metadata: metadataColumn(),
  },
  (table) => [index("chatpack_invites_conversation_idx").on(table.conversationId, table.createdAt)],
);

export const joinRequests = mysqlTable(
  "chatpack_join_requests",
  {
    id: id("id").primaryKey(),
    conversationId: id("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    userId: id("user_id").notNull(),
    status: varchar("status", { length: 16 }).notNull().default("pending"),
    message: text("message"),
    inviteCode: id("invite_code"),
    createdAt: stamp("created_at").notNull(),
    resolvedAt: nullableStamp("resolved_at"),
    resolvedBy: id("resolved_by"),
    metadata: metadataColumn(),
  },
  (table) => [
    uniqueIndex("chatpack_join_requests_conv_user_idx").on(table.conversationId, table.userId),
    index("chatpack_join_requests_status_idx").on(
      table.conversationId,
      table.status,
      table.createdAt,
    ),
  ],
);

export const userBlocks = mysqlTable(
  "chatpack_user_blocks",
  {
    blockerUserId: id("blocker_user_id").notNull(),
    blockedUserId: id("blocked_user_id").notNull(),
    createdAt: stamp("created_at").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.blockerUserId, table.blockedUserId],
      name: "chatpack_user_blocks_pk",
    }),
    index("chatpack_user_blocks_blocker_idx").on(table.blockerUserId, table.createdAt),
  ],
);

export const conversationMutes = mysqlTable(
  "chatpack_conversation_mutes",
  {
    userId: id("user_id").notNull(),
    conversationId: id("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    createdAt: stamp("created_at").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.userId, table.conversationId],
      name: "chatpack_conversation_mutes_pk",
    }),
    index("chatpack_conversation_mutes_user_idx").on(table.userId, table.createdAt),
  ],
);

export const moderationReports = mysqlTable(
  "chatpack_moderation_reports",
  {
    id: id("id").primaryKey(),
    reporterUserId: id("reporter_user_id").notNull(),
    targetType: varchar("target_type", { length: 16 }).notNull(),
    targetId: id("target_id").notNull(),
    reason: text("reason").notNull(),
    status: varchar("status", { length: 16 }).notNull().default("open"),
    moderatorNote: text("moderator_note"),
    evidence: json("evidence").$type<ModerationReport["evidence"]>().notNull(),
    createdAt: stamp("created_at").notNull(),
    updatedAt: stamp("updated_at").notNull(),
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

export const userBans = mysqlTable(
  "chatpack_user_bans",
  {
    id: id("id").primaryKey(),
    userId: id("user_id").notNull(),
    createdByUserId: id("created_by_user_id").notNull(),
    reason: text("reason"),
    createdAt: stamp("created_at").notNull(),
    expiresAt: nullableStamp("expires_at"),
    revokedAt: nullableStamp("revoked_at"),
    revokedByUserId: id("revoked_by_user_id"),
  },
  (table) => [
    index("chatpack_user_bans_active_idx").on(table.userId, table.revokedAt, table.expiresAt),
    index("chatpack_user_bans_created_idx").on(table.createdAt, table.id),
  ],
);

export const chatpackSchema = {
  conversations,
  conversationParticipants,
  messages,
  messageSearchTokens,
  messageMentions,
  messageReactions,
  conversationInvites,
  joinRequests,
  userBlocks,
  conversationMutes,
  moderationReports,
  userBans,
};

// Binary collation keeps opaque ids and canonical lowercase search tokens
// exact. A case/accent-insensitive collation would merge distinct user ids.
const tableOptions = "ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_bin";

/** MySQL 8 DDL. Each table includes its indexes, so rerunning is a no-op on a compatible schema. */
export const migrationStatements: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS chatpack_conversations (
  id varchar(255) NOT NULL, type varchar(16) NOT NULL DEFAULT 'direct', pair_key varchar(511) NULL,
  name varchar(255) NULL, visibility varchar(16) NOT NULL DEFAULT 'private', join_policy varchar(16) NOT NULL DEFAULT 'approval',
  created_at datetime(3) NOT NULL, metadata json NOT NULL DEFAULT ('{}'), last_seq int NOT NULL DEFAULT 0, last_activity_at datetime(3) NOT NULL,
  PRIMARY KEY (id), UNIQUE KEY chatpack_conversations_pair_key_unique_idx (pair_key),
  KEY chatpack_conversations_activity_idx (last_activity_at, id),
  KEY chatpack_conversations_public_idx (visibility, type, last_activity_at, id)
) ${tableOptions}`,
  `CREATE TABLE IF NOT EXISTS chatpack_conversation_participants (
  conversation_id varchar(255) NOT NULL, user_id varchar(255) NOT NULL, role varchar(16) NOT NULL DEFAULT 'member',
  joined_at datetime(3) NOT NULL, last_read_message_id varchar(255) NULL,
  UNIQUE KEY chatpack_participants_conv_user_idx (conversation_id, user_id), KEY chatpack_participants_user_idx (user_id),
  CONSTRAINT chatpack_participants_conversation_fk FOREIGN KEY (conversation_id) REFERENCES chatpack_conversations (id) ON DELETE CASCADE
) ${tableOptions}`,
  `CREATE TABLE IF NOT EXISTS chatpack_messages (
  id varchar(255) NOT NULL, conversation_id varchar(255) NOT NULL, sender_id varchar(255) NOT NULL, body text NOT NULL,
  role varchar(16) NOT NULL DEFAULT 'user', seq int NOT NULL, created_at datetime(3) NOT NULL, edited_at datetime(3) NULL, deleted_at datetime(3) NULL,
  reply_to_message_id varchar(255) NULL, forwarded_from_message_id varchar(255) NULL, forwarded_from_conversation_id varchar(255) NULL,
  forwarded_from_sender_id varchar(255) NULL, metadata json NOT NULL DEFAULT ('{}'), PRIMARY KEY (id),
  UNIQUE KEY chatpack_messages_conv_seq_idx (conversation_id, seq), KEY chatpack_messages_forwarded_from_idx (forwarded_from_message_id),
  CONSTRAINT chatpack_messages_conversation_fk FOREIGN KEY (conversation_id) REFERENCES chatpack_conversations (id) ON DELETE CASCADE
) ${tableOptions}`,
  `CREATE TABLE IF NOT EXISTS chatpack_message_search_tokens (
  message_id varchar(255) NOT NULL, token varchar(255) NOT NULL, occurrences int NOT NULL, PRIMARY KEY (message_id, token),
  KEY chatpack_message_search_tokens_token_idx (token, message_id),
  CONSTRAINT chatpack_search_tokens_message_fk FOREIGN KEY (message_id) REFERENCES chatpack_messages (id) ON DELETE CASCADE
) ${tableOptions}`,
  `CREATE TABLE IF NOT EXISTS chatpack_message_reactions (
  message_id varchar(255) NOT NULL, user_id varchar(255) NOT NULL, emoji varchar(32) NOT NULL, created_at datetime(3) NOT NULL,
  UNIQUE KEY chatpack_reactions_msg_user_emoji_idx (message_id, user_id, emoji), KEY chatpack_reactions_message_idx (message_id, created_at),
  CONSTRAINT chatpack_reactions_message_fk FOREIGN KEY (message_id) REFERENCES chatpack_messages (id) ON DELETE CASCADE
) ${tableOptions}`,
  `CREATE TABLE IF NOT EXISTS chatpack_message_mentions (
  message_id varchar(255) NOT NULL, user_id varchar(255) NOT NULL, created_at datetime(3) NOT NULL,
  UNIQUE KEY chatpack_mentions_msg_user_idx (message_id, user_id), KEY chatpack_mentions_message_idx (message_id, created_at), KEY chatpack_mentions_user_idx (user_id, created_at),
  CONSTRAINT chatpack_mentions_message_fk FOREIGN KEY (message_id) REFERENCES chatpack_messages (id) ON DELETE CASCADE
) ${tableOptions}`,
  `CREATE TABLE IF NOT EXISTS chatpack_conversation_invites (
  code varchar(255) NOT NULL, conversation_id varchar(255) NOT NULL, created_by varchar(255) NOT NULL, created_at datetime(3) NOT NULL,
  expires_at datetime(3) NULL, max_uses int NULL, uses int NOT NULL DEFAULT 0, requires_approval boolean NOT NULL DEFAULT false, metadata json NOT NULL DEFAULT ('{}'),
  PRIMARY KEY (code), KEY chatpack_invites_conversation_idx (conversation_id, created_at),
  CONSTRAINT chatpack_invites_conversation_fk FOREIGN KEY (conversation_id) REFERENCES chatpack_conversations (id) ON DELETE CASCADE
) ${tableOptions}`,
  `CREATE TABLE IF NOT EXISTS chatpack_join_requests (
  id varchar(255) NOT NULL, conversation_id varchar(255) NOT NULL, user_id varchar(255) NOT NULL, status varchar(16) NOT NULL DEFAULT 'pending',
  message text NULL, invite_code varchar(255) NULL, created_at datetime(3) NOT NULL, resolved_at datetime(3) NULL, resolved_by varchar(255) NULL, metadata json NOT NULL DEFAULT ('{}'),
  PRIMARY KEY (id), UNIQUE KEY chatpack_join_requests_conv_user_idx (conversation_id, user_id), KEY chatpack_join_requests_status_idx (conversation_id, status, created_at),
  CONSTRAINT chatpack_join_requests_conversation_fk FOREIGN KEY (conversation_id) REFERENCES chatpack_conversations (id) ON DELETE CASCADE
) ${tableOptions}`,
  `CREATE TABLE IF NOT EXISTS chatpack_user_blocks (
  blocker_user_id varchar(255) NOT NULL, blocked_user_id varchar(255) NOT NULL, created_at datetime(3) NOT NULL,
  PRIMARY KEY (blocker_user_id, blocked_user_id), KEY chatpack_user_blocks_blocker_idx (blocker_user_id, created_at)
) ${tableOptions}`,
  `CREATE TABLE IF NOT EXISTS chatpack_conversation_mutes (
  user_id varchar(255) NOT NULL, conversation_id varchar(255) NOT NULL, created_at datetime(3) NOT NULL,
  PRIMARY KEY (user_id, conversation_id), KEY chatpack_conversation_mutes_user_idx (user_id, created_at),
  CONSTRAINT chatpack_mutes_conversation_fk FOREIGN KEY (conversation_id) REFERENCES chatpack_conversations (id) ON DELETE CASCADE
) ${tableOptions}`,
  `CREATE TABLE IF NOT EXISTS chatpack_moderation_reports (
  id varchar(255) NOT NULL, reporter_user_id varchar(255) NOT NULL, target_type varchar(16) NOT NULL, target_id varchar(255) NOT NULL,
  reason text NOT NULL, status varchar(16) NOT NULL DEFAULT 'open', moderator_note text NULL, evidence json NOT NULL, created_at datetime(3) NOT NULL, updated_at datetime(3) NOT NULL,
  PRIMARY KEY (id), KEY chatpack_moderation_reports_queue_idx (status, created_at, id), KEY chatpack_moderation_reports_target_idx (reporter_user_id, target_type, target_id, status)
) ${tableOptions}`,
  `CREATE TABLE IF NOT EXISTS chatpack_user_bans (
  id varchar(255) NOT NULL, user_id varchar(255) NOT NULL, created_by_user_id varchar(255) NOT NULL, reason text NULL,
  created_at datetime(3) NOT NULL, expires_at datetime(3) NULL, revoked_at datetime(3) NULL, revoked_by_user_id varchar(255) NULL,
  PRIMARY KEY (id), KEY chatpack_user_bans_active_idx (user_id, revoked_at, expires_at), KEY chatpack_user_bans_created_idx (created_at, id)
) ${tableOptions}`,
];

export const migrationSql = `${migrationStatements.map((statement) => `${statement};`).join("\n\n")}\n`;
