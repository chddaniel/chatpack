CREATE TABLE IF NOT EXISTS "chatpack_conversations" (
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
);
CREATE TABLE IF NOT EXISTS "chatpack_conversation_participants" (
  "conversation_id" text NOT NULL REFERENCES "chatpack_conversations"("id") ON DELETE CASCADE,
  "user_id" text NOT NULL,
  "role" text NOT NULL DEFAULT 'member',
  "joined_at" timestamptz NOT NULL,
  "last_read_message_id" text,
  PRIMARY KEY ("conversation_id", "user_id")
);
CREATE TABLE IF NOT EXISTS "chatpack_messages" (
  "id" text PRIMARY KEY,
  "conversation_id" text NOT NULL REFERENCES "chatpack_conversations"("id") ON DELETE CASCADE,
  "sender_id" text NOT NULL,
  "body" text NOT NULL,
  "role" text NOT NULL DEFAULT 'user',
  "seq" integer NOT NULL,
  "created_at" timestamptz NOT NULL,
  "edited_at" timestamptz,
  "deleted_at" timestamptz,
  "reply_to_message_id" text,
  "forwarded_from_message_id" text,
  "forwarded_from_conversation_id" text,
  "forwarded_from_sender_id" text,
  "metadata" jsonb NOT NULL DEFAULT '{}',
  UNIQUE ("conversation_id", "seq")
);
CREATE TABLE IF NOT EXISTS "chatpack_message_search_tokens" (
  "message_id" text NOT NULL REFERENCES "chatpack_messages"("id") ON DELETE CASCADE,
  "token" text NOT NULL,
  "occurrences" integer NOT NULL,
  PRIMARY KEY ("message_id", "token")
);
CREATE TABLE IF NOT EXISTS "chatpack_message_reactions" (
  "message_id" text NOT NULL REFERENCES "chatpack_messages"("id") ON DELETE CASCADE,
  "user_id" text NOT NULL,
  "emoji" text NOT NULL,
  "created_at" timestamptz NOT NULL,
  PRIMARY KEY ("message_id", "user_id", "emoji")
);
CREATE TABLE IF NOT EXISTS "chatpack_message_mentions" (
  "message_id" text NOT NULL REFERENCES "chatpack_messages"("id") ON DELETE CASCADE,
  "user_id" text NOT NULL,
  "created_at" timestamptz NOT NULL,
  PRIMARY KEY ("message_id", "user_id")
);
CREATE TABLE IF NOT EXISTS "chatpack_conversation_invites" (
  "code" text PRIMARY KEY,
  "conversation_id" text NOT NULL REFERENCES "chatpack_conversations"("id") ON DELETE CASCADE,
  "created_by" text NOT NULL,
  "created_at" timestamptz NOT NULL,
  "expires_at" timestamptz,
  "max_uses" integer,
  "uses" integer NOT NULL DEFAULT 0,
  "requires_approval" boolean NOT NULL DEFAULT false,
  "metadata" jsonb NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS "chatpack_join_requests" (
  "id" text PRIMARY KEY,
  "conversation_id" text NOT NULL REFERENCES "chatpack_conversations"("id") ON DELETE CASCADE,
  "user_id" text NOT NULL,
  "status" text NOT NULL DEFAULT 'pending',
  "message" text,
  "invite_code" text,
  "created_at" timestamptz NOT NULL,
  "resolved_at" timestamptz,
  "resolved_by" text,
  "metadata" jsonb NOT NULL DEFAULT '{}',
  UNIQUE ("conversation_id", "user_id")
);
CREATE TABLE IF NOT EXISTS "chatpack_user_blocks" (
  "blocker_user_id" text NOT NULL,
  "blocked_user_id" text NOT NULL,
  "created_at" timestamptz NOT NULL,
  PRIMARY KEY ("blocker_user_id", "blocked_user_id")
);
CREATE TABLE IF NOT EXISTS "chatpack_conversation_mutes" (
  "user_id" text NOT NULL,
  "conversation_id" text NOT NULL REFERENCES "chatpack_conversations"("id") ON DELETE CASCADE,
  "created_at" timestamptz NOT NULL,
  PRIMARY KEY ("user_id", "conversation_id")
);
CREATE TABLE IF NOT EXISTS "chatpack_moderation_reports" (
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
);
CREATE TABLE IF NOT EXISTS "chatpack_user_bans" (
  "id" text PRIMARY KEY,
  "user_id" text NOT NULL,
  "created_by_user_id" text NOT NULL,
  "reason" text,
  "created_at" timestamptz NOT NULL,
  "expires_at" timestamptz,
  "revoked_at" timestamptz,
  "revoked_by_user_id" text
);
CREATE INDEX IF NOT EXISTS "chatpack_conversations_activity_idx" ON "chatpack_conversations" ("last_activity_at", "id");
CREATE UNIQUE INDEX IF NOT EXISTS "chatpack_conversations_pair_key_unique_idx" ON "chatpack_conversations" ("pair_key");
CREATE INDEX IF NOT EXISTS "chatpack_conversations_public_idx" ON "chatpack_conversations" ("last_activity_at", "id") WHERE "visibility" = 'public' AND "type" = 'group';
CREATE INDEX IF NOT EXISTS "chatpack_participants_user_idx" ON "chatpack_conversation_participants" ("user_id");
CREATE INDEX IF NOT EXISTS "chatpack_messages_forwarded_from_idx" ON "chatpack_messages" ("forwarded_from_message_id") WHERE "forwarded_from_message_id" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "chatpack_message_search_tokens_token_idx" ON "chatpack_message_search_tokens" ("token", "message_id");
CREATE INDEX IF NOT EXISTS "chatpack_reactions_message_idx" ON "chatpack_message_reactions" ("message_id", "created_at");
CREATE INDEX IF NOT EXISTS "chatpack_mentions_message_idx" ON "chatpack_message_mentions" ("message_id", "created_at");
CREATE INDEX IF NOT EXISTS "chatpack_mentions_user_idx" ON "chatpack_message_mentions" ("user_id", "created_at");
CREATE INDEX IF NOT EXISTS "chatpack_invites_conversation_idx" ON "chatpack_conversation_invites" ("conversation_id", "created_at");
CREATE INDEX IF NOT EXISTS "chatpack_join_requests_status_idx" ON "chatpack_join_requests" ("conversation_id", "status", "created_at");
CREATE INDEX IF NOT EXISTS "chatpack_user_blocks_blocker_idx" ON "chatpack_user_blocks" ("blocker_user_id", "created_at");
CREATE INDEX IF NOT EXISTS "chatpack_conversation_mutes_user_idx" ON "chatpack_conversation_mutes" ("user_id", "created_at");
CREATE INDEX IF NOT EXISTS "chatpack_moderation_reports_queue_idx" ON "chatpack_moderation_reports" ("status", "created_at", "id");
CREATE INDEX IF NOT EXISTS "chatpack_moderation_reports_target_idx" ON "chatpack_moderation_reports" ("reporter_user_id", "target_type", "target_id", "status");
CREATE INDEX IF NOT EXISTS "chatpack_user_bans_active_idx" ON "chatpack_user_bans" ("user_id", "revoked_at", "expires_at");
CREATE INDEX IF NOT EXISTS "chatpack_user_bans_created_idx" ON "chatpack_user_bans" ("created_at", "id");
