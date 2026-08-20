import type {
  Conversation,
  ConversationInvite,
  ConversationMute,
  JoinRequest,
  Message,
  MessageMention,
  ModerationReport,
  Reaction,
  UserBan,
  UserBlock,
} from "@chatpack/core";
import type {
  BanRow,
  BlockRow,
  ConversationRow,
  InviteRow,
  JoinRequestRow,
  MentionRow,
  MessageRow,
  MuteRow,
  ParticipantRow,
  ReactionRow,
  ReportRow,
} from "./types.js";
import { date, metadata, nullableDate, seq } from "./utils.js";

export function message(row: MessageRow): Message {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    senderId: row.sender_id,
    body: row.body,
    role: row.role === "assistant" || row.role === "system" ? row.role : "user",
    seq: seq(row.seq),
    createdAt: date(row.created_at, "message.created_at"),
    editedAt: nullableDate(row.edited_at, "message.edited_at"),
    deletedAt: nullableDate(row.deleted_at, "message.deleted_at"),
    replyToMessageId: row.reply_to_message_id,
    forwardedFromMessageId: row.forwarded_from_message_id,
    forwardedFromConversationId: row.forwarded_from_conversation_id,
    forwardedFromSenderId: row.forwarded_from_sender_id,
    metadata: metadata(row.metadata),
  };
}

export function conversation(row: ConversationRow, participants: ParticipantRow[]): Conversation {
  return {
    id: row.id,
    type: row.type === "group" ? "group" : "direct",
    pairKey: row.pair_key,
    name: row.name,
    visibility: row.visibility === "public" ? "public" : "private",
    joinPolicy: row.join_policy === "open" ? "open" : "approval",
    createdAt: date(row.created_at, "conversation.created_at"),
    metadata: metadata(row.metadata),
    participants: participants
      .slice()
      .sort(
        (a, b) =>
          date(a.joined_at, "participant.joined_at").getTime() -
            date(b.joined_at, "participant.joined_at").getTime() ||
          a.user_id.localeCompare(b.user_id),
      )
      .map((participant) => ({
        conversationId: participant.conversation_id,
        userId: participant.user_id,
        role: participant.role === "admin" ? "admin" : "member",
        joinedAt: date(participant.joined_at, "participant.joined_at"),
        lastReadMessageId: participant.last_read_message_id,
      })),
  };
}

export function reaction(row: ReactionRow): Reaction {
  return {
    messageId: row.message_id,
    userId: row.user_id,
    emoji: row.emoji,
    createdAt: date(row.created_at, "reaction.created_at"),
  };
}

export function mention(row: MentionRow): MessageMention {
  return {
    messageId: row.message_id,
    userId: row.user_id,
    createdAt: date(row.created_at, "mention.created_at"),
  };
}

export function invite(row: InviteRow): ConversationInvite {
  return {
    code: row.code,
    conversationId: row.conversation_id,
    createdBy: row.created_by,
    createdAt: date(row.created_at, "invite.created_at"),
    expiresAt: nullableDate(row.expires_at, "invite.expires_at"),
    maxUses: row.max_uses,
    uses: row.uses,
    requiresApproval: row.requires_approval,
    metadata: metadata(row.metadata),
  };
}

export function joinRequest(row: JoinRequestRow): JoinRequest {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    userId: row.user_id,
    status: row.status === "approved" || row.status === "denied" ? row.status : "pending",
    message: row.message,
    inviteCode: row.invite_code,
    createdAt: date(row.created_at, "joinRequest.created_at"),
    resolvedAt: nullableDate(row.resolved_at, "joinRequest.resolved_at"),
    resolvedBy: row.resolved_by,
    metadata: metadata(row.metadata),
  };
}

export function block(row: BlockRow): UserBlock {
  return {
    blockerUserId: row.blocker_user_id,
    blockedUserId: row.blocked_user_id,
    createdAt: date(row.created_at, "block.created_at"),
  };
}

export function mute(row: MuteRow): ConversationMute {
  return {
    userId: row.user_id,
    conversationId: row.conversation_id,
    createdAt: date(row.created_at, "mute.created_at"),
  };
}

export function report(row: ReportRow): ModerationReport {
  return {
    id: row.id,
    reporterUserId: row.reporter_user_id,
    targetType: row.target_type as ModerationReport["targetType"],
    targetId: row.target_id,
    reason: row.reason,
    status: row.status as ModerationReport["status"],
    moderatorNote: row.moderator_note,
    evidence: row.evidence,
    createdAt: date(row.created_at, "report.created_at"),
    updatedAt: date(row.updated_at, "report.updated_at"),
  };
}

export function ban(row: BanRow): UserBan {
  return {
    id: row.id,
    userId: row.user_id,
    createdByUserId: row.created_by_user_id,
    reason: row.reason,
    createdAt: date(row.created_at, "ban.created_at"),
    expiresAt: nullableDate(row.expires_at, "ban.expires_at"),
    revokedAt: nullableDate(row.revoked_at, "ban.revoked_at"),
    revokedByUserId: row.revoked_by_user_id,
  };
}
