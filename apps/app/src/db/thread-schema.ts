import {
  bigint,
  boolean,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

import { conversations, messages } from "@chatpack/adapter-drizzle";
import { users } from "@/db/auth-schema";

/** Durable per-user state for a one-level message thread. */
export const threadFollows = pgTable(
  "chatpack_thread_follows",
  {
    rootMessageId: text("root_message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    lastReadSeq: bigint("last_read_seq", { mode: "number" }).notNull().default(0),
    muted: boolean("muted").notNull().default(false),
    lastReplyAt: timestamp("last_reply_at", { withTimezone: true, mode: "date" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.rootMessageId, table.userId] }),
    index("chatpack_thread_follows_user_activity_idx").on(table.userId, table.lastReplyAt),
  ],
);

/** One delivery job per recipient and reply. Senders never get a job. */
export const threadAlerts = pgTable(
  "chatpack_thread_alerts",
  {
    messageId: text("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    rootMessageId: text("root_message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    emailSentAt: timestamp("email_sent_at", { withTimezone: true, mode: "date" }),
    pushSentAt: timestamp("push_sent_at", { withTimezone: true, mode: "date" }),
    emailAttempts: integer("email_attempts").notNull().default(0),
    pushAttempts: integer("push_attempts").notNull().default(0),
  },
  (table) => [
    primaryKey({ columns: [table.messageId, table.userId] }),
    index("chatpack_thread_alerts_user_idx").on(table.userId, table.createdAt),
  ],
);

export const pushSubscriptions = pgTable(
  "chatpack_push_subscriptions",
  {
    endpoint: text("endpoint").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    p256dh: text("p256dh").notNull(),
    auth: text("auth").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => [index("chatpack_push_subscriptions_user_idx").on(table.userId)],
);
