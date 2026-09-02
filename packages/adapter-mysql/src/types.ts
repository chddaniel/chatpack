import type { MySql2Database } from "drizzle-orm/mysql2";
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

/** Drizzle database created with `drizzle-orm/mysql2` and a server-side mysql2 client or pool. */
export type DrizzleMysqlDatabase = MySql2Database<Record<string, never>>;

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
