ALTER TABLE "chatpack_messages" ADD COLUMN IF NOT EXISTS "show_in_main" boolean NOT NULL DEFAULT false;
