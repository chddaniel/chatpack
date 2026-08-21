import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";

import type {
  conversationInvites,
  conversationMutes,
  conversationParticipants,
  conversations,
  joinRequests,
  messageMentions,
  messageReactions,
  messages,
  moderationReports,
  userBans,
  userBlocks,
} from "./schema";

/** A Drizzle database created with `drizzle-orm/better-sqlite3`. */
export type DrizzleSqliteDatabase = BetterSQLite3Database<Record<string, unknown>>;

export type ConversationRow = typeof conversations.$inferSelect;
export type ParticipantRow = typeof conversationParticipants.$inferSelect;
export type MessageRow = typeof messages.$inferSelect;
export type ReactionRow = typeof messageReactions.$inferSelect;
export type MentionRow = typeof messageMentions.$inferSelect;
export type InviteRow = typeof conversationInvites.$inferSelect;
export type JoinRequestRow = typeof joinRequests.$inferSelect;
export type BlockRow = typeof userBlocks.$inferSelect;
export type MuteRow = typeof conversationMutes.$inferSelect;
export type ReportRow = typeof moderationReports.$inferSelect;
export type BanRow = typeof userBans.$inferSelect;

export interface SearchTokenRow {
  messageId: string;
  token: string;
  occurrences: number;
}
