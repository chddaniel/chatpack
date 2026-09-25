-- Run once on an existing database before enabling thread broadcast.
ALTER TABLE "chatpack_messages" ADD COLUMN "show_in_main" integer NOT NULL DEFAULT 0;
