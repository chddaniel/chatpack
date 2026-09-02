import type {
  Conversation,
  ConversationInvite,
  ConversationMute,
  JoinRequest,
  JoinRequestStatus,
  Message,
  MessageMention,
  MessageRole,
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
import { asDate, metadata, nullableDate, seq } from "./utils";

export function toMessage(row: MessageRow): Message {
  return {
    id: row.id,
    conversationId: row.conversationId,
    senderId: row.senderId,
    body: row.body,
    role: row.role === "assistant" || row.role === "system" ? (row.role as MessageRole) : "user",
    seq: seq(row.seq),
    createdAt: asDate(row.createdAt, "message.createdAt"),
    editedAt: nullableDate(row.editedAt, "message.editedAt"),
    deletedAt: nullableDate(row.deletedAt, "message.deletedAt"),
    replyToMessageId: row.replyToMessageId,
    forwardedFromMessageId: row.forwardedFromMessageId,
    forwardedFromConversationId: row.forwardedFromConversationId,
    forwardedFromSenderId: row.forwardedFromSenderId,
    metadata: metadata(row.metadata),
  };
}

export function toConversation(
  row: ConversationRow,
  participantRows: ParticipantRow[],
): Conversation {
  return {
    id: row.id,
    type: row.type === "group" ? "group" : "direct",
    pairKey: row.pairKey,
    name: row.name,
    visibility: row.visibility === "public" ? "public" : "private",
    joinPolicy: row.joinPolicy === "open" ? "open" : "approval",
    createdAt: asDate(row.createdAt, "conversation.createdAt"),
    metadata: metadata(row.metadata),
    participants: participantRows
      .slice()
      .sort(
        (a, b) =>
          asDate(a.joinedAt, "participant.joinedAt").getTime() -
            asDate(b.joinedAt, "participant.joinedAt").getTime() ||
          a.userId.localeCompare(b.userId),
      )
      .map((participant) => ({
        conversationId: participant.conversationId,
        userId: participant.userId,
        role: participant.role === "admin" ? "admin" : "member",
        joinedAt: asDate(participant.joinedAt, "participant.joinedAt"),
        lastReadMessageId: participant.lastReadMessageId,
      })),
  };
}

export function toReaction(row: ReactionRow): Reaction {
  return {
    messageId: row.messageId,
    userId: row.userId,
    emoji: row.emoji,
    createdAt: asDate(row.createdAt, "reaction.createdAt"),
  };
}
export function toMention(row: MentionRow): MessageMention {
  return {
    messageId: row.messageId,
    userId: row.userId,
    createdAt: asDate(row.createdAt, "mention.createdAt"),
  };
}
export function toInvite(row: InviteRow): ConversationInvite {
  return {
    code: row.code,
    conversationId: row.conversationId,
    createdBy: row.createdBy,
    createdAt: asDate(row.createdAt, "invite.createdAt"),
    expiresAt: nullableDate(row.expiresAt, "invite.expiresAt"),
    maxUses: row.maxUses,
    uses: row.uses,
    requiresApproval: row.requiresApproval,
    metadata: metadata(row.metadata),
  };
}
export function toJoinRequest(row: JoinRequestRow): JoinRequest {
  return {
    id: row.id,
    conversationId: row.conversationId,
    userId: row.userId,
    status:
      row.status === "approved" || row.status === "denied"
        ? (row.status as JoinRequestStatus)
        : "pending",
    message: row.message,
    inviteCode: row.inviteCode,
    createdAt: asDate(row.createdAt, "joinRequest.createdAt"),
    resolvedAt: nullableDate(row.resolvedAt, "joinRequest.resolvedAt"),
    resolvedBy: row.resolvedBy,
    metadata: metadata(row.metadata),
  };
}
export function toBlock(row: BlockRow): UserBlock {
  return {
    blockerUserId: row.blockerUserId,
    blockedUserId: row.blockedUserId,
    createdAt: asDate(row.createdAt, "block.createdAt"),
  };
}
export function toMute(row: MuteRow): ConversationMute {
  return {
    userId: row.userId,
    conversationId: row.conversationId,
    createdAt: asDate(row.createdAt, "mute.createdAt"),
  };
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
    createdAt: asDate(row.createdAt, "report.createdAt"),
    updatedAt: asDate(row.updatedAt, "report.updatedAt"),
  };
}
export function toBan(row: BanRow): UserBan {
  return {
    id: row.id,
    userId: row.userId,
    createdByUserId: row.createdByUserId,
    reason: row.reason,
    createdAt: asDate(row.createdAt, "ban.createdAt"),
    expiresAt: nullableDate(row.expiresAt, "ban.expiresAt"),
    revokedAt: nullableDate(row.revokedAt, "ban.revokedAt"),
    revokedByUserId: row.revokedByUserId,
  };
}
