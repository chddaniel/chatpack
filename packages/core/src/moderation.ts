import type {
  ConversationMute,
  ModerationReport,
  ReportStatus,
  ReportTargetType,
  UserBan,
  UserBlock,
} from "./types";

/** Moderator permission actions passed to {@link CanModerateHook}. */
export type ModerationAction =
  "reports.read" | "reports.update" | "bans.read" | "bans.create" | "bans.revoke";

/** User block or unblock request. */
export interface BlockUserInput {
  userId: string;
  targetUserId: string;
}

/** Cursor pagination shared by moderation list actions. */
export interface ListModerationInput {
  limit?: number | undefined;
  cursor?: string | undefined;
}

/** Conversation mute or unmute request. */
export interface MuteConversationInput {
  conversationId: string;
}

/** User, message, or conversation report submission. */
export interface ReportInput {
  targetType: ReportTargetType;
  targetId: string;
  reason: string;
}

/** Moderator report queue filters. */
export interface ListReportsInput extends ListModerationInput {
  status?: ReportStatus | undefined;
  targetType?: ReportTargetType | undefined;
}

/** Moderator report status update. */
export interface UpdateReportInput {
  reportId: string;
  status: ReportStatus;
  moderatorNote?: string | null | undefined;
}

/** Permanent or timed user ban request. */
export interface BanUserInput {
  targetUserId: string;
  reason?: string | null | undefined;
  expiresAt?: Date | null | undefined;
}

/** Moderator ban list filters. */
export interface ListBansInput extends ListModerationInput {
  activeOnly?: boolean | undefined;
}

/** Moderator ban revocation request. */
export interface UnbanUserInput {
  banId: string;
}

/** Server-side moderation actions exposed by {@link ChatpackApi}. */
export interface ModerationApi {
  blockUser(input: BlockUserInput): Promise<UserBlock>;
  unblockUser(input: BlockUserInput): Promise<void>;
  listBlockedUsers(input: { userId: string } & ListModerationInput): Promise<{
    blocks: UserBlock[];
    nextCursor: string | null;
  }>;
  muteConversation(input: { userId: string } & MuteConversationInput): Promise<ConversationMute>;
  unmuteConversation(input: { userId: string } & MuteConversationInput): Promise<void>;
  listMutedConversations(input: { userId: string } & ListModerationInput): Promise<{
    mutes: ConversationMute[];
    nextCursor: string | null;
  }>;
  report(input: { userId: string } & ReportInput): Promise<ModerationReport>;
  listReports(input: { userId: string } & ListReportsInput): Promise<{
    reports: ModerationReport[];
    nextCursor: string | null;
  }>;
  getReport(input: { userId: string; reportId: string }): Promise<ModerationReport>;
  updateReport(input: { userId: string } & UpdateReportInput): Promise<ModerationReport>;
  listBans(input: { userId: string } & ListBansInput): Promise<{
    bans: UserBan[];
    nextCursor: string | null;
  }>;
  banUser(input: { userId: string } & BanUserInput): Promise<UserBan>;
  unbanUser(input: { userId: string } & UnbanUserInput): Promise<UserBan>;
}
