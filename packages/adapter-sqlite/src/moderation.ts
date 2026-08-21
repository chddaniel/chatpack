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
import { generateId } from "./utils";
import type { DrizzleSqliteDatabase } from "./types";

export function createModerationStorage(db: DrizzleSqliteDatabase): ModerationStorage {
  const moderation: ModerationStorage = {
    async isUserBanned(userId, now = new Date()) {
      return moderation.getActiveBan(userId, now);
    },

    async isBlocked(userIdA, userIdB) {
      const [row] = await db
        .select({ blockerUserId: userBlocks.blockerUserId })
        .from(userBlocks)
        .where(
          or(
            and(eq(userBlocks.blockerUserId, userIdA), eq(userBlocks.blockedUserId, userIdB)),
            and(eq(userBlocks.blockerUserId, userIdB), eq(userBlocks.blockedUserId, userIdA)),
          ),
        )
        .limit(1);
      return row !== undefined;
    },

    async createBlock(input) {
      const createdAt = new Date();
      await db
        .insert(userBlocks)
        .values({ ...input, createdAt })
        .onConflictDoNothing({ target: [userBlocks.blockerUserId, userBlocks.blockedUserId] });
      const [row] = await db
        .select()
        .from(userBlocks)
        .where(
          and(
            eq(userBlocks.blockerUserId, input.blockerUserId),
            eq(userBlocks.blockedUserId, input.blockedUserId),
          ),
        )
        .limit(1);
      if (!row) throw new Error("sqliteAdapter: block insert returned no row.");
      return toBlock(row);
    },

    async removeBlock(input) {
      await db
        .delete(userBlocks)
        .where(
          and(
            eq(userBlocks.blockerUserId, input.blockerUserId),
            eq(userBlocks.blockedUserId, input.blockedUserId),
          ),
        );
    },

    async listBlocks(input): Promise<ModerationPage<UserBlock>> {
      const rows = await db
        .select()
        .from(userBlocks)
        .where(eq(userBlocks.blockerUserId, input.blockerUserId))
        .orderBy(desc(userBlocks.createdAt), desc(userBlocks.blockedUserId));
      const start = input.cursor
        ? Math.max(0, rows.findIndex((row) => row.blockedUserId === input.cursor) + 1)
        : 0;
      const page = rows.slice(start, start + input.limit);
      return {
        items: page.map(toBlock),
        nextCursor:
          page.length === input.limit && start + input.limit < rows.length
            ? page[page.length - 1]!.blockedUserId
            : null,
      };
    },

    async createMute(input) {
      await db
        .insert(conversationMutes)
        .values({ ...input, createdAt: new Date() })
        .onConflictDoNothing({
          target: [conversationMutes.userId, conversationMutes.conversationId],
        });
      const [row] = await db
        .select()
        .from(conversationMutes)
        .where(
          and(
            eq(conversationMutes.userId, input.userId),
            eq(conversationMutes.conversationId, input.conversationId),
          ),
        )
        .limit(1);
      if (!row) throw new Error("sqliteAdapter: mute insert returned no row.");
      return toMute(row);
    },

    async removeMute(input) {
      await db
        .delete(conversationMutes)
        .where(
          and(
            eq(conversationMutes.userId, input.userId),
            eq(conversationMutes.conversationId, input.conversationId),
          ),
        );
    },

    async listMutes(input): Promise<ModerationPage<ConversationMute>> {
      const rows = await db
        .select()
        .from(conversationMutes)
        .where(eq(conversationMutes.userId, input.userId))
        .orderBy(desc(conversationMutes.createdAt), desc(conversationMutes.conversationId));
      const start = input.cursor
        ? Math.max(0, rows.findIndex((row) => row.conversationId === input.cursor) + 1)
        : 0;
      const page = rows.slice(start, start + input.limit);
      return {
        items: page.map(toMute),
        nextCursor:
          page.length === input.limit && start + input.limit < rows.length
            ? page[page.length - 1]!.conversationId
            : null,
      };
    },

    async findOpenReport(reporterUserId, targetType, targetId) {
      const [row] = await db
        .select()
        .from(moderationReports)
        .where(
          and(
            eq(moderationReports.reporterUserId, reporterUserId),
            eq(moderationReports.targetType, targetType),
            eq(moderationReports.targetId, targetId),
            or(eq(moderationReports.status, "open"), eq(moderationReports.status, "triaged")),
          ),
        )
        .limit(1);
      return row ? toReport(row) : null;
    },

    async createReport(input) {
      const now = new Date();
      const id = generateId("report");
      await db.insert(moderationReports).values({
        id,
        reporterUserId: input.reporterUserId,
        targetType: input.targetType,
        targetId: input.targetId,
        reason: input.reason,
        status: "open",
        moderatorNote: null,
        evidence: input.evidence,
        createdAt: now,
        updatedAt: now,
      });
      const [row] = await db
        .select()
        .from(moderationReports)
        .where(eq(moderationReports.id, id))
        .limit(1);
      if (!row) throw new Error("sqliteAdapter: report insert returned no row.");
      return toReport(row);
    },

    async getReport(reportId) {
      const [row] = await db
        .select()
        .from(moderationReports)
        .where(eq(moderationReports.id, reportId))
        .limit(1);
      return row ? toReport(row) : null;
    },

    async listReports(input): Promise<ModerationPage<ModerationReport>> {
      const filters = [];
      if (input.status !== undefined) filters.push(eq(moderationReports.status, input.status));
      if (input.targetType !== undefined)
        filters.push(eq(moderationReports.targetType, input.targetType));
      const rows = await db
        .select()
        .from(moderationReports)
        .where(filters.length === 0 ? undefined : and(...filters))
        .orderBy(desc(moderationReports.createdAt), desc(moderationReports.id));
      const start = input.cursor
        ? Math.max(0, rows.findIndex((row) => row.id === input.cursor) + 1)
        : 0;
      const page = rows.slice(start, start + input.limit);
      return {
        items: page.map(toReport),
        nextCursor:
          page.length === input.limit && start + input.limit < rows.length
            ? page[page.length - 1]!.id
            : null,
      };
    },

    async updateReport(input) {
      const [row] = await db
        .update(moderationReports)
        .set({ status: input.status, moderatorNote: input.moderatorNote, updatedAt: new Date() })
        .where(eq(moderationReports.id, input.reportId))
        .returning();
      if (!row) throw new Error(`sqliteAdapter: unknown report "${input.reportId}".`);
      return toReport(row);
    },

    async getActiveBan(userId, now = new Date()) {
      const [row] = await db
        .select()
        .from(userBans)
        .where(
          and(
            eq(userBans.userId, userId),
            isNull(userBans.revokedAt),
            or(isNull(userBans.expiresAt), gt(userBans.expiresAt, now)),
          ),
        )
        .orderBy(desc(userBans.createdAt))
        .limit(1);
      return row ? toBan(row) : null;
    },

    async getBan(banId) {
      const [row] = await db.select().from(userBans).where(eq(userBans.id, banId)).limit(1);
      return row ? toBan(row) : null;
    },

    async createBan(input) {
      const id = generateId("ban");
      const now = new Date();
      // One statement, not read-then-write (ADR 0019 §5). "Active" spans
      // `revoked_at is null` *and* an unexpired `expires_at`, which no unique
      // index can express, so the guard rides along in the INSERT itself: two
      // moderators banning the same user at the same moment cannot both land a
      // row. The loser reads the winner's ban back below.
      await db.run(sql`
        insert into "chatpack_user_bans"
          ("id", "user_id", "created_by_user_id", "reason", "created_at",
           "expires_at", "revoked_at", "revoked_by_user_id")
        select ${id}, ${input.userId}, ${input.createdByUserId},
               ${input.reason}, ${now.getTime()}, ${input.expiresAt?.getTime() ?? null},
               null, null
        where not exists (
          select 1 from "chatpack_user_bans"
          where "user_id" = ${input.userId}
            and "revoked_at" is null
            and ("expires_at" is null or "expires_at" > ${now.getTime()})
        )`);

      const active = await moderation.getActiveBan(input.userId, now);
      if (!active) throw new Error("sqliteAdapter: ban insert returned no row.");
      return active;
    },

    async listBans(input): Promise<ModerationPage<UserBan>> {
      const now = new Date();
      const filters = input.activeOnly
        ? [isNull(userBans.revokedAt), or(isNull(userBans.expiresAt), gt(userBans.expiresAt, now))]
        : [];
      const rows = await db
        .select()
        .from(userBans)
        .where(filters.length === 0 ? undefined : and(...filters))
        .orderBy(desc(userBans.createdAt), desc(userBans.id));
      const start = input.cursor
        ? Math.max(0, rows.findIndex((row) => row.id === input.cursor) + 1)
        : 0;
      const page = rows.slice(start, start + input.limit);
      return {
        items: page.map(toBan),
        nextCursor:
          page.length === input.limit && start + input.limit < rows.length
            ? page[page.length - 1]!.id
            : null,
      };
    },

    async revokeBan(input) {
      const [row] = await db
        .update(userBans)
        .set({ revokedAt: new Date(), revokedByUserId: input.revokedByUserId })
        .where(and(eq(userBans.id, input.banId), isNull(userBans.revokedAt)))
        .returning();
      if (!row) {
        const existing = await db
          .select()
          .from(userBans)
          .where(eq(userBans.id, input.banId))
          .limit(1);
        if (!existing[0]) throw new Error(`sqliteAdapter: unknown ban "${input.banId}".`);
        return toBan(existing[0]);
      }
      return toBan(row);
    },
  };

  return moderation;
}
