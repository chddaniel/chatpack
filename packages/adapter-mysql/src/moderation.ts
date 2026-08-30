import { and, desc, eq, gt, isNull, or, sql } from "drizzle-orm";
import type {
  ConversationMute,
  ModerationPage,
  ModerationReport,
  ModerationStorage,
  UserBan,
  UserBlock,
} from "@chatpack/core";
import { conversationMutes, moderationReports, userBans, userBlocks } from "./schema";
import { toBan, toBlock, toMute, toReport } from "./converters";
import { encodeActivityCursor, generateId } from "./utils";
import type { DrizzleMysqlDatabase } from "./types";

type ModerationDb = DrizzleMysqlDatabase;

export function createModerationStorage(db: ModerationDb): ModerationStorage {
  const moderation: ModerationStorage = {
    async isUserBanned(userId, now = new Date()) {
      return moderation.getActiveBan(userId, now);
    },

    async isBlocked(userIdA, userIdB) {
      const [row] = await db.select({ blockerUserId: userBlocks.blockerUserId }).from(userBlocks).where(or(
        and(eq(userBlocks.blockerUserId, userIdA), eq(userBlocks.blockedUserId, userIdB)),
        and(eq(userBlocks.blockerUserId, userIdB), eq(userBlocks.blockedUserId, userIdA)),
      )).limit(1);
      return row !== undefined;
    },

    async createBlock(input) {
      const createdAt = new Date();
      await db.insert(userBlocks).values({ ...input, createdAt }).onDuplicateKeyUpdate({ set: { createdAt: sql`${userBlocks.createdAt}` } });
      const [row] = await db.select().from(userBlocks).where(and(eq(userBlocks.blockerUserId, input.blockerUserId), eq(userBlocks.blockedUserId, input.blockedUserId))).limit(1);
      if (!row) throw new Error("mysqlAdapter: block insert returned no row.");
      return toBlock(row);
    },

    async removeBlock(input) {
      await db.delete(userBlocks).where(and(eq(userBlocks.blockerUserId, input.blockerUserId), eq(userBlocks.blockedUserId, input.blockedUserId)));
    },

    async listBlocks(input): Promise<ModerationPage<UserBlock>> {
      const cursor = decodeCursor(input.cursor);
      const rows = await db.select().from(userBlocks).where(and(eq(userBlocks.blockerUserId, input.blockerUserId), cursor ? or(gt(userBlocks.createdAt, cursor.date), and(eq(userBlocks.createdAt, cursor.date), gt(userBlocks.blockedUserId, cursor.id))) : undefined)).orderBy(userBlocks.createdAt, userBlocks.blockedUserId).limit(input.limit + 1);
      const page = rows.slice(0, input.limit);
      const last = page[page.length - 1];
      return { items: page.map(toBlock), nextCursor: rows.length > input.limit && last ? encodeActivityCursor(last.createdAt, last.blockedUserId) : null };
    },

    async createMute(input) {
      const createdAt = new Date();
      await db.insert(conversationMutes).values({ ...input, createdAt }).onDuplicateKeyUpdate({ set: { createdAt: sql`${conversationMutes.createdAt}` } });
      const [row] = await db.select().from(conversationMutes).where(and(eq(conversationMutes.userId, input.userId), eq(conversationMutes.conversationId, input.conversationId))).limit(1);
      if (!row) throw new Error("mysqlAdapter: mute insert returned no row.");
      return toMute(row);
    },

    async removeMute(input) {
      await db.delete(conversationMutes).where(and(eq(conversationMutes.userId, input.userId), eq(conversationMutes.conversationId, input.conversationId)));
    },

    async listMutes(input): Promise<ModerationPage<ConversationMute>> {
      const cursor = decodeCursor(input.cursor);
      const rows = await db.select().from(conversationMutes).where(and(eq(conversationMutes.userId, input.userId), cursor ? or(gt(conversationMutes.createdAt, cursor.date), and(eq(conversationMutes.createdAt, cursor.date), gt(conversationMutes.conversationId, cursor.id))) : undefined)).orderBy(conversationMutes.createdAt, conversationMutes.conversationId).limit(input.limit + 1);
      const page = rows.slice(0, input.limit);
      const last = page[page.length - 1];
      return { items: page.map(toMute), nextCursor: rows.length > input.limit && last ? encodeActivityCursor(last.createdAt, last.conversationId) : null };
    },

    async findOpenReport(reporterUserId, targetType, targetId) {
      const [row] = await db.select().from(moderationReports).where(and(eq(moderationReports.reporterUserId, reporterUserId), eq(moderationReports.targetType, targetType), eq(moderationReports.targetId, targetId), or(eq(moderationReports.status, "open"), eq(moderationReports.status, "triaged")))).limit(1);
      return row ? toReport(row) : null;
    },

    async createReport(input) {
      const now = new Date();
      const id = generateId("report");
      await db.insert(moderationReports).values({ id, reporterUserId: input.reporterUserId, targetType: input.targetType, targetId: input.targetId, reason: input.reason, status: "open", moderatorNote: null, evidence: input.evidence, createdAt: now, updatedAt: now });
      const [row] = await db.select().from(moderationReports).where(eq(moderationReports.id, id)).limit(1);
      if (!row) throw new Error("mysqlAdapter: report insert returned no row.");
      return toReport(row);
    },

    async getReport(reportId) {
      const [row] = await db.select().from(moderationReports).where(eq(moderationReports.id, reportId)).limit(1);
      return row ? toReport(row) : null;
    },

    async listReports(input): Promise<ModerationPage<ModerationReport>> {
      const cursor = decodeCursor(input.cursor);
      const rows = await db.select().from(moderationReports).where(and(input.status === undefined ? undefined : eq(moderationReports.status, input.status), input.targetType === undefined ? undefined : eq(moderationReports.targetType, input.targetType), cursor ? or(gt(moderationReports.createdAt, cursor.date), and(eq(moderationReports.createdAt, cursor.date), gt(moderationReports.id, cursor.id))) : undefined)).orderBy(moderationReports.createdAt, moderationReports.id).limit(input.limit + 1);
      const page = rows.slice(0, input.limit);
      const last = page[page.length - 1];
      return { items: page.map(toReport), nextCursor: rows.length > input.limit && last ? encodeActivityCursor(last.createdAt, last.id) : null };
    },

    async updateReport(input) {
      await db.update(moderationReports).set({ status: input.status, moderatorNote: input.moderatorNote, updatedAt: new Date() }).where(eq(moderationReports.id, input.reportId));
      const [row] = await db.select().from(moderationReports).where(eq(moderationReports.id, input.reportId)).limit(1);
      if (!row) throw new Error(`mysqlAdapter: unknown report "${input.reportId}".`);
      return toReport(row);
    },

    async getActiveBan(userId, now = new Date()) {
      const [row] = await db.select().from(userBans).where(and(eq(userBans.userId, userId), isNull(userBans.revokedAt), or(isNull(userBans.expiresAt), gt(userBans.expiresAt, now)))).orderBy(desc(userBans.createdAt)).limit(1);
      return row ? toBan(row) : null;
    },

    async getBan(banId) {
      const [row] = await db.select().from(userBans).where(eq(userBans.id, banId)).limit(1);
      return row ? toBan(row) : null;
    },

    async createBan(input) {
      // InnoDB's next-key lock on the indexed user_id range serializes this
      // transaction for one user, including the no-existing-row case. The
      // active check and insert therefore cannot race under MySQL's default
      // REPEATABLE READ isolation.
      return db.transaction(async (tx) => {
        const existing = await tx.select().from(userBans).where(eq(userBans.userId, input.userId)).orderBy(desc(userBans.createdAt)).for("update");
        const now = new Date();
        const active = existing.find((row) => row.revokedAt === null && (row.expiresAt === null || row.expiresAt > now));
        if (active) return toBan(active);
        const id = generateId("ban");
        await tx.insert(userBans).values({ id, userId: input.userId, createdByUserId: input.createdByUserId, reason: input.reason, createdAt: now, expiresAt: input.expiresAt, revokedAt: null, revokedByUserId: null });
        const [row] = await tx.select().from(userBans).where(eq(userBans.id, id)).limit(1);
        if (!row) throw new Error("mysqlAdapter: ban insert returned no row.");
        return toBan(row);
      });
    },

    async listBans(input): Promise<ModerationPage<UserBan>> {
      const now = new Date();
      const cursor = decodeCursor(input.cursor);
      const rows = await db.select().from(userBans).where(and(input.activeOnly ? and(isNull(userBans.revokedAt), or(isNull(userBans.expiresAt), gt(userBans.expiresAt, now))) : undefined, cursor ? or(gt(userBans.createdAt, cursor.date), and(eq(userBans.createdAt, cursor.date), gt(userBans.id, cursor.id))) : undefined)).orderBy(userBans.createdAt, userBans.id).limit(input.limit + 1);
      const page = rows.slice(0, input.limit);
      const last = page[page.length - 1];
      return { items: page.map(toBan), nextCursor: rows.length > input.limit && last ? encodeActivityCursor(last.createdAt, last.id) : null };
    },

    async revokeBan(input) {
      await db.update(userBans).set({ revokedAt: new Date(), revokedByUserId: input.revokedByUserId }).where(eq(userBans.id, input.banId));
      const [row] = await db.select().from(userBans).where(eq(userBans.id, input.banId)).limit(1);
      if (!row) throw new Error(`mysqlAdapter: unknown ban "${input.banId}".`);
      return toBan(row);
    },
  };
  return moderation;
}

function decodeCursor(cursor: string | undefined): { date: Date; id: string } | null {
  if (!cursor) return null;
  try {
    const value: unknown = JSON.parse(decodeURIComponent(cursor));
    if (Array.isArray(value) && typeof value[0] === "number" && typeof value[1] === "string") return { date: new Date(value[0]), id: value[1] };
  } catch {
    // Invalid cursors restart from the first page.
  }
  return null;
}
