/** `@chatpack/adapter-mysql` - server-side Drizzle ORM MySQL 8 StorageAdapter. */
import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  isNull,
  lt,
  ne,
  notInArray,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { alias } from "drizzle-orm/mysql-core";
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
import {
  conversationInvites,
  conversationParticipants,
  conversations,
  joinRequests,
  messageMentions,
  messageReactions,
  messageSearchTokens,
  messages,
} from "./schema";
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
  searchTokenRows,
} from "./utils";
import type { DrizzleMysqlDatabase, ParticipantRow } from "./types";
import { createModerationStorage } from "./moderation";

export type { DrizzleMysqlDatabase } from "./types";
export {
  chatpackSchema,
  conversationInvites,
  conversationParticipants,
  conversationMutes,
  conversations,
  joinRequests,
  messageMentions,
  messageReactions,
  messageSearchTokens,
  messages,
  moderationReports,
  userBans,
  userBlocks,
  migrationSql,
  migrationStatements,
} from "./schema";

/** Rebuild canonical search tokens after importing existing messages. */
export async function backfillMessageSearchTokens(db: DrizzleMysqlDatabase): Promise<void> {
  const rows = await db.select({ id: messages.id, body: messages.body, deletedAt: messages.deletedAt }).from(messages);
  const tokens = rows.flatMap((row) => (row.deletedAt ? [] : searchTokenRows(row.id, row.body)));
  await db.delete(messageSearchTokens);
  await insertSearchTokenRows(tokens, async (batch) => {
    await db.insert(messageSearchTokens).values(batch);
  });
}

type MysqlTransactionCallback = Parameters<DrizzleMysqlDatabase["transaction"]>[0];
type MysqlTransaction = MysqlTransactionCallback extends (tx: infer Tx) => unknown ? Tx : never;

