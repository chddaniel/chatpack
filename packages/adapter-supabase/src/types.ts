import type { Metadata, ModerationReport } from "@chatpack/core";

export const TABLE = {
  conversations: "chatpack_conversations",
  participants: "chatpack_conversation_participants",
  messages: "chatpack_messages",
  searchTokens: "chatpack_message_search_tokens",
  reactions: "chatpack_message_reactions",
  mentions: "chatpack_message_mentions",
  invites: "chatpack_conversation_invites",
  joinRequests: "chatpack_join_requests",
  blocks: "chatpack_user_blocks",
  mutes: "chatpack_conversation_mutes",
  reports: "chatpack_moderation_reports",
  bans: "chatpack_user_bans",
} as const;

export const RPC = {
  direct: "chatpack_get_or_create_direct_conversation",
  group: "chatpack_create_group_conversation",
  message: "chatpack_add_message",
  updateMessage: "chatpack_update_message",
  mentions: "chatpack_replace_message_mentions",
  consumeInvite: "chatpack_consume_invite",
  createBan: "chatpack_create_ban",
  search: "chatpack_search_messages",
} as const;

export type Timestamp = string | Date | null;

export interface ConversationRow {
  id: string;
  type: string;
  pair_key: string | null;
  name: string | null;
  visibility: string;
  join_policy: string;
  created_at: Timestamp;
  metadata: Metadata | null;
  last_seq: number | string;
  last_activity_at: Timestamp;
}

export interface ParticipantRow {
  conversation_id: string;
  user_id: string;
  role: string;
  joined_at: Timestamp;
  last_read_message_id: string | null;
}

export interface MessageRow {
  id: string;
  conversation_id: string;
  sender_id: string;
  body: string;
  role: string;
  seq: number | string;
  created_at: Timestamp;
  edited_at: Timestamp;
  deleted_at: Timestamp;
  reply_to_message_id: string | null;
  forwarded_from_message_id: string | null;
  forwarded_from_conversation_id: string | null;
  forwarded_from_sender_id: string | null;
  metadata: Metadata | null;
}

export interface ReactionRow {
  message_id: string;
  user_id: string;
  emoji: string;
  created_at: Timestamp;
}

export interface MentionRow {
  message_id: string;
  user_id: string;
  created_at: Timestamp;
}

export interface InviteRow {
  code: string;
  conversation_id: string;
  created_by: string;
  created_at: Timestamp;
  expires_at: Timestamp;
  max_uses: number | null;
  uses: number;
  requires_approval: boolean;
  metadata: Metadata | null;
}

export interface JoinRequestRow {
  id: string;
  conversation_id: string;
  user_id: string;
  status: string;
  message: string | null;
  invite_code: string | null;
  created_at: Timestamp;
  resolved_at: Timestamp;
  resolved_by: string | null;
  metadata: Metadata | null;
}

export interface BlockRow {
  blocker_user_id: string;
  blocked_user_id: string;
  created_at: Timestamp;
}

export interface MuteRow {
  user_id: string;
  conversation_id: string;
  created_at: Timestamp;
}

export interface ReportRow {
  id: string;
  reporter_user_id: string;
  target_type: string;
  target_id: string;
  reason: string;
  status: string;
  moderator_note: string | null;
  evidence: ModerationReport["evidence"];
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface BanRow {
  id: string;
  user_id: string;
  created_by_user_id: string;
  reason: string | null;
  created_at: Timestamp;
  expires_at: Timestamp;
  revoked_at: Timestamp;
  revoked_by_user_id: string | null;
}

export interface SearchRow extends MessageRow {
  rank: number;
}

export interface DirectRpcRow {
  conversation_id: string;
  created: boolean;
}

export interface CountRow {
  conversation_id: string;
  count: number | string;
}

export interface CursorPage {
  activityMs: number;
  id: string;
}
