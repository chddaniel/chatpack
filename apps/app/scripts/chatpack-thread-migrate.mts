/** Upgrade an existing app database before the thread feature is enabled. */
import { config } from "dotenv";
import { sql } from "drizzle-orm";

config({ path: process.env.NODE_ENV === "production" ? ".env" : ".env.local" });
config();

const statements = [
  'ALTER TABLE "chatpack_messages" ADD COLUMN IF NOT EXISTS "thread_root_message_id" text',
  'CREATE INDEX IF NOT EXISTS "chatpack_messages_thread_seq_idx" ON "chatpack_messages" ("thread_root_message_id", "seq")',
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
