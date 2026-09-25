/** Upgrade an existing app database before the thread feature is enabled. */
import { config } from "dotenv";
import { sql } from "drizzle-orm";

config({ path: process.env.NODE_ENV === "production" ? ".env" : ".env.local" });
config();

const statements = [
  'ALTER TABLE "chatpack_messages" ADD COLUMN IF NOT EXISTS "thread_root_message_id" text',
  'ALTER TABLE "chatpack_messages" ADD COLUMN IF NOT EXISTS "show_in_main" boolean NOT NULL DEFAULT false',
  'CREATE INDEX IF NOT EXISTS "chatpack_messages_thread_seq_idx" ON "chatpack_messages" ("thread_root_message_id", "seq")',
  `CREATE TABLE IF NOT EXISTS "chatpack_thread_follows" (
    "root_message_id" text NOT NULL REFERENCES "chatpack_messages"("id") ON DELETE CASCADE,
    "conversation_id" text NOT NULL REFERENCES "chatpack_conversations"("id") ON DELETE CASCADE,
    "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
    "last_read_seq" bigint NOT NULL DEFAULT 0,
    "muted" boolean NOT NULL DEFAULT false,
    "last_reply_at" timestamptz NOT NULL,
    "created_at" timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY ("root_message_id", "user_id")
  )`,
  'CREATE INDEX IF NOT EXISTS "chatpack_thread_follows_user_activity_idx" ON "chatpack_thread_follows" ("user_id", "last_reply_at")',
  `WITH roots AS (
    SELECT root.id, root.conversation_id, root.sender_id,
           max(reply.seq) AS last_seq, max(reply.created_at) AS last_reply_at
    FROM chatpack_messages AS root
    JOIN chatpack_messages AS reply ON reply.thread_root_message_id = root.id
    GROUP BY root.id, root.conversation_id, root.sender_id
  ), participants AS (
    SELECT id AS root_message_id, conversation_id, sender_id AS user_id FROM roots
    UNION
    SELECT reply.thread_root_message_id, reply.conversation_id, reply.sender_id
    FROM chatpack_messages AS reply WHERE reply.thread_root_message_id IS NOT NULL
  )
  INSERT INTO chatpack_thread_follows (root_message_id, conversation_id, user_id, last_read_seq, last_reply_at)
  SELECT p.root_message_id, p.conversation_id, p.user_id, r.last_seq, r.last_reply_at
  FROM participants AS p
  JOIN roots AS r ON r.id = p.root_message_id
  JOIN users AS u ON u.id = p.user_id
  JOIN chatpack_conversation_participants AS cp
    ON cp.conversation_id = p.conversation_id AND cp.user_id = p.user_id
  ON CONFLICT (root_message_id, user_id) DO NOTHING`,
  `CREATE TABLE IF NOT EXISTS "chatpack_thread_alerts" (
    "message_id" text NOT NULL REFERENCES "chatpack_messages"("id") ON DELETE CASCADE,
    "root_message_id" text NOT NULL REFERENCES "chatpack_messages"("id") ON DELETE CASCADE,
    "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
    "created_at" timestamptz NOT NULL DEFAULT now(),
    "email_sent_at" timestamptz,
    "push_sent_at" timestamptz,
    "email_attempts" integer NOT NULL DEFAULT 0,
    "push_attempts" integer NOT NULL DEFAULT 0,
    PRIMARY KEY ("message_id", "user_id")
  )`,
  'CREATE INDEX IF NOT EXISTS "chatpack_thread_alerts_user_idx" ON "chatpack_thread_alerts" ("user_id", "created_at")',
  `CREATE TABLE IF NOT EXISTS "chatpack_push_subscriptions" (
    "endpoint" text PRIMARY KEY,
    "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
    "p256dh" text NOT NULL,
    "auth" text NOT NULL,
    "created_at" timestamptz NOT NULL DEFAULT now()
  )`,
  'CREATE INDEX IF NOT EXISTS "chatpack_push_subscriptions_user_idx" ON "chatpack_push_subscriptions" ("user_id")',
];

if (process.argv.includes("--print")) {
  console.log(statements.map((statement) => `${statement};`).join("\n"));
  process.exit(0);
}

const { db, pool } = await import("../src/lib/db.js");
try {
  for (const statement of statements) await db.execute(sql.raw(statement));
} finally {
  await pool.end();
}
