ALTER TABLE "chatpack_messages" ADD COLUMN IF NOT EXISTS "thread_root_message_id" text;
CREATE INDEX IF NOT EXISTS "chatpack_messages_thread_seq_idx"
  ON "chatpack_messages" ("thread_root_message_id", "seq")
  WHERE "thread_root_message_id" IS NOT NULL;
