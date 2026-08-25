CREATE TABLE "chatpack_conversation_invites" (
	"code" text PRIMARY KEY NOT NULL,
	"conversation_id" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone,
	"max_uses" integer,
	"uses" integer DEFAULT 0 NOT NULL,
	"requires_approval" boolean DEFAULT false NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chatpack_conversation_mutes" (
	"user_id" text NOT NULL,
	"conversation_id" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "chatpack_conversation_mutes_pk" PRIMARY KEY("user_id","conversation_id")
);
--> statement-breakpoint
CREATE TABLE "chatpack_conversation_participants" (
	"conversation_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"joined_at" timestamp with time zone NOT NULL,
	"last_read_message_id" text
);
--> statement-breakpoint
CREATE TABLE "chatpack_conversations" (
	"id" text PRIMARY KEY NOT NULL,
	"type" text DEFAULT 'direct' NOT NULL,
	"pair_key" text,
	"name" text,
	"visibility" text DEFAULT 'private' NOT NULL,
	"join_policy" text DEFAULT 'approval' NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_seq" integer DEFAULT 0 NOT NULL,
	"last_activity_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chatpack_join_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"conversation_id" text NOT NULL,
	"user_id" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"message" text,
	"invite_code" text,
	"created_at" timestamp with time zone NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolved_by" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chatpack_message_mentions" (
	"message_id" text NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chatpack_message_reactions" (
	"message_id" text NOT NULL,
	"user_id" text NOT NULL,
	"emoji" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chatpack_message_search_tokens" (
	"message_id" text NOT NULL,
	"token" text NOT NULL,
	"occurrences" integer NOT NULL,
	CONSTRAINT "chatpack_message_search_tokens_pk" PRIMARY KEY("message_id","token")
);
--> statement-breakpoint
CREATE TABLE "chatpack_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"conversation_id" text NOT NULL,
	"sender_id" text NOT NULL,
	"body" text NOT NULL,
	"role" text DEFAULT 'user' NOT NULL,
	"seq" bigint NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"edited_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"reply_to_message_id" text,
	"forwarded_from_message_id" text,
	"forwarded_from_conversation_id" text,
	"forwarded_from_sender_id" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chatpack_moderation_reports" (
	"id" text PRIMARY KEY NOT NULL,
	"reporter_user_id" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text NOT NULL,
	"reason" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"moderator_note" text,
	"evidence" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chatpack_user_bans" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"created_by_user_id" text NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_by_user_id" text
);
--> statement-breakpoint
CREATE TABLE "chatpack_user_blocks" (
	"blocker_user_id" text NOT NULL,
	"blocked_user_id" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "chatpack_user_blocks_pk" PRIMARY KEY("blocker_user_id","blocked_user_id")
);
--> statement-breakpoint
CREATE TABLE "accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp,
	"refresh_token_expires_at" timestamp,
	"scope" text,
	"password" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	CONSTRAINT "sessions_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "verifications" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "chatpack_conversation_invites" ADD CONSTRAINT "chatpack_conversation_invites_conversation_id_chatpack_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."chatpack_conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chatpack_conversation_mutes" ADD CONSTRAINT "chatpack_conversation_mutes_conversation_id_chatpack_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."chatpack_conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chatpack_conversation_participants" ADD CONSTRAINT "chatpack_conversation_participants_conversation_id_chatpack_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."chatpack_conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chatpack_join_requests" ADD CONSTRAINT "chatpack_join_requests_conversation_id_chatpack_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."chatpack_conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chatpack_message_mentions" ADD CONSTRAINT "chatpack_message_mentions_message_id_chatpack_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."chatpack_messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chatpack_message_reactions" ADD CONSTRAINT "chatpack_message_reactions_message_id_chatpack_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."chatpack_messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chatpack_message_search_tokens" ADD CONSTRAINT "chatpack_message_search_tokens_message_id_chatpack_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."chatpack_messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chatpack_messages" ADD CONSTRAINT "chatpack_messages_conversation_id_chatpack_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."chatpack_conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chatpack_invites_conversation_idx" ON "chatpack_conversation_invites" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE INDEX "chatpack_conversation_mutes_user_idx" ON "chatpack_conversation_mutes" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "chatpack_participants_conv_user_idx" ON "chatpack_conversation_participants" USING btree ("conversation_id","user_id");--> statement-breakpoint
CREATE INDEX "chatpack_participants_user_idx" ON "chatpack_conversation_participants" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "chatpack_conversations_pair_key_unique_idx" ON "chatpack_conversations" USING btree ("pair_key") WHERE "chatpack_conversations"."pair_key" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "chatpack_conversations_activity_idx" ON "chatpack_conversations" USING btree ("last_activity_at","id");--> statement-breakpoint
CREATE INDEX "chatpack_conversations_public_idx" ON "chatpack_conversations" USING btree ("last_activity_at","id") WHERE "chatpack_conversations"."visibility" = 'public';--> statement-breakpoint
CREATE UNIQUE INDEX "chatpack_join_requests_conv_user_idx" ON "chatpack_join_requests" USING btree ("conversation_id","user_id");--> statement-breakpoint
CREATE INDEX "chatpack_join_requests_status_idx" ON "chatpack_join_requests" USING btree ("conversation_id","status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "chatpack_mentions_msg_user_idx" ON "chatpack_message_mentions" USING btree ("message_id","user_id");--> statement-breakpoint
CREATE INDEX "chatpack_mentions_message_idx" ON "chatpack_message_mentions" USING btree ("message_id","created_at");--> statement-breakpoint
CREATE INDEX "chatpack_mentions_user_idx" ON "chatpack_message_mentions" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "chatpack_reactions_msg_user_emoji_idx" ON "chatpack_message_reactions" USING btree ("message_id","user_id","emoji");--> statement-breakpoint
CREATE INDEX "chatpack_reactions_message_idx" ON "chatpack_message_reactions" USING btree ("message_id","created_at");--> statement-breakpoint
CREATE INDEX "chatpack_message_search_tokens_token_idx" ON "chatpack_message_search_tokens" USING btree ("token","message_id");--> statement-breakpoint
CREATE UNIQUE INDEX "chatpack_messages_conv_seq_idx" ON "chatpack_messages" USING btree ("conversation_id","seq");--> statement-breakpoint
CREATE INDEX "chatpack_messages_forwarded_from_idx" ON "chatpack_messages" USING btree ("forwarded_from_message_id") WHERE "chatpack_messages"."forwarded_from_message_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "chatpack_moderation_reports_queue_idx" ON "chatpack_moderation_reports" USING btree ("status","created_at","id");--> statement-breakpoint
CREATE INDEX "chatpack_moderation_reports_target_idx" ON "chatpack_moderation_reports" USING btree ("reporter_user_id","target_type","target_id","status");--> statement-breakpoint
CREATE INDEX "chatpack_user_bans_active_idx" ON "chatpack_user_bans" USING btree ("user_id","revoked_at","expires_at");--> statement-breakpoint
CREATE INDEX "chatpack_user_bans_created_idx" ON "chatpack_user_bans" USING btree ("created_at","id");--> statement-breakpoint
CREATE INDEX "chatpack_user_blocks_blocker_idx" ON "chatpack_user_blocks" USING btree ("blocker_user_id","created_at");