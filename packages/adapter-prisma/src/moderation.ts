import type {
  ConversationMute,
  ModerationPage,
  ModerationReport,
  ModerationStorage,
  UserBan,
  UserBlock,
} from "@chatpack/core";
import type { JsonFilterWhere, PrismaClientLike, PrismaTransaction } from "./types";
import { toBan, toBlock, toMute, toReport } from "./converters";
import { decodeActivityCursor, encodeActivityCursor, generateId, jsonInput } from "./utils";

function filterAnd(...parts: (JsonFilterWhere | undefined)[]): JsonFilterWhere {
  return { AND: parts.filter((part): part is JsonFilterWhere => part !== undefined) };
}

function isCode(error: unknown, code: string, seen = new Set<object>()): boolean {
  if (typeof error !== "object" || error === null) return false;
  if (seen.has(error)) return false;
  seen.add(error);
  const value = error as Record<string, unknown>;
  if (value.code === code) return true;
  return Object.values(value).some((nested) => isCode(nested, code, seen));
}

async function transactionWithRetry<T>(
  client: PrismaClientLike,
  callback: (tx: PrismaTransaction) => Promise<T>,
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await client.$transaction(callback, {
        isolationLevel: "Serializable",
        maxWait: 5_000,
        timeout: 10_000,
      });
    } catch (error) {
      if ((!isCode(error, "P2034") && !isCode(error, "40001")) || attempt >= 12) throw error;
      await new Promise((resolve) => setTimeout(resolve, Math.min(10 * 2 ** attempt, 500)));
    }
  }
}

