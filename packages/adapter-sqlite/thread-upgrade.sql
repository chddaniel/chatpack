-- Run once on an existing database before enabling threads.
ALTER TABLE "chatpack_messages" ADD COLUMN "thread_root_message_id" text;
CREATE INDEX IF NOT EXISTS "chatpack_messages_thread_seq_idx"
  ON "chatpack_messages" ("thread_root_message_id", "seq");
