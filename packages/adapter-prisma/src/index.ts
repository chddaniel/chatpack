/** First-party Prisma ORM 7 PostgreSQL StorageAdapter for Chatpack. */
import type {
  AddMessageInput,
  AddParticipantsInput,
  Conversation,
  ConversationInvite,
  CountUnreadInput,
  CreateGroupConversationInput,
  CreateInviteInput,
  CreateJoinRequestInput,
  DeleteInviteInput,
  GetJoinRequestInput,
  GetOrCreateDirectConversationInput,
  GetOrCreateDirectConversationResult,
  JoinRequest,
  ListConversationsInput,
  ListConversationsResult,
  ListJoinRequestsInput,
  ListMessagesAfterSeqInput,
  ListMessagesInput,
  ListMessagesResult,
  ListPublicConversationsInput,
  ListPublicConversationsResult,
  Message,
  MessageMention,
  Reaction,
  ReactionInput,
  RemoveParticipantInput,
  ResolveJoinRequestInput,
  SearchMessagesInput,
  SearchMessagesResult,
  SetMessageMentionsInput,
  SetParticipantRoleInput,
  StorageAdapter,
  UpdateConversationInput,
  UpdateLastReadInput,
  UpdateMessageInput,
} from "@chatpack/core";
import { getSearchTerms } from "@chatpack/core";
import { createModerationStorage } from "./moderation";
import {
  toConversation,
  toInvite,
  toJoinRequest,
  toMention,
  toMessage,
  toReaction,
} from "./converters";
import {
  decodeActivityCursor,
  decodeSearchCursor,
  encodeActivityCursor,
  encodeSearchCursor,
  generateId,
  insertSearchTokenRows,
  jsonInput,
  searchTokenRows,
} from "./utils";
import type { InviteRow, ParticipantRow, PrismaClientLike, PrismaTransaction } from "./types";
import type { JsonFilterWhere } from "./types";

export type { PrismaClientLike } from "./types";
export { createModerationStorage } from "./moderation";

function isCode(error: unknown, code: string, seen = new Set<object>()): boolean {
  if (typeof error !== "object" || error === null) return false;
  if (seen.has(error)) return false;
  seen.add(error);
  const value = error as Record<string, unknown>;
  if (value.code === code) return true;
  return Object.values(value).some((nested) => isCode(nested, code, seen));
}

function isPrismaClientLike(value: object): value is PrismaClientLike {
  return [
    "chatpackConversation",
    "conversationParticipant",
    "chatpackMessage",
    "chatpackMessageSearchToken",
    "chatpackMessageReaction",
    "chatpackMessageMention",
    "chatpackConversationInvite",
    "chatpackJoinRequest",
    "chatpackUserBlock",
    "chatpackConversationMute",
    "chatpackModerationReport",
    "chatpackUserBan",
    "$transaction",
    "$executeRaw",
  ].every((property) => property in value);
}

async function transactionWithRetry<T>(
  client: PrismaClientLike,
  callback: (tx: PrismaTransaction) => Promise<T>,
  isolationLevel: "Serializable" | "ReadCommitted" = "Serializable",
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await client.$transaction(callback, {
        isolationLevel,
        maxWait: 5_000,
        timeout: 10_000,
      });
    } catch (error) {
      if ((!isCode(error, "P2034") && !isCode(error, "40001")) || attempt >= 12) throw error;
      await new Promise((resolve) => setTimeout(resolve, Math.min(10 * 2 ** attempt, 500)));
    }
  }
}

function whereAnd(...parts: JsonFilterWhere[]): JsonFilterWhere {
  return { AND: parts };
}

/** Rebuild canonical search tokens after importing existing messages. */
export function backfillMessageSearchTokens(client: PrismaClientLike): Promise<void>;
export function backfillMessageSearchTokens(client: object): Promise<void>;
export async function backfillMessageSearchTokens(client: object): Promise<void> {
  if (!isPrismaClientLike(client))
    throw new Error(
      "backfillMessageSearchTokens: generated Prisma client is missing Chatpack models.",
    );
  const prismaClient: PrismaClientLike = client;
  const rows = await prismaClient.chatpackMessage.findMany();
  await prismaClient.chatpackMessageSearchToken.deleteMany({});
  await insertSearchTokenRows(
    rows.flatMap((row) => (row.deletedAt ? [] : searchTokenRows(row.id, row.body))),
    async (batch) => {
      await prismaClient.chatpackMessageSearchToken.createMany({
        data: batch,
        skipDuplicates: true,
      });
    },
  );
}