export function createModerationStorage(client: PrismaClientLike): ModerationStorage {
  const moderation: ModerationStorage = {
    async isUserBanned(userId, now = new Date()) {
      return moderation.getActiveBan(userId, now);
    },

    async isBlocked(userIdA, userIdB) {
      const row = await client.chatpackUserBlock.findFirst({
        where: {
          OR: [
            { blockerUserId: userIdA, blockedUserId: userIdB },
            { blockerUserId: userIdB, blockedUserId: userIdA },
          ],
        },
      });
      return row !== null;
    },

    async createBlock(input) {
      const row = await client.chatpackUserBlock.upsert({
        where: {
          blockerUserId_blockedUserId: {
            blockerUserId: input.blockerUserId,
            blockedUserId: input.blockedUserId,
          },
        },
        create: { ...input, createdAt: new Date() },
        update: { createdAt: new Date() },
      });
      return toBlock(row);
    },

    async removeBlock(input) {
      await client.chatpackUserBlock.deleteMany({
        where: { blockerUserId: input.blockerUserId, blockedUserId: input.blockedUserId },
      });
    },

    async listBlocks(input): Promise<ModerationPage<UserBlock>> {
      const cursor = decodeActivityCursor(input.cursor);
      const where = filterAnd(
        { blockerUserId: input.blockerUserId },
        cursor
          ? {
              OR: [
                { createdAt: { gt: new Date(cursor.activityMs) } },
                { createdAt: new Date(cursor.activityMs), blockedUserId: { gt: cursor.id } },
              ],
            }
          : undefined,
      );
      const rows = await client.chatpackUserBlock.findMany({
        where,
        orderBy: [{ createdAt: "asc" }, { blockedUserId: "asc" }],
        take: input.limit + 1,
      });
      const page = rows.slice(0, input.limit);
      const last = page[page.length - 1];
      return {
        items: page.map(toBlock),
        nextCursor:
          rows.length > input.limit && last
            ? encodeActivityCursor(last.createdAt, last.blockedUserId)
            : null,
      };
    },

    async createMute(input) {
      const row = await client.chatpackConversationMute.upsert({
        where: {
          userId_conversationId: { userId: input.userId, conversationId: input.conversationId },
        },
        create: { ...input, createdAt: new Date() },
        update: { createdAt: new Date() },
      });
      return toMute(row);
    },

    async removeMute(input) {
      await client.chatpackConversationMute.deleteMany({
        where: { userId: input.userId, conversationId: input.conversationId },
      });
    },

    async listMutes(input): Promise<ModerationPage<ConversationMute>> {
      const cursor = decodeActivityCursor(input.cursor);
      const where = filterAnd(
        { userId: input.userId },
        cursor
          ? {
              OR: [
                { createdAt: { gt: new Date(cursor.activityMs) } },
                { createdAt: new Date(cursor.activityMs), conversationId: { gt: cursor.id } },
              ],
            }
          : undefined,
      );
      const rows = await client.chatpackConversationMute.findMany({
        where,
        orderBy: [{ createdAt: "asc" }, { conversationId: "asc" }],
        take: input.limit + 1,
      });
      const page = rows.slice(0, input.limit);
      const last = page[page.length - 1];
      return {
        items: page.map(toMute),
        nextCursor:
          rows.length > input.limit && last
            ? encodeActivityCursor(last.createdAt, last.conversationId)
            : null,
      };
    },

    async findOpenReport(reporterUserId, targetType, targetId) {
      const row = await client.chatpackModerationReport.findFirst({
        where: { reporterUserId, targetType, targetId, status: { in: ["open", "triaged"] } },
      });
      return row ? toReport(row) : null;
    },

    async createReport(input) {
      const now = new Date();
      const row = await client.chatpackModerationReport.create({
        data: {
          id: generateId("report"),
          reporterUserId: input.reporterUserId,
          targetType: input.targetType,
          targetId: input.targetId,
          reason: input.reason,
          status: "open",
          moderatorNote: null,
          evidence: jsonInput(input.evidence),
          createdAt: now,
          updatedAt: now,
        },
      });
      return toReport(row);
    },

    async getReport(reportId) {
      const row = await client.chatpackModerationReport.findUnique({ where: { id: reportId } });
      return row ? toReport(row) : null;
    },

    async listReports(input): Promise<ModerationPage<ModerationReport>> {
      const cursor = decodeActivityCursor(input.cursor);
      const where = filterAnd(
        input.status ? { status: input.status } : undefined,
        input.targetType ? { targetType: input.targetType } : undefined,
        cursor
          ? {
              OR: [
                { createdAt: { gt: new Date(cursor.activityMs) } },
                { createdAt: new Date(cursor.activityMs), id: { gt: cursor.id } },
              ],
            }
          : undefined,
      );
      const rows = await client.chatpackModerationReport.findMany({
        where,
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take: input.limit + 1,
      });
      const page = rows.slice(0, input.limit);
      const last = page[page.length - 1];
      return {
        items: page.map(toReport),
        nextCursor:
          rows.length > input.limit && last ? encodeActivityCursor(last.createdAt, last.id) : null,
      };
    },

    async updateReport(input) {
      const row = await client.chatpackModerationReport.update({
        where: { id: input.reportId },
        data: { status: input.status, moderatorNote: input.moderatorNote, updatedAt: new Date() },
      });
      return toReport(row);
    },

    async getActiveBan(userId, now = new Date()) {
      const row = await client.chatpackUserBan.findFirst({
        where: { userId, revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
        orderBy: { createdAt: "desc" },
      });
      return row ? toBan(row) : null;
    },

    async getBan(banId) {
      const row = await client.chatpackUserBan.findUnique({ where: { id: banId } });
      return row ? toBan(row) : null;
    },

    async createBan(input) {
      return transactionWithRetry(client, async (tx) => {
        // Prisma has no portable partial unique index for time-expiring rows.
        // PostgreSQL advisory lock makes the active-ban check and insert one serialized critical section.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${input.userId}, 39231))`;
        const now = new Date();
        const active = await tx.chatpackUserBan.findFirst({
          where: {
            userId: input.userId,
            revokedAt: null,
            OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
          },
          orderBy: { createdAt: "desc" },
        });
        if (active) return toBan(active);
        const row = await tx.chatpackUserBan.create({
          data: {
            id: generateId("ban"),
            userId: input.userId,
            createdByUserId: input.createdByUserId,
            reason: input.reason,
            createdAt: now,
            expiresAt: input.expiresAt,
            revokedAt: null,
            revokedByUserId: null,
          },
        });
        return toBan(row);
      });
    },

    async listBans(input): Promise<ModerationPage<UserBan>> {
      const cursor = decodeActivityCursor(input.cursor);
      const now = new Date();
      const where = filterAnd(
        input.activeOnly
          ? { revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] }
          : undefined,
        cursor
          ? {
              OR: [
                { createdAt: { gt: new Date(cursor.activityMs) } },
                { createdAt: new Date(cursor.activityMs), id: { gt: cursor.id } },
              ],
            }
          : undefined,
      );
      const rows = await client.chatpackUserBan.findMany({
        where,
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take: input.limit + 1,
      });
      const page = rows.slice(0, input.limit);
      const last = page[page.length - 1];
      return {
        items: page.map(toBan),
        nextCursor:
          rows.length > input.limit && last ? encodeActivityCursor(last.createdAt, last.id) : null,
      };
    },

    async revokeBan(input) {
      const row = await client.chatpackUserBan.update({
        where: { id: input.banId },
        data: { revokedAt: new Date(), revokedByUserId: input.revokedByUserId },
      });
      return toBan(row);
    },
  };
  return moderation;
}
