import type { LibSQLDatabase } from "drizzle-orm/libsql";

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

/** A Drizzle database created with `drizzle-orm/libsql` and `@libsql/client`. */
export type DrizzleTursoDatabase = LibSQLDatabase<Record<string, unknown>>;

/** Serialize and retry writes that share one libSQL client. */
export type WriteScheduler = <T>(callback: () => Promise<T>) => Promise<T>;

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