/** Create adapter from caller-owned, generated Prisma client. Server-side only. */
export function prismaAdapter(client: PrismaClientLike): StorageAdapter;
export function prismaAdapter(client: object): StorageAdapter;
export function prismaAdapter(client: object): StorageAdapter {
  if (!isPrismaClientLike(client))
    throw new Error("prismaAdapter: generated Prisma client is missing Chatpack models.");
  const prismaClient: PrismaClientLike = client;
  const conversations = client.chatpackConversation;
  const participants = client.conversationParticipant;
  const messages = client.chatpackMessage;

  async function participantsFor(
    ids: string[],
    db: PrismaTransaction = prismaClient,
  ): Promise<Map<string, ParticipantRow[]>> {
    if (ids.length === 0) return new Map();
    const rows = await db.conversationParticipant.findMany({
      where: { conversationId: { in: ids } },
      orderBy: [{ joinedAt: "asc" }, { userId: "asc" }],
    });
    const result = new Map<string, ParticipantRow[]>();
    for (const row of rows)
      result.set(row.conversationId, [...(result.get(row.conversationId) ?? []), row]);
    return result;
  }

  async function loadConversation(
    id: string,
    db: PrismaTransaction = prismaClient,
  ): Promise<Conversation | null> {
    const row = await db.chatpackConversation.findUnique({ where: { id } });
    if (!row) return null;
    const grouped = await participantsFor([id], db);
    return toConversation(row, grouped.get(id) ?? []);
  }

  async function reloadConversation(id: string): Promise<Conversation> {
    const result = await loadConversation(id);
    if (!result) throw new Error(`prismaAdapter: unknown conversation "${id}".`);
    return result;
  }

  async function reactionsFor(
    id: string,
    db: PrismaTransaction = prismaClient,
  ): Promise<Reaction[]> {
    const rows = await db.chatpackMessageReaction.findMany({
      where: { messageId: id },
      orderBy: [{ createdAt: "asc" }, { userId: "asc" }, { emoji: "asc" }],
    });
    return rows.map(toReaction);
  }

  async function pageConversations(
    where: JsonFilterWhere,
    limit: number,
    cursor: string | undefined,
  ): Promise<ListConversationsResult> {
    const decoded = decodeActivityCursor(cursor);
    const cursorWhere = decoded
      ? {
          OR: [
            { lastActivityAt: { lt: new Date(decoded.activityMs) } },
            { lastActivityAt: new Date(decoded.activityMs), id: { lt: decoded.id } },
          ],
        }
      : undefined;
    const rows = await prismaClient.chatpackConversation.findMany({
      where: cursorWhere ? whereAnd(where, cursorWhere) : where,
      orderBy: [{ lastActivityAt: "desc" }, { id: "desc" }],
      take: limit + 1,
    });
    const page = rows.slice(0, limit);
    const grouped = await participantsFor(page.map((row) => row.id));
    const last = page[page.length - 1];
    return {
      conversations: page.map((row) => toConversation(row, grouped.get(row.id) ?? [])),
      nextCursor:
        rows.length > limit && last ? encodeActivityCursor(last.lastActivityAt, last.id) : null,
    };
  }

  const invites = {
    async createInvite(input: CreateInviteInput): Promise<ConversationInvite> {
      const row = await client.chatpackConversationInvite.create({
        data: {
          code: input.code,
          conversationId: input.conversationId,
          createdBy: input.createdBy,
          createdAt: new Date(),
          expiresAt: input.expiresAt,
          maxUses: input.maxUses,
          uses: 0,
          requiresApproval: input.requiresApproval,
          metadata: jsonInput(input.metadata),
        },
      });
      return toInvite(row);
    },
    async getInvite(code: string): Promise<ConversationInvite | null> {
      const row = await client.chatpackConversationInvite.findUnique({ where: { code } });
      return row ? toInvite(row) : null;
    },
    async listInvites(conversationId: string): Promise<ConversationInvite[]> {
      const rows = await client.chatpackConversationInvite.findMany({
        where: { conversationId },
        orderBy: [{ createdAt: "desc" }, { code: "desc" }],
      });
      return rows.map(toInvite);
    },
    async deleteInvite(input: DeleteInviteInput): Promise<void> {
      await client.chatpackConversationInvite.deleteMany({
        where: { code: input.code, conversationId: input.conversationId },
      });
    },
    async consumeInvite(code: string): Promise<ConversationInvite | null> {
      return transactionWithRetry(
        client,
        async (tx) => {
          const now = new Date();
          // Prisma's model filter cannot compare `uses` with `maxUses`. Keep
          // this conditional increment in one parameterized PostgreSQL query.
          const rows = await tx.$queryRaw<InviteRow>`
          UPDATE "chatpack_conversation_invites"
          SET "uses" = "uses" + 1
          WHERE "code" = ${code}
            AND ("max_uses" IS NULL OR "uses" < "max_uses")
            AND ("expires_at" IS NULL OR "expires_at" > ${now})
          RETURNING "code", "conversation_id" AS "conversationId", "created_by" AS "createdBy",
            "created_at" AS "createdAt", "expires_at" AS "expiresAt", "max_uses" AS "maxUses",
            "uses", "requires_approval" AS "requiresApproval", "metadata"`;
          return rows[0] ? toInvite(rows[0]) : null;
        },
        "ReadCommitted",
      );
    },
    async createJoinRequest(input: CreateJoinRequestInput): Promise<JoinRequest> {
      const now = new Date();
      const row = await client.chatpackJoinRequest.upsert({
        where: {
          conversationId_userId: { conversationId: input.conversationId, userId: input.userId },
        },
        create: {
          id: generateId("jreq"),
          conversationId: input.conversationId,
          userId: input.userId,
          status: "pending",
          message: input.message,
          inviteCode: input.inviteCode,
          createdAt: now,
          resolvedAt: null,
          resolvedBy: null,
          metadata: jsonInput(input.metadata),
        },
        update: {
          status: "pending",
          message: input.message,
          inviteCode: input.inviteCode,
          createdAt: now,
          resolvedAt: null,
          resolvedBy: null,
          metadata: jsonInput(input.metadata),
        },
      });
      return toJoinRequest(row);
    },
    async getJoinRequest(input: GetJoinRequestInput): Promise<JoinRequest | null> {
      const row = await client.chatpackJoinRequest.findUnique({
        where: {
          conversationId_userId: { conversationId: input.conversationId, userId: input.userId },
        },
      });
      return row ? toJoinRequest(row) : null;
    },
    async listJoinRequests(input: ListJoinRequestsInput): Promise<JoinRequest[]> {
      const rows = await client.chatpackJoinRequest.findMany({
        where: input.status
          ? { conversationId: input.conversationId, status: input.status }
          : { conversationId: input.conversationId },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: input.limit,
      });
      return rows.map(toJoinRequest);
    },
    async resolveJoinRequest(input: ResolveJoinRequestInput): Promise<JoinRequest> {
      const row = await client.chatpackJoinRequest.update({
        where: {
          conversationId_userId: { conversationId: input.conversationId, userId: input.userId },
        },
        data: { status: input.status, resolvedAt: input.resolvedAt, resolvedBy: input.resolvedBy },
      });
      return toJoinRequest(row);
    },
  };

  const adapter: StorageAdapter = {
    moderation: createModerationStorage(client),
    invites,
    channels: {
      async listPublicConversations(
        input: ListPublicConversationsInput,
      ): Promise<ListPublicConversationsResult> {
        return pageConversations(
          { type: "group", visibility: "public" },
          input.limit,
          input.cursor,
        );
      },
    },

    async getOrCreateDirectConversation(
      input: GetOrCreateDirectConversationInput,
    ): Promise<GetOrCreateDirectConversationResult> {
      const id = generateId("conv");
      const now = new Date();
      try {
        await transactionWithRetry(client, async (tx) => {
          await tx.chatpackConversation.create({
            data: {
              id,
              type: "direct",
              pairKey: input.pairKey,
              name: null,
              visibility: "private",
              joinPolicy: "approval",
              createdAt: now,
              metadata: jsonInput(input.metadata),
              lastSeq: 0,
              lastActivityAt: now,
            },
          });
          await tx.conversationParticipant.createMany({
            data: input.userIds.map((userId) => ({
              conversationId: id,
              userId,
              role: "admin",
              joinedAt: now,
              lastReadMessageId: null,
            })),
            skipDuplicates: false,
          });
        });
      } catch (error) {
        if (!isCode(error, "P2002")) throw error;
      }
      const row = await client.chatpackConversation.findFirst({
        where: { pairKey: input.pairKey },
      });
      if (!row)
        throw new Error(
          `prismaAdapter: conversation for pairKey "${input.pairKey}" vanished after insert.`,
        );
      const grouped = await participantsFor([row.id]);
      return {
        conversation: toConversation(row, grouped.get(row.id) ?? []),
        created: row.id === id,
      };
    },

    async createGroupConversation(input: CreateGroupConversationInput): Promise<Conversation> {
      const id = generateId("conv");
      const now = new Date();
      await transactionWithRetry(
        client,
        async (tx) => {
          await tx.chatpackConversation.create({
            data: {
              id,
              type: "group",
              pairKey: null,
              name: input.name,
              visibility: input.visibility,
              joinPolicy: input.joinPolicy,
              createdAt: now,
              metadata: jsonInput(input.metadata),
              lastSeq: 0,
              lastActivityAt: now,
            },
          });
          await tx.conversationParticipant.createMany({
            data: [
              {
                conversationId: id,
                userId: input.creatorId,
                role: "admin",
                joinedAt: now,
                lastReadMessageId: null,
              },
              ...input.userIds.map((userId) => ({
                conversationId: id,
                userId,
                role: "member",
                joinedAt: now,
                lastReadMessageId: null,
              })),
            ],
            skipDuplicates: false,
          });
        },
        "ReadCommitted",
      );
      return reloadConversation(id);
    },

    async addParticipants(input: AddParticipantsInput): Promise<Conversation> {
      if (input.userIds.length)
        await participants.createMany({
          data: input.userIds.map((userId) => ({
            conversationId: input.conversationId,
            userId,
            role: "member",
            joinedAt: new Date(),
            lastReadMessageId: null,
          })),
          skipDuplicates: true,
        });
      return reloadConversation(input.conversationId);
    },
    async removeParticipant(input: RemoveParticipantInput): Promise<Conversation> {
      await participants.deleteMany({
        where: { conversationId: input.conversationId, userId: input.userId },
      });
      return reloadConversation(input.conversationId);
    },
    async setParticipantRole(input: SetParticipantRoleInput): Promise<Conversation> {
      await participants.update({
        where: {
          conversationId_userId: { conversationId: input.conversationId, userId: input.userId },
        },
        data: { role: input.role },
      });
      return reloadConversation(input.conversationId);
    },
    async updateConversation(input: UpdateConversationInput): Promise<Conversation> {
      await conversations.update({
        where: { id: input.conversationId },
        data: { name: input.name, visibility: input.visibility, joinPolicy: input.joinPolicy },
      });
      return reloadConversation(input.conversationId);
    },
    async getConversation(conversationId: string): Promise<Conversation | null> {
      return loadConversation(conversationId);
    },
    async listConversations(input: ListConversationsInput): Promise<ListConversationsResult> {
      return pageConversations(
        { participants: { some: { userId: input.userId } } },
        input.limit,
        input.cursor,
      );
    },

    async addMessage(input: AddMessageInput): Promise<Message> {
      return transactionWithRetry(
        client,
        async (tx) => {
          const now = new Date();
          const conversation = await tx.chatpackConversation.update({
            where: { id: input.conversationId },
            data: { lastSeq: { increment: 1 }, lastActivityAt: now },
          });
          const row = await tx.chatpackMessage.create({
            data: {
              id: generateId("msg"),
              conversationId: input.conversationId,
              senderId: input.senderId,
              body: input.body,
              role: input.role,
              seq: conversation.lastSeq,
              createdAt: now,
              editedAt: null,
              deletedAt: null,
              replyToMessageId: input.replyToMessageId,
              forwardedFromMessageId: input.forwardedFromMessageId,
              forwardedFromConversationId: input.forwardedFromConversationId,
              forwardedFromSenderId: input.forwardedFromSenderId,
              metadata: jsonInput(input.metadata),
            },
          });
          await insertSearchTokenRows(searchTokenRows(row.id, input.body), async (batch) => {
            await tx.chatpackMessageSearchToken.createMany({ data: batch, skipDuplicates: true });
          });
          return toMessage(row);
        },
        "ReadCommitted",
      );
    },
    async getMessage(messageId: string): Promise<Message | null> {
      const row = await messages.findUnique({ where: { id: messageId } });
      return row ? toMessage(row) : null;
    },
    async getMessagesByIds(messageIds: string[]): Promise<Message[]> {
      if (!messageIds.length) return [];
      const rows = await messages.findMany({ where: { id: { in: messageIds } } });
      return rows.map(toMessage);
    },
    async listMessages(input: ListMessagesInput): Promise<ListMessagesResult> {
      const cursor = input.cursor === undefined ? undefined : Number(input.cursor);
      const rows = await messages.findMany({
        where:
          cursor !== undefined && Number.isFinite(cursor)
            ? { conversationId: input.conversationId, seq: { lt: cursor } }
            : { conversationId: input.conversationId },
        orderBy: { seq: "desc" },
        take: input.limit + 1,
      });
      const page = rows.slice(0, input.limit);
      const last = page[page.length - 1];
      return {
        messages: page.map(toMessage),
        nextCursor: rows.length > input.limit && last ? String(last.seq) : null,
      };
    },
    async searchMessages(input: SearchMessagesInput): Promise<SearchMessagesResult> {
      const terms = getSearchTerms(input.query);
      if (!terms.length) return { messages: [], nextCursor: null };
      const tokens = await client.chatpackMessageSearchToken.findMany({
        where: { token: { in: terms } },
      });
      const ranks = new Map<string, number>();
      const termCounts = new Map<string, Set<string>>();
      for (const token of tokens) {
        ranks.set(token.messageId, (ranks.get(token.messageId) ?? 0) + token.occurrences);
        const found = termCounts.get(token.messageId) ?? new Set<string>();
        found.add(token.token);
        termCounts.set(token.messageId, found);
      }
      const ids = [...ranks.keys()].filter((id) => termCounts.get(id)?.size === terms.length);
      if (!ids.length) return { messages: [], nextCursor: null };
      const rows = await messages.findMany({
        where: {
          id: { in: ids },
          deletedAt: null,
          conversation: { participants: { some: { userId: input.userId } } },
        },
      });
      const sorted = rows
        .slice()
        .sort(
          (a, b) =>
            ranks.get(b.id)! - ranks.get(a.id)! ||
            b.createdAt.getTime() - a.createdAt.getTime() ||
            b.id.localeCompare(a.id),
        );
      const cursor = decodeSearchCursor(input.cursor);
      const filtered = cursor
        ? sorted.filter((row) => {
            const rank = ranks.get(row.id)!;
            return (
              rank < cursor[0] ||
              (rank === cursor[0] &&
                (row.createdAt.getTime() < cursor[1] ||
                  (row.createdAt.getTime() === cursor[1] && row.id < cursor[2])))
            );
          })
        : sorted;
      const page = filtered.slice(0, input.limit);
      const last = page[page.length - 1];
      return {
        messages: page.map(toMessage),
        nextCursor:
          filtered.length > input.limit && last
            ? encodeSearchCursor(ranks.get(last.id)!, last.createdAt, last.id)
            : null,
      };
    },
    async listMessagesAfterSeq(input: ListMessagesAfterSeqInput): Promise<Message[]> {
      const rows = await messages.findMany({
        where: { conversationId: input.conversationId, seq: { gt: input.afterSeq } },
        orderBy: { seq: "asc" },
        take: input.limit,
      });
      return rows.map(toMessage);
    },
    async updateMessage(input: UpdateMessageInput): Promise<Message> {
      return transactionWithRetry(client, async (tx) => {
        const row = await tx.chatpackMessage.update({
          where: { id: input.messageId },
          data: {
            ...(input.body === undefined ? {} : { body: input.body }),
            ...(input.editedAt === undefined ? {} : { editedAt: input.editedAt }),
            ...(input.deletedAt === undefined ? {} : { deletedAt: input.deletedAt }),
          },
        });
        if (input.body !== undefined || input.deletedAt !== undefined) {
          await tx.chatpackMessageSearchToken.deleteMany({ where: { messageId: row.id } });
          if (!row.deletedAt)
            await insertSearchTokenRows(searchTokenRows(row.id, row.body), async (batch) => {
              await tx.chatpackMessageSearchToken.createMany({ data: batch, skipDuplicates: true });
            });
        }
        return toMessage(row);
      });
    },
    async updateLastRead(input: UpdateLastReadInput): Promise<void> {
      const result = await participants.updateMany({
        where: { conversationId: input.conversationId, userId: input.userId },
        data: { lastReadMessageId: input.messageId },
      });
      if (result.count !== 1)
        throw new Error(
          `prismaAdapter: user "${input.userId}" is not a participant of "${input.conversationId}".`,
        );
    },
    async countUnread(input: CountUnreadInput): Promise<Record<string, number>> {
      const counts: Record<string, number> = {};
      for (const id of input.conversationIds) counts[id] = 0;
      if (!input.conversationIds.length) return counts;
      const memberships = await participants.findMany({
        where: { userId: input.userId, conversationId: { in: input.conversationIds } },
      });
      const readIds = memberships.flatMap((row) =>
        row.lastReadMessageId ? [row.lastReadMessageId] : [],
      );
      const readRows = readIds.length
        ? await messages.findMany({ where: { id: { in: readIds } } })
        : [];
      const readSeq = new Map(readRows.map((row) => [row.id, row.seq]));
      const threshold = new Map(
        memberships.map((row) => [
          row.conversationId,
          row.lastReadMessageId ? (readSeq.get(row.lastReadMessageId) ?? 0) : 0,
        ]),
      );
      const rows = await messages.findMany({
        where: { conversationId: { in: input.conversationIds }, senderId: { not: input.userId } },
      });
      for (const row of rows)
        if (row.seq > (threshold.get(row.conversationId) ?? 0))
          counts[row.conversationId] = (counts[row.conversationId] ?? 0) + 1;
      return counts;
    },
    async addReaction(input: ReactionInput): Promise<Reaction[]> {
      try {
        await client.chatpackMessageReaction.create({
          data: {
            messageId: input.messageId,
            userId: input.userId,
            emoji: input.emoji,
            createdAt: new Date(),
          },
        });
      } catch (error) {
        if (!isCode(error, "P2002")) throw error;
      }
      return reactionsFor(input.messageId);
    },
    async removeReaction(input: ReactionInput): Promise<Reaction[]> {
      await client.chatpackMessageReaction.deleteMany({
        where: { messageId: input.messageId, userId: input.userId, emoji: input.emoji },
      });
      return reactionsFor(input.messageId);
    },
    async listReactionsByMessageIds(messageIds: string[]): Promise<Reaction[]> {
      if (!messageIds.length) return [];
      const rows = await client.chatpackMessageReaction.findMany({
        where: { messageId: { in: messageIds } },
        orderBy: [{ createdAt: "asc" }, { messageId: "asc" }, { userId: "asc" }, { emoji: "asc" }],
      });
      return rows.map(toReaction);
    },
    async setMessageMentions(input: SetMessageMentionsInput): Promise<void> {
      await transactionWithRetry(client, async (tx) => {
        if (!input.userIds.length) {
          await tx.chatpackMessageMention.deleteMany({ where: { messageId: input.messageId } });
          return;
        }
        const now = new Date();
        for (const userId of input.userIds)
          await tx.chatpackMessageMention.upsert({
            where: { messageId_userId: { messageId: input.messageId, userId } },
            create: { messageId: input.messageId, userId, createdAt: now },
            update: {},
          });
        await tx.chatpackMessageMention.deleteMany({
          where: { messageId: input.messageId, userId: { not: { in: input.userIds } } },
        });
      });
    },
    async listMentionsByMessageIds(messageIds: string[]): Promise<MessageMention[]> {
      if (!messageIds.length) return [];
      const rows = await client.chatpackMessageMention.findMany({
        where: { messageId: { in: messageIds } },
        orderBy: [{ createdAt: "asc" }, { messageId: "asc" }, { userId: "asc" }],
      });
      return rows.map(toMention);
    },
  };
  return adapter;
}