/** Create adapter from caller-owned `drizzle-orm/mysql2` database. Server-side only. */
export function mysqlAdapter(db: DrizzleMysqlDatabase): StorageAdapter {
  async function participantsFor(conversationIds: string[]): Promise<Map<string, ParticipantRow[]>> {
    if (conversationIds.length === 0) return new Map();
    const rows = await db.select().from(conversationParticipants).where(inArray(conversationParticipants.conversationId, conversationIds)).orderBy(asc(conversationParticipants.joinedAt), asc(conversationParticipants.userId));
    const result = new Map<string, ParticipantRow[]>();
    for (const row of rows) result.set(row.conversationId, [...(result.get(row.conversationId) ?? []), row]);
    return result;
  }

  async function loadConversation(conversationId: string): Promise<Conversation | null> {
    const [row] = await db.select().from(conversations).where(eq(conversations.id, conversationId)).limit(1);
    if (!row) return null;
    const participants = await participantsFor([conversationId]);
    return toConversation(row, participants.get(conversationId) ?? []);
  }

  async function reloadConversation(conversationId: string): Promise<Conversation> {
    const conversation = await loadConversation(conversationId);
    if (!conversation) throw new Error(`mysqlAdapter: unknown conversation "${conversationId}".`);
    return conversation;
  }

  async function reactionsFor(messageId: string): Promise<Reaction[]> {
    const rows = await db.select().from(messageReactions).where(eq(messageReactions.messageId, messageId)).orderBy(asc(messageReactions.createdAt), asc(messageReactions.userId), asc(messageReactions.emoji));
    return rows.map(toReaction);
  }

  async function pageConversationsByActivity(filter: SQL, limit: number, cursor: string | undefined): Promise<ListConversationsResult> {
    const decoded = decodeActivityCursor(cursor);
    const cursorFilter = decoded ? or(lt(conversations.lastActivityAt, new Date(decoded.activityMs)), and(eq(conversations.lastActivityAt, new Date(decoded.activityMs)), lt(conversations.id, decoded.id))) : undefined;
    const rows = await db.select().from(conversations).where(cursorFilter ? and(filter, cursorFilter) : filter).orderBy(desc(conversations.lastActivityAt), desc(conversations.id)).limit(limit + 1);
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    const participants = await participantsFor(page.map((row) => row.id));
    return {
      conversations: page.map((row) => toConversation(row, participants.get(row.id) ?? [])),
      nextCursor: rows.length > limit && last ? encodeActivityCursor(last.lastActivityAt, last.id) : null,
    };
  }

  async function selectMessage(tx: MysqlTransaction, messageId: string) {
    const [row] = await tx.select().from(messages).where(eq(messages.id, messageId)).limit(1);
    return row;
  }

  const moderation = createModerationStorage(db);

  return {
    moderation,

    async getOrCreateDirectConversation(input: GetOrCreateDirectConversationInput): Promise<GetOrCreateDirectConversationResult> {
      const id = generateId("conv");
      const now = new Date();
      // MySQL's unique nullable pair_key accepts many NULLs, while non-NULL
      // pairs are arbitrated by the unique key. Participant insertion shares
      // this transaction, so no reader can observe a half-created DM.
      await db.transaction(async (tx) => {
        await tx.insert(conversations).values({ id, type: "direct", pairKey: input.pairKey, name: null, createdAt: now, metadata: input.metadata, lastSeq: 0, lastActivityAt: now }).onDuplicateKeyUpdate({ set: { pairKey: sql`${conversations.pairKey}` } });
        const [row] = await tx.select({ id: conversations.id }).from(conversations).where(eq(conversations.id, id)).limit(1);
        if (row) {
          await tx.insert(conversationParticipants).values(input.userIds.map((userId) => ({ conversationId: id, userId, role: "admin", joinedAt: now, lastReadMessageId: null })));
        }
      });
      const [row] = await db.select().from(conversations).where(eq(conversations.pairKey, input.pairKey)).limit(1);
      if (!row) throw new Error(`mysqlAdapter: conversation for pairKey "${input.pairKey}" vanished after insert.`);
      const participants = await participantsFor([row.id]);
      return { conversation: toConversation(row, participants.get(row.id) ?? []), created: row.id === id };
    },

    async createGroupConversation(input: CreateGroupConversationInput): Promise<Conversation> {
      const id = generateId("conv");
      const now = new Date();
      await db.transaction(async (tx) => {
        await tx.insert(conversations).values({ id, type: "group", pairKey: null, name: input.name, visibility: input.visibility, joinPolicy: input.joinPolicy, createdAt: now, metadata: input.metadata, lastSeq: 0, lastActivityAt: now });
        await tx.insert(conversationParticipants).values([
          { conversationId: id, userId: input.creatorId, role: "admin", joinedAt: now, lastReadMessageId: null },
          ...input.userIds.map((userId) => ({ conversationId: id, userId, role: "member", joinedAt: now, lastReadMessageId: null })),
        ]);
      });
      return reloadConversation(id);
    },

    async addParticipants(input: AddParticipantsInput): Promise<Conversation> {
      if (input.userIds.length > 0) {
        const now = new Date();
        await db.insert(conversationParticipants).values(input.userIds.map((userId) => ({ conversationId: input.conversationId, userId, role: "member", joinedAt: now, lastReadMessageId: null }))).onDuplicateKeyUpdate({ set: { userId: sql`${conversationParticipants.userId}` } });
      }
      return reloadConversation(input.conversationId);
    },

    async removeParticipant(input: RemoveParticipantInput): Promise<Conversation> {
      await db.delete(conversationParticipants).where(and(eq(conversationParticipants.conversationId, input.conversationId), eq(conversationParticipants.userId, input.userId)));
      return reloadConversation(input.conversationId);
    },

    async setParticipantRole(input: SetParticipantRoleInput): Promise<Conversation> {
      await db.update(conversationParticipants).set({ role: input.role }).where(and(eq(conversationParticipants.conversationId, input.conversationId), eq(conversationParticipants.userId, input.userId)));
      return reloadConversation(input.conversationId);
    },

    async updateConversation(input: UpdateConversationInput): Promise<Conversation> {
      await db.update(conversations).set({ name: input.name, visibility: input.visibility, joinPolicy: input.joinPolicy }).where(eq(conversations.id, input.conversationId));
      return reloadConversation(input.conversationId);
    },

    async getConversation(conversationId: string): Promise<Conversation | null> {
      return loadConversation(conversationId);
    },

    async listConversations(input: ListConversationsInput): Promise<ListConversationsResult> {
      const membership = db.select({ conversationId: conversationParticipants.conversationId }).from(conversationParticipants).where(eq(conversationParticipants.userId, input.userId));
      return pageConversationsByActivity(inArray(conversations.id, membership), input.limit, input.cursor);
    },

    async addMessage(input: AddMessageInput): Promise<Message> {
      const now = new Date();
      // InnoDB locks the conversation row during UPDATE and holds that lock
      // until commit. The following SELECT therefore sees this transaction's
      // increment, and concurrent writers receive distinct strict sequences.
      return db.transaction(async (tx) => {
        await tx.update(conversations).set({ lastSeq: sql`${conversations.lastSeq} + 1`, lastActivityAt: now }).where(eq(conversations.id, input.conversationId));
        const [conversation] = await tx.select({ lastSeq: conversations.lastSeq }).from(conversations).where(eq(conversations.id, input.conversationId)).limit(1);
        if (!conversation) throw new Error(`mysqlAdapter: unknown conversation "${input.conversationId}".`);
        const id = generateId("msg");
        await tx.insert(messages).values({ id, conversationId: input.conversationId, senderId: input.senderId, body: input.body, role: input.role, seq: conversation.lastSeq, createdAt: now, editedAt: null, deletedAt: null, replyToMessageId: input.replyToMessageId, forwardedFromMessageId: input.forwardedFromMessageId, forwardedFromConversationId: input.forwardedFromConversationId, forwardedFromSenderId: input.forwardedFromSenderId, metadata: input.metadata });
        const row = await selectMessage(tx, id);
        if (!row) throw new Error("mysqlAdapter: message insert returned no row.");
        await insertSearchTokenRows(searchTokenRows(id, input.body), async (batch) => {
          await tx.insert(messageSearchTokens).values(batch);
        });
        return toMessage(row);
      });
    },

    async getMessage(messageId: string): Promise<Message | null> {
      const [row] = await db.select().from(messages).where(eq(messages.id, messageId)).limit(1);
      return row ? toMessage(row) : null;
    },

    async getMessagesByIds(messageIds: string[]): Promise<Message[]> {
      if (messageIds.length === 0) return [];
      const rows = await db.select().from(messages).where(inArray(messages.id, messageIds));
      return rows.map(toMessage);
    },

    async listMessages(input: ListMessagesInput): Promise<ListMessagesResult> {
      const cursorSeq = input.cursor === undefined ? undefined : Number(input.cursor);
      const rows = await db.select().from(messages).where(cursorSeq !== undefined && Number.isFinite(cursorSeq) ? and(eq(messages.conversationId, input.conversationId), lt(messages.seq, cursorSeq)) : eq(messages.conversationId, input.conversationId)).orderBy(desc(messages.seq)).limit(input.limit + 1);
      const page = rows.slice(0, input.limit);
      const last = page[page.length - 1];
      return { messages: page.map(toMessage), nextCursor: rows.length > input.limit && last ? String(last.seq) : null };
    },

    async searchMessages(input: SearchMessagesInput): Promise<SearchMessagesResult> {
      const terms = getSearchTerms(input.query);
      if (terms.length === 0) return { messages: [], nextCursor: null };
      const matches = db.select({ messageId: messageSearchTokens.messageId, rank: sql<number>`sum(${messageSearchTokens.occurrences})`.as("rank") }).from(messageSearchTokens).where(inArray(messageSearchTokens.token, terms)).groupBy(messageSearchTokens.messageId).having(sql`count(distinct ${messageSearchTokens.token}) = ${terms.length}`).as("search_matches");
      const conditions = [isNull(messages.deletedAt), eq(conversationParticipants.userId, input.userId)];
      const cursor = decodeSearchCursor(input.cursor);
      if (cursor) {
        const [rank, createdAt, id] = cursor;
        const date = new Date(createdAt);
        conditions.push(or(lt(matches.rank, rank), and(eq(matches.rank, rank), lt(messages.createdAt, date)), and(eq(matches.rank, rank), eq(messages.createdAt, date), lt(messages.id, id)))!);
      }
      const rows = await db.select({ message: messages, rank: matches.rank }).from(matches).innerJoin(messages, eq(messages.id, matches.messageId)).innerJoin(conversationParticipants, eq(conversationParticipants.conversationId, messages.conversationId)).where(and(...conditions)).orderBy(desc(matches.rank), desc(messages.createdAt), desc(messages.id)).limit(input.limit + 1);
      const page = rows.slice(0, input.limit);
      const last = page[page.length - 1];
      return { messages: page.map((row) => toMessage(row.message)), nextCursor: rows.length > input.limit && last ? encodeSearchCursor(last.rank, last.message.createdAt, last.message.id) : null };
    },

    async listMessagesAfterSeq(input: ListMessagesAfterSeqInput): Promise<Message[]> {
      const rows = await db.select().from(messages).where(and(eq(messages.conversationId, input.conversationId), gt(messages.seq, input.afterSeq))).orderBy(asc(messages.seq)).limit(input.limit);
      return rows.map(toMessage);
    },

    async updateMessage(input: UpdateMessageInput): Promise<Message> {
      const patch: Partial<typeof messages.$inferInsert> = {};
      if (input.body !== undefined) patch.body = input.body;
      if (input.editedAt !== undefined) patch.editedAt = input.editedAt;
      if (input.deletedAt !== undefined) patch.deletedAt = input.deletedAt;
      return db.transaction(async (tx) => {
        await tx.update(messages).set(patch).where(eq(messages.id, input.messageId));
        const row = await selectMessage(tx, input.messageId);
        if (!row) throw new Error(`mysqlAdapter: unknown message "${input.messageId}".`);
        if (input.body !== undefined || input.deletedAt !== undefined) {
          await tx.delete(messageSearchTokens).where(eq(messageSearchTokens.messageId, row.id));
          if (!row.deletedAt) await insertSearchTokenRows(searchTokenRows(row.id, row.body), async (batch) => { await tx.insert(messageSearchTokens).values(batch); });
        }
        return toMessage(row);
      });
    },

    async updateLastRead(input: UpdateLastReadInput): Promise<void> {
      await db.update(conversationParticipants).set({ lastReadMessageId: input.messageId }).where(and(eq(conversationParticipants.conversationId, input.conversationId), eq(conversationParticipants.userId, input.userId)));
      const [row] = await db.select({ userId: conversationParticipants.userId }).from(conversationParticipants).where(and(eq(conversationParticipants.conversationId, input.conversationId), eq(conversationParticipants.userId, input.userId))).limit(1);
      if (!row) throw new Error(`mysqlAdapter: user "${input.userId}" is not a participant of "${input.conversationId}".`);
    },

    async countUnread(input: CountUnreadInput): Promise<Record<string, number>> {
      const counts: Record<string, number> = {};
      for (const id of input.conversationIds) counts[id] = 0;
      if (input.conversationIds.length === 0) return counts;
      const readMessage = alias(messages, "read_msg");
      const rows = await db.select({ conversationId: messages.conversationId, count: sql<number>`count(*)`.mapWith(Number) }).from(messages).innerJoin(conversationParticipants, and(eq(conversationParticipants.conversationId, messages.conversationId), eq(conversationParticipants.userId, input.userId))).leftJoin(readMessage, eq(readMessage.id, conversationParticipants.lastReadMessageId)).where(and(inArray(messages.conversationId, input.conversationIds), ne(messages.senderId, input.userId), sql`${messages.seq} > coalesce(${readMessage.seq}, 0)`)).groupBy(messages.conversationId);
      for (const row of rows) counts[row.conversationId] = row.count;
      return counts;
    },

    async addReaction(input: ReactionInput): Promise<Reaction[]> {
      await db.insert(messageReactions).values({ messageId: input.messageId, userId: input.userId, emoji: input.emoji, createdAt: new Date() }).onDuplicateKeyUpdate({ set: { messageId: sql`${messageReactions.messageId}` } });
      return reactionsFor(input.messageId);
    },

    async removeReaction(input: ReactionInput): Promise<Reaction[]> {
      await db.delete(messageReactions).where(and(eq(messageReactions.messageId, input.messageId), eq(messageReactions.userId, input.userId), eq(messageReactions.emoji, input.emoji)));
      return reactionsFor(input.messageId);
    },

    async listReactionsByMessageIds(messageIds: string[]): Promise<Reaction[]> {
      if (messageIds.length === 0) return [];
      const rows = await db.select().from(messageReactions).where(inArray(messageReactions.messageId, messageIds)).orderBy(asc(messageReactions.createdAt), asc(messageReactions.messageId), asc(messageReactions.userId), asc(messageReactions.emoji));
      return rows.map(toReaction);
    },

    async setMessageMentions(input: SetMessageMentionsInput): Promise<void> {
      await db.transaction(async (tx) => {
        if (input.userIds.length > 0) {
          const now = new Date();
          await tx.insert(messageMentions).values(input.userIds.map((userId) => ({ messageId: input.messageId, userId, createdAt: now }))).onDuplicateKeyUpdate({ set: { messageId: sql`${messageMentions.messageId}` } });
          await tx.delete(messageMentions).where(and(eq(messageMentions.messageId, input.messageId), notInArray(messageMentions.userId, input.userIds)));
        } else {
          await tx.delete(messageMentions).where(eq(messageMentions.messageId, input.messageId));
        }
      });
    },

    async listMentionsByMessageIds(messageIds: string[]): Promise<MessageMention[]> {
      if (messageIds.length === 0) return [];
      const rows = await db.select().from(messageMentions).where(inArray(messageMentions.messageId, messageIds)).orderBy(asc(messageMentions.createdAt), asc(messageMentions.messageId), asc(messageMentions.userId));
      return rows.map(toMention);
    },

    channels: {
      async listPublicConversations(input: ListPublicConversationsInput): Promise<ListPublicConversationsResult> {
        return pageConversationsByActivity(and(eq(conversations.visibility, "public"), eq(conversations.type, "group"))!, input.limit, input.cursor);
      },
    },

    invites: {
      async createInvite(input: CreateInviteInput): Promise<ConversationInvite> {
        const code = input.code;
        await db.insert(conversationInvites).values({ code, conversationId: input.conversationId, createdBy: input.createdBy, createdAt: new Date(), expiresAt: input.expiresAt, maxUses: input.maxUses, uses: 0, requiresApproval: input.requiresApproval, metadata: input.metadata });
        const [row] = await db.select().from(conversationInvites).where(eq(conversationInvites.code, code)).limit(1);
        if (!row) throw new Error("mysqlAdapter: failed to create invite.");
        return toInvite(row);
      },

      async getInvite(code: string): Promise<ConversationInvite | null> {
        const [row] = await db.select().from(conversationInvites).where(eq(conversationInvites.code, code)).limit(1);
        return row ? toInvite(row) : null;
      },

      async listInvites(conversationId: string): Promise<ConversationInvite[]> {
        const rows = await db.select().from(conversationInvites).where(eq(conversationInvites.conversationId, conversationId)).orderBy(desc(conversationInvites.createdAt), desc(conversationInvites.code));
        return rows.map(toInvite);
      },

      async deleteInvite(input: DeleteInviteInput): Promise<void> {
        await db.delete(conversationInvites).where(and(eq(conversationInvites.code, input.code), eq(conversationInvites.conversationId, input.conversationId)));
      },

      async consumeInvite(code: string): Promise<ConversationInvite | null> {
        const now = new Date();
        return db.transaction(async (tx) => {
          const result = await tx.update(conversationInvites).set({ uses: sql`${conversationInvites.uses} + 1` }).where(and(eq(conversationInvites.code, code), or(isNull(conversationInvites.maxUses), lt(conversationInvites.uses, conversationInvites.maxUses)), or(isNull(conversationInvites.expiresAt), gt(conversationInvites.expiresAt, now))));
          const affected = result[0].affectedRows;
          if (affected !== 1) return null;
          const [row] = await tx.select().from(conversationInvites).where(eq(conversationInvites.code, code)).limit(1);
          return row ? toInvite(row) : null;
        });
      },

      async createJoinRequest(input: CreateJoinRequestInput): Promise<JoinRequest> {
        const now = new Date();
        const id = generateId("jreq");
        await db.insert(joinRequests).values({ id, conversationId: input.conversationId, userId: input.userId, status: "pending", message: input.message, inviteCode: input.inviteCode, createdAt: now, resolvedAt: null, resolvedBy: null, metadata: input.metadata }).onDuplicateKeyUpdate({ set: { status: "pending", message: input.message, inviteCode: input.inviteCode, createdAt: now, resolvedAt: null, resolvedBy: null, metadata: input.metadata } });
        const [row] = await db.select().from(joinRequests).where(and(eq(joinRequests.conversationId, input.conversationId), eq(joinRequests.userId, input.userId))).limit(1);
        if (!row) throw new Error("mysqlAdapter: failed to create join request.");
        return toJoinRequest(row);
      },

      async getJoinRequest(input: GetJoinRequestInput): Promise<JoinRequest | null> {
        const [row] = await db.select().from(joinRequests).where(and(eq(joinRequests.conversationId, input.conversationId), eq(joinRequests.userId, input.userId))).limit(1);
        return row ? toJoinRequest(row) : null;
      },

      async listJoinRequests(input: ListJoinRequestsInput): Promise<JoinRequest[]> {
        const rows = await db.select().from(joinRequests).where(input.status === undefined ? eq(joinRequests.conversationId, input.conversationId) : and(eq(joinRequests.conversationId, input.conversationId), eq(joinRequests.status, input.status))).orderBy(desc(joinRequests.createdAt), desc(joinRequests.id)).limit(input.limit);
        return rows.map(toJoinRequest);
      },

      async resolveJoinRequest(input: ResolveJoinRequestInput): Promise<JoinRequest> {
        await db.update(joinRequests).set({ status: input.status, resolvedAt: input.resolvedAt, resolvedBy: input.resolvedBy }).where(and(eq(joinRequests.conversationId, input.conversationId), eq(joinRequests.userId, input.userId)));
        const [row] = await db.select().from(joinRequests).where(and(eq(joinRequests.conversationId, input.conversationId), eq(joinRequests.userId, input.userId))).limit(1);
        if (!row) throw new Error(`mysqlAdapter: no join request from user "${input.userId}" in "${input.conversationId}".`);
        return toJoinRequest(row);
      },
    },
  };
}
