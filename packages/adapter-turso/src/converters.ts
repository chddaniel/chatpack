import type {
  Conversation,
  ConversationInvite,
  ConversationMute,
  JoinRequest,
  JoinRequestStatus,
  Message,
  MessageMention,
  MessageRole,
  Metadata,
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
} from "./types";

export function toMessage(row: MessageRow): Message {
  return {
    id: row.id,
    conversationId: row.conversationId,
    senderId: row.senderId,
    body: row.body,
    role: row.role as MessageRole,
    seq: row.seq,
    createdAt: row.createdAt,
    editedAt: row.editedAt,
    deletedAt: row.deletedAt,
    replyToMessageId: row.replyToMessageId,
    forwardedFromMessageId: row.forwardedFromMessageId,
    forwardedFromConversationId: row.forwardedFromConversationId,
    forwardedFromSenderId: row.forwardedFromSenderId,
    metadata: (row.metadata ?? {}) as Metadata,
  };
}

export function toReaction(row: ReactionRow): Reaction {
  return {
    messageId: row.messageId,
    userId: row.userId,
    emoji: row.emoji,
    createdAt: row.createdAt,
  };
}

export function toMention(row: MentionRow): MessageMention {
  return {
    messageId: row.messageId,
    userId: row.userId,
    createdAt: row.createdAt,
  };
}

export function toInvite(row: InviteRow): ConversationInvite {
  return {
    code: row.code,
    conversationId: row.conversationId,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    maxUses: row.maxUses,
    uses: row.uses,
    requiresApproval: row.requiresApproval,
    metadata: (row.metadata ?? {}) as Metadata,
  };
}

export function toJoinRequest(row: JoinRequestRow): JoinRequest {
  return {
    id: row.id,
    conversationId: row.conversationId,
    userId: row.userId,
    // Plain text column, so an unrecognized value coerces to the safe default
    // rather than widening the domain type - same rule as `type`/`role`.
    status:
      row.status === "approved" || row.status === "denied"
        ? (row.status as JoinRequestStatus)
        : "pending",
    message: row.message,
    inviteCode: row.inviteCode,
    createdAt: row.createdAt,
    resolvedAt: row.resolvedAt,
    resolvedBy: row.resolvedBy,
    metadata: (row.metadata ?? {}) as Metadata,
  };
}

export function toBlock(row: BlockRow): UserBlock {
  return {
    blockerUserId: row.blockerUserId,
    blockedUserId: row.blockedUserId,
    createdAt: row.createdAt,
  };
}

export function toMute(row: MuteRow): ConversationMute {
  return { userId: row.userId, conversationId: row.conversationId, createdAt: row.createdAt };
}

export function toReport(row: ReportRow): ModerationReport {
  return {
    id: row.id,
    reporterUserId: row.reporterUserId,
    targetType: row.targetType as ModerationReport["targetType"],
    targetId: row.targetId,
    reason: row.reason,
    status: row.status as ModerationReport["status"],
    moderatorNote: row.moderatorNote,
    evidence: row.evidence as ModerationReport["evidence"],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function toBan(row: BanRow): UserBan {
  return {
    id: row.id,
    userId: row.userId,
    createdByUserId: row.createdByUserId,
    reason: row.reason,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt,
    revokedByUserId: row.revokedByUserId,
  };
}

export function toConversation(
  row: ConversationRow,
  participantRows: ParticipantRow[],
): Conversation {
  return {
    id: row.id,
    // `type` and `role` are plain text columns, so a row written by an older
    // version (or by hand) is coerced to the safe default rather than widening
    // the domain type (ADR 0017).
    type: row.type === "group" ? "group" : "direct",
    pairKey: row.pairKey,
    name: row.name,
    // Same coercion, same reason (ADR 0020): both default to the closed value,
    // so an unrecognized string reads as unlisted rather than as public.
    visibility: row.visibility === "public" ? "public" : "private",
    joinPolicy: row.joinPolicy === "open" ? "open" : "approval",
    createdAt: row.createdAt,
    metadata: (row.metadata ?? {}) as Metadata,
    participants: participantRows.map((p) => ({
      conversationId: p.conversationId,
      userId: p.userId,
      role: p.role === "admin" ? "admin" : "member",
      joinedAt: p.joinedAt,
      lastReadMessageId: p.lastReadMessageId,
    })),
  };
}
