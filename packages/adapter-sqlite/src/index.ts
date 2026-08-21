/**
 * `@chatpack/adapter-sqlite` - Drizzle ORM (SQLite) {@link StorageAdapter}
 * for Chatpack. Real persistence for production (M4).
 *
 * Uses Drizzle's synchronous `better-sqlite3` driver and SQLite's transaction
 * and locking semantics for durable local or single-node persistence.
 *
 * ```ts
 * import Database from "better-sqlite3";
 * import { drizzle } from "drizzle-orm/better-sqlite3";
 * import { chatpack } from "@chatpack/core";
 * import { sqliteAdapter } from "@chatpack/adapter-sqlite";
 *
 * const db = drizzle(new Database("./chatpack.sqlite"));
 * const chat = chatpack({ storage: sqliteAdapter(db), auth });
 * ```
 *
 * Correctness notes (the parts a chat backend must get right):
 *
 * - **Monotonic `seq` under concurrency:** `addMessage` increments the
 *   conversation's `last_seq` with a single atomic
 *   `UPDATE ... SET last_seq = last_seq + 1 RETURNING` - SQLite row
 *   locking makes concurrent sends serialize correctly with no gaps-by-race
 *   and no duplicates (ADR 0003, ADR 0007).
 * - **Idempotent find-or-create:** DM creation uses a targetless
 *   `ON CONFLICT DO NOTHING` + re-select, so concurrent calls for the same
 *   user pair converge on one conversation (ADR 0002). Groups take the
 *   plain-insert path instead: they have no pair key and nothing to converge
 *   on (ADR 0017).
 *
 * @module
 */

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
import { alias } from "drizzle-orm/sqlite-core";

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
  toMessage,
  toMention,
  toReaction,
} from "./converters";
import {
  decodeSearchCursor,
  encodeSearchCursor,
  generateId,
  insertSearchTokenRows,
  SEARCH_TOKEN_BATCH_SIZE,
  searchTokenRows,
} from "./utils";
import type { ParticipantRow, DrizzleSqliteDatabase } from "./types";
import { createModerationStorage } from "./moderation";

export type { DrizzleSqliteDatabase } from "./types";

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

/**
 * Rebuild the canonical token table after applying the exported migration to
 * a database that already contains messages. New messages and edits maintain
 * their rows automatically through {@link sqliteAdapter}.
 */
export async function backfillMessageSearchTokens(db: DrizzleSqliteDatabase): Promise<void> {
  const rows = await db
    .select({ id: messages.id, body: messages.body, deletedAt: messages.deletedAt })
    .from(messages);
  const tokens = rows.flatMap((row) => (row.deletedAt ? [] : searchTokenRows(row.id, row.body)));

  await db.delete(messageSearchTokens);
  await insertSearchTokenRows(tokens, async (batch) => {
    await db.insert(messageSearchTokens).values(batch);
  });
}

/**
 * Create a Drizzle/SQLite storage adapter.
 *
 * The Chatpack tables must exist - generate a migration from the exported
 * schema with `drizzle-kit`, or run the exported {@link migrationSql} once.
 *
 * @param db - Any Drizzle SQLite database instance.
 */
export function sqliteAdapter(db: DrizzleSqliteDatabase): StorageAdapter {
  /**
   * Load participant rows for a set of conversation ids.
   *
   * Ordered by `joined_at` (then `user_id` to break ties, since a group's seed
   * members all share one timestamp): the creator therefore comes first, and
   * more importantly the order is **stable across reads**. SQLite gives no
   * row order without `ORDER BY`, and clients diff participant lists
   * positionally - with N-member groups an unordered read would look like a
   * membership change on every poll (ADR 0017).
   */
  async function participantsFor(
    conversationIds: string[],
  ): Promise<Map<string, ParticipantRow[]>> {
    if (conversationIds.length === 0) return new Map();
    const rows = await db
      .select()
      .from(conversationParticipants)
      .where(or(...conversationIds.map((id) => eq(conversationParticipants.conversationId, id))))
      .orderBy(asc(conversationParticipants.joinedAt), asc(conversationParticipants.userId));
    const byConversation = new Map<string, ParticipantRow[]>();
    for (const row of rows) {
      const list = byConversation.get(row.conversationId) ?? [];
      list.push(row);
      byConversation.set(row.conversationId, list);
    }
    return byConversation;
  }

  /** Every reaction on one message, earliest-first - the post-write snapshot. */
  async function reactionsFor(messageId: string): Promise<Reaction[]> {
    const rows = await db
      .select()
      .from(messageReactions)
      .where(eq(messageReactions.messageId, messageId))
      .orderBy(asc(messageReactions.createdAt));
    return rows.map(toReaction);
  }

  async function loadConversation(conversationId: string): Promise<Conversation | null> {
    const [row] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, conversationId))
      .limit(1);
    if (!row) return null;
    const participants = await participantsFor([row.id]);
    return toConversation(row, participants.get(row.id) ?? []);
  }

  /**
   * Re-read a conversation after a membership write, for the full-snapshot
   * return the contract requires (ADR 0017 §6). Throws if the row is gone -
   * core only calls these after loading the conversation, so a miss is a bug
   * (or a concurrent delete), not an expected outcome.
   */
  async function reloadConversation(conversationId: string): Promise<Conversation> {
    const conversation = await loadConversation(conversationId);
    if (!conversation) {
      throw new Error(`sqliteAdapter: unknown conversation "${conversationId}".`);
    }
    return conversation;
  }

  /**
   * Page conversations matching `filter`, most-recently-active first, with
   * keyset pagination on `(last_activity_at, id)` - the cursor encodes both.
   *
   * Keyset rather than OFFSET so a conversation that receives a message between
   * two page fetches cannot shift rows across the boundary and hide one.
   *
   * Shared by `listConversations` and the ADR 0020 channel directory: the two
   * differ only in their filter, and a directory that ordered or paginated
   * differently would be a second set of rules for clients to learn.
   */
  async function pageConversationsByActivity(
    filter: SQL,
    limit: number,
    cursor: string | undefined,
  ): Promise<ListConversationsResult> {
    let cursorFilter = undefined;
    if (cursor) {
      const separator = cursor.indexOf(":");
      const activityMs = Number(cursor.slice(0, separator));
      const cursorId = cursor.slice(separator + 1);
      if (Number.isFinite(activityMs) && cursorId) {
        const cursorDate = new Date(activityMs);
        cursorFilter = or(
          lt(conversations.lastActivityAt, cursorDate),
          and(eq(conversations.lastActivityAt, cursorDate), lt(conversations.id, cursorId)),
        );
      }
    }

    const rows = await db
      .select()
      .from(conversations)
      .where(cursorFilter ? and(filter, cursorFilter) : filter)
      .orderBy(desc(conversations.lastActivityAt), desc(conversations.id))
      // One extra row is how we know whether to hand back a cursor, without a
      // second COUNT query.
      .limit(limit + 1);

    const page = rows.slice(0, limit);
    const hasMore = rows.length > limit;
    const last = page[page.length - 1];
    const nextCursor = hasMore && last ? `${last.lastActivityAt.getTime()}:${last.id}` : null;

    const participants = await participantsFor(page.map((r) => r.id));
    return {
      conversations: page.map((row) => toConversation(row, participants.get(row.id) ?? [])),
      nextCursor,
    };
  }
  const moderation = createModerationStorage(db);

  return {
    moderation,
    async getOrCreateDirectConversation(
      input: GetOrCreateDirectConversationInput,
    ): Promise<GetOrCreateDirectConversationResult> {
      const now = new Date();
      const id = generateId("conv");

      // Idempotent create (ADR 0002): the unique index on pair_key is the
      // arbiter. ON CONFLICT DO NOTHING → zero rows returned means another
      // call (possibly concurrent) already created it.
      const inserted = await db
        .insert(conversations)
        .values({
          id,
          type: "direct",
          pairKey: input.pairKey,
          name: null,
          createdAt: now,
          metadata: input.metadata,
          lastSeq: 0,
          lastActivityAt: now,
        })
        // The pair-key index is partial because groups use null pair keys. A
        // targetless SQLite conflict handler still catches that unique-index
        // conflict and avoids dialect-specific conflict-target syntax.
        .onConflictDoNothing()
        .returning({ id: conversations.id });

      const created = inserted.length > 0;
      if (created) {
        await db.insert(conversationParticipants).values(
          input.userIds.map((userId) => ({
            conversationId: id,
            userId,
            // Both DM participants are admins - a DM has nothing to administer
            // (ADR 0017 §3).
            role: "admin",
            joinedAt: now,
            lastReadMessageId: null,
          })),
        );
      }

      const [row] = await db
        .select()
        .from(conversations)
        .where(eq(conversations.pairKey, input.pairKey))
        .limit(1);
      if (!row) {
        throw new Error(
          `sqliteAdapter: conversation for pairKey "${input.pairKey}" vanished after insert.`,
        );
      }
      const participants = await participantsFor([row.id]);
      return { conversation: toConversation(row, participants.get(row.id) ?? []), created };
    },

    async createGroupConversation(input: CreateGroupConversationInput): Promise<Conversation> {
      const now = new Date();
      const id = generateId("conv");

      // Not find-or-create (ADR 0017 §2): a group has no pair key, so there is
      // no conflict target and nothing to converge on - two groups with the
      // same members are two different groups.
      db.transaction((tx) => {
        tx.insert(conversations)
          .values({
            id,
            type: "group",
            pairKey: null,
            name: input.name,
            // Always resolved by core, never undefined (ADR 0020 §4).
            visibility: input.visibility,
            joinPolicy: input.joinPolicy,
            createdAt: now,
            metadata: input.metadata,
            lastSeq: 0,
            lastActivityAt: now,
          })
          .run();
        tx.insert(conversationParticipants)
          .values([
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
          ])
          .run();
      });

      return reloadConversation(id);
    },

    async addParticipants(input: AddParticipantsInput): Promise<Conversation> {
      if (input.userIds.length > 0) {
        const now = new Date();
        // Idempotent via the (conversation_id, user_id) unique index: a replayed
        // add leaves the existing row untouched, so it can never demote an admin
        // back to member or reset their read-state (ADR 0017 §3).
        await db
          .insert(conversationParticipants)
          .values(
            input.userIds.map((userId) => ({
              conversationId: input.conversationId,
              userId,
              role: "member",
              joinedAt: now,
              lastReadMessageId: null,
            })),
          )
          .onConflictDoNothing({
            target: [conversationParticipants.conversationId, conversationParticipants.userId],
          });
      }
      return reloadConversation(input.conversationId);
    },

    async removeParticipant(input: RemoveParticipantInput): Promise<Conversation> {
      // Idempotent: deleting a row that isn't there affects zero rows. Messages
      // are left alone - departure does not rewrite history (ADR 0017 §6).
      await db
        .delete(conversationParticipants)
        .where(
          and(
            eq(conversationParticipants.conversationId, input.conversationId),
            eq(conversationParticipants.userId, input.userId),
          ),
        );
      return reloadConversation(input.conversationId);
    },

    async setParticipantRole(input: SetParticipantRoleInput): Promise<Conversation> {
      await db
        .update(conversationParticipants)
        .set({ role: input.role })
        .where(
          and(
            eq(conversationParticipants.conversationId, input.conversationId),
            eq(conversationParticipants.userId, input.userId),
          ),
        );
      return reloadConversation(input.conversationId);
    },

    async updateConversation(input: UpdateConversationInput): Promise<Conversation> {
      await db
        .update(conversations)
        // Every field is the resolved new value, not a patch - core read the row
        // and filled in whatever the caller omitted (ADR 0020 §5).
        .set({ name: input.name, visibility: input.visibility, joinPolicy: input.joinPolicy })
        .where(eq(conversations.id, input.conversationId));
      return reloadConversation(input.conversationId);
    },

    async getConversation(conversationId: string): Promise<Conversation | null> {
      return loadConversation(conversationId);
    },

    async listConversations(input: ListConversationsInput): Promise<ListConversationsResult> {
      const membership = db
        .select({ conversationId: conversationParticipants.conversationId })
        .from(conversationParticipants)
        .where(eq(conversationParticipants.userId, input.userId));

      return pageConversationsByActivity(
        sql`${conversations.id} IN ${membership}`,
        input.limit,
        input.cursor,
      );
    },

    async addMessage(input: AddMessageInput): Promise<Message> {
      const now = new Date();

      // THE critical line of the adapter (ADR 0003/0007): one atomic
      // read-modify-write. SQLite locks the row for the duration of the
      // UPDATE, so concurrent sends serialize and each gets a unique seq.
      return db.transaction((tx) => {
        const [bumped] = tx
          .update(conversations)
          .set({
            lastSeq: sql`${conversations.lastSeq} + 1`,
            lastActivityAt: now,
          })
          .where(eq(conversations.id, input.conversationId))
          .returning({ seq: conversations.lastSeq })
          .all();

        if (!bumped) {
          throw new Error(`sqliteAdapter: unknown conversation "${input.conversationId}".`);
        }

        const [row] = tx
          .insert(messages)
          .values({
            id: generateId("msg"),
            conversationId: input.conversationId,
            senderId: input.senderId,
            body: input.body,
            role: input.role,
            seq: bumped.seq,
            createdAt: now,
            editedAt: null,
            deletedAt: null,
            replyToMessageId: input.replyToMessageId,
            forwardedFromMessageId: input.forwardedFromMessageId,
            forwardedFromConversationId: input.forwardedFromConversationId,
            forwardedFromSenderId: input.forwardedFromSenderId,
            metadata: input.metadata,
          })
          .returning()
          .all();

        if (!row) {
          throw new Error("sqliteAdapter: message insert returned no row.");
        }
        const tokenRows = searchTokenRows(row.id, row.body);
        for (let offset = 0; offset < tokenRows.length; offset += SEARCH_TOKEN_BATCH_SIZE) {
          tx.insert(messageSearchTokens)
            .values(tokenRows.slice(offset, offset + SEARCH_TOKEN_BATCH_SIZE))
            .run();
        }
        return toMessage(row);
      });
    },

    async getMessage(messageId: string): Promise<Message | null> {
      const [row] = await db.select().from(messages).where(eq(messages.id, messageId)).limit(1);
      return row ? toMessage(row) : null;
    },

    async getMessagesByIds(messageIds: string[]): Promise<Message[]> {
      if (messageIds.length === 0) return [];
      const rows = await db
        .select()
        .from(messages)
        .where(or(...messageIds.map((id) => eq(messages.id, id))));
      return rows.map(toMessage);
    },

    async listMessages(input: ListMessagesInput): Promise<ListMessagesResult> {
      // Newest-first keyset pagination: the cursor is the seq of the last
      // message on the previous page.
      const cursorSeq = input.cursor === undefined ? undefined : Number(input.cursor);
      const conversationFilter = eq(messages.conversationId, input.conversationId);

      const rows = await db
        .select()
        .from(messages)
        .where(
          cursorSeq !== undefined && Number.isFinite(cursorSeq)
            ? and(conversationFilter, lt(messages.seq, cursorSeq))
            : conversationFilter,
        )
        .orderBy(desc(messages.seq))
        .limit(input.limit + 1);

      const page = rows.slice(0, input.limit);
      const hasMore = rows.length > input.limit;
      const last = page[page.length - 1];
      const nextCursor = hasMore && last ? String(last.seq) : null;

      return { messages: page.map(toMessage), nextCursor };
    },

    async searchMessages(input: SearchMessagesInput): Promise<SearchMessagesResult> {
      const terms = getSearchTerms(input.query);
      if (terms.length === 0) return { messages: [], nextCursor: null };

      const matches = db
        .select({
          messageId: messageSearchTokens.messageId,
          // Keep rank as a numeric SQL expression for the opaque cursor.
          rank: sql<number>`sum(${messageSearchTokens.occurrences})`.as("rank"),
        })
        .from(messageSearchTokens)
        .where(inArray(messageSearchTokens.token, terms))
        .groupBy(messageSearchTokens.messageId)
        .having(sql`count(distinct ${messageSearchTokens.token}) = ${terms.length}`)
        .as("search_matches");

      const conditions = [
        isNull(messages.deletedAt),
        eq(conversationParticipants.userId, input.userId),
      ];

      const cursor = input.cursor ? decodeSearchCursor(input.cursor) : null;
      if (cursor) {
        const [cursorRank, cursorCreatedAt, cursorId] = cursor;
        const cursorDate = new Date(cursorCreatedAt);
        const cursorCondition = or(
          lt(matches.rank, cursorRank),
          and(eq(matches.rank, cursorRank), lt(messages.createdAt, cursorDate)),
          and(
            eq(matches.rank, cursorRank),
            eq(messages.createdAt, cursorDate),
            lt(messages.id, cursorId),
          ),
        );
        if (cursorCondition) conditions.push(cursorCondition);
      }

      const rows = await db
        .select({ message: messages, rank: matches.rank })
        .from(matches)
        .innerJoin(messages, eq(messages.id, matches.messageId))
        .innerJoin(
          conversationParticipants,
          eq(conversationParticipants.conversationId, messages.conversationId),
        )
        .where(and(...conditions))
        .orderBy(desc(matches.rank), desc(messages.createdAt), desc(messages.id))
        .limit(input.limit + 1);

      const page = rows.slice(0, input.limit);
      const hasMore = rows.length > input.limit;
      const last = page[page.length - 1];
      return {
        messages: page.map((row) => toMessage(row.message)),
        nextCursor:
          hasMore && last
            ? encodeSearchCursor(last.rank, last.message.createdAt, last.message.id)
            : null,
      };
    },

    async listMessagesAfterSeq(input: ListMessagesAfterSeqInput): Promise<Message[]> {
      const rows = await db
        .select()
        .from(messages)
        .where(
          and(eq(messages.conversationId, input.conversationId), gt(messages.seq, input.afterSeq)),
        )
        .orderBy(asc(messages.seq))
        .limit(input.limit);
      return rows.map(toMessage);
    },

    async updateMessage(input: UpdateMessageInput): Promise<Message> {
      const patch: Partial<typeof messages.$inferInsert> = {};
      if (input.body !== undefined) patch.body = input.body;
      if (input.editedAt !== undefined) patch.editedAt = input.editedAt;
      if (input.deletedAt !== undefined) patch.deletedAt = input.deletedAt;

      return db.transaction((tx) => {
        const [row] = tx
          .update(messages)
          .set(patch)
          .where(eq(messages.id, input.messageId))
          .returning()
          .all();

        if (!row) {
          throw new Error(`sqliteAdapter: unknown message "${input.messageId}".`);
        }
        if (input.body !== undefined || input.deletedAt !== undefined) {
          tx.delete(messageSearchTokens).where(eq(messageSearchTokens.messageId, row.id)).run();
          if (!row.deletedAt) {
            const tokenRows = searchTokenRows(row.id, row.body);
            for (let offset = 0; offset < tokenRows.length; offset += SEARCH_TOKEN_BATCH_SIZE) {
              tx.insert(messageSearchTokens)
                .values(tokenRows.slice(offset, offset + SEARCH_TOKEN_BATCH_SIZE))
                .run();
            }
          }
        }
        return toMessage(row);
      });
    },

    async updateLastRead(input: UpdateLastReadInput): Promise<void> {
      const updated = await db
        .update(conversationParticipants)
        .set({ lastReadMessageId: input.messageId })
        .where(
          and(
            eq(conversationParticipants.conversationId, input.conversationId),
            eq(conversationParticipants.userId, input.userId),
          ),
        )
        .returning({ userId: conversationParticipants.userId });

      if (updated.length === 0) {
        throw new Error(
          `sqliteAdapter: user "${input.userId}" is not a participant of "${input.conversationId}".`,
        );
      }
    },

    async countUnread(input: CountUnreadInput): Promise<Record<string, number>> {
      const counts: Record<string, number> = {};
      for (const id of input.conversationIds) counts[id] = 0;
      if (input.conversationIds.length === 0) return counts;

      // One batched query per page. The participant join scopes each count to
      // the viewer's read-state; the self-join resolves lastReadMessageId to
      // its seq (COALESCE 0 when read-state is null). The unique
      // (conversation_id, seq) index makes each range count an index scan.
      const readMsg = alias(messages, "read_msg");
      const rows = await db
        .select({
          conversationId: messages.conversationId,
          count: sql`count(*)`.mapWith(Number),
        })
        .from(messages)
        .innerJoin(
          conversationParticipants,
          and(
            eq(conversationParticipants.conversationId, messages.conversationId),
            eq(conversationParticipants.userId, input.userId),
          ),
        )
        .leftJoin(readMsg, eq(readMsg.id, conversationParticipants.lastReadMessageId))
        .where(
          and(
            or(...input.conversationIds.map((id) => eq(messages.conversationId, id))),
            // A viewer's own messages are never unread; tombstones count.
            ne(messages.senderId, input.userId),
            sql`${messages.seq} > coalesce(${readMsg.seq}, 0)`,
          ),
        )
        .groupBy(messages.conversationId);

      for (const row of rows) counts[row.conversationId] = row.count;
      return counts;
    },

    async addReaction(input: ReactionInput): Promise<Reaction[]> {
      // Idempotent (ADR 0013): the unique (message_id, user_id, emoji) index is
      // the arbiter, so a double-tap or a replayed request is a no-op rather
      // than a duplicate row or an error.
      await db
        .insert(messageReactions)
        .values({
          messageId: input.messageId,
          userId: input.userId,
          emoji: input.emoji,
          createdAt: new Date(),
        })
        .onConflictDoNothing({
          target: [messageReactions.messageId, messageReactions.userId, messageReactions.emoji],
        });
      return reactionsFor(input.messageId);
    },

    async removeReaction(input: ReactionInput): Promise<Reaction[]> {
      // Idempotent: deleting zero rows is success, not an error.
      await db
        .delete(messageReactions)
        .where(
          and(
            eq(messageReactions.messageId, input.messageId),
            eq(messageReactions.userId, input.userId),
            eq(messageReactions.emoji, input.emoji),
          ),
        );
      return reactionsFor(input.messageId);
    },

    async listReactionsByMessageIds(messageIds: string[]): Promise<Reaction[]> {
      if (messageIds.length === 0) return [];
      const rows = await db
        .select()
        .from(messageReactions)
        .where(or(...messageIds.map((id) => eq(messageReactions.messageId, id))))
        // Earliest-first, which is the order core aggregates `userIds` in.
        .orderBy(asc(messageReactions.createdAt));
      return rows.map(toReaction);
    },

    async setMessageMentions(input: SetMessageMentionsInput): Promise<void> {
      await db.transaction((tx) => {
        if (input.userIds.length > 0) {
          const now = new Date();
          tx.insert(messageMentions)
            .values(
              input.userIds.map((userId) => ({
                messageId: input.messageId,
                userId,
                createdAt: now,
              })),
            )
            .onConflictDoNothing({
              target: [messageMentions.messageId, messageMentions.userId],
            })
            .run();
        }
        tx.delete(messageMentions)
          .where(
            and(
              eq(messageMentions.messageId, input.messageId),
              input.userIds.length === 0
                ? undefined
                : notInArray(messageMentions.userId, input.userIds),
            ),
          )
          .run();
      });
    },

    async listMentionsByMessageIds(messageIds: string[]): Promise<MessageMention[]> {
      if (messageIds.length === 0) return [];
      const rows = await db
        .select()
        .from(messageMentions)
        .where(or(...messageIds.map((id) => eq(messageMentions.messageId, id))))
        .orderBy(asc(messageMentions.createdAt), asc(messageMentions.userId));
      return rows.map(toMention);
    },

    /**
     * The public channel directory (`docs/decisions/0020`) - the other optional
     * capability. Its presence is also core's signal that this adapter persists
     * `visibility` and `join_policy`, which it does.
     */
    channels: {
      async listPublicConversations(
        input: ListPublicConversationsInput,
      ): Promise<ListPublicConversationsResult> {
        // Groups only, and public only - the `visibility` predicate matches the
        // partial index the migration creates, so this stays a keyset scan over
        // channels rather than over every conversation in the database. Core
        // already refuses to make a DM public; the `type` filter is here so a
        // hand-edited row cannot leak one either.
        return pageConversationsByActivity(
          and(eq(conversations.visibility, "public"), eq(conversations.type, "group"))!,
          input.limit,
          input.cursor,
        );
      },
    },

    /**
     * Invite links and join requests (`docs/decisions/0019`) - the optional
     * capability, implemented in full.
     */
    invites: {
      async createInvite(input: CreateInviteInput): Promise<ConversationInvite> {
        // The code is supplied by core, which owns entropy (ADR 0019 §3).
        const [row] = await db
          .insert(conversationInvites)
          .values({
            code: input.code,
            conversationId: input.conversationId,
            createdBy: input.createdBy,
            createdAt: new Date(),
            expiresAt: input.expiresAt,
            maxUses: input.maxUses,
            uses: 0,
            requiresApproval: input.requiresApproval,
            metadata: input.metadata,
          })
          .returning();
        if (!row) {
          throw new Error("sqliteAdapter: failed to create invite.");
        }
        return toInvite(row);
      },

      async getInvite(code: string): Promise<ConversationInvite | null> {
        const [row] = await db
          .select()
          .from(conversationInvites)
          .where(eq(conversationInvites.code, code))
          .limit(1);
        // Expired and exhausted invites come back as-is: core needs to tell
        // "no such code" (404) from "no longer usable" (410).
        return row ? toInvite(row) : null;
      },

      async listInvites(conversationId: string): Promise<ConversationInvite[]> {
        const rows = await db
          .select()
          .from(conversationInvites)
          .where(eq(conversationInvites.conversationId, conversationId))
          .orderBy(desc(conversationInvites.createdAt), desc(conversationInvites.code));
        return rows.map(toInvite);
      },

      async deleteInvite(input: DeleteInviteInput): Promise<void> {
        // Scoped by conversation so an admin of one group cannot revoke
        // another's by guessing a code. Deleting zero rows is success.
        await db
          .delete(conversationInvites)
          .where(
            and(
              eq(conversationInvites.code, input.code),
              eq(conversationInvites.conversationId, input.conversationId),
            ),
          );
      },

      async consumeInvite(code: string): Promise<ConversationInvite | null> {
        const now = new Date();
        // ONE conditional UPDATE ... RETURNING, never read-then-write: this is
        // the only thing standing between two simultaneous redemptions of a
        // `maxUses: 1` invite and both of them succeeding (ADR 0019 §2).
        // SQLite evaluates the WHERE and applies the increment under a single
        // row lock, so the loser matches zero rows and gets `null`.
        const [row] = await db
          .update(conversationInvites)
          .set({ uses: sql`${conversationInvites.uses} + 1` })
          .where(
            and(
              eq(conversationInvites.code, code),
              or(
                isNull(conversationInvites.maxUses),
                lt(conversationInvites.uses, conversationInvites.maxUses),
              ),
              or(isNull(conversationInvites.expiresAt), gt(conversationInvites.expiresAt, now)),
            ),
          )
          .returning();
        return row ? toInvite(row) : null;
      },

      async createJoinRequest(input: CreateJoinRequestInput): Promise<JoinRequest> {
        const [row] = await db
          .insert(joinRequests)
          .values({
            id: generateId("jreq"),
            conversationId: input.conversationId,
            userId: input.userId,
            status: "pending",
            message: input.message,
            inviteCode: input.inviteCode,
            createdAt: new Date(),
            resolvedAt: null,
            resolvedBy: null,
            metadata: input.metadata,
          })
          // One row per (conversation, user): a previously denied user asking
          // again overwrites their old row with a fresh pending one, rather
          // than stacking up in the queue (ADR 0019 §5). The resolution fields
          // are reset explicitly - a leftover `resolvedBy` on a pending row
          // would make it look decided.
          .onConflictDoUpdate({
            target: [joinRequests.conversationId, joinRequests.userId],
            set: {
              status: "pending",
              message: input.message,
              inviteCode: input.inviteCode,
              createdAt: new Date(),
              resolvedAt: null,
              resolvedBy: null,
              metadata: input.metadata,
            },
          })
          .returning();
        if (!row) {
          throw new Error("sqliteAdapter: failed to create join request.");
        }
        return toJoinRequest(row);
      },

      async getJoinRequest(input: GetJoinRequestInput): Promise<JoinRequest | null> {
        const [row] = await db
          .select()
          .from(joinRequests)
          .where(
            and(
              eq(joinRequests.conversationId, input.conversationId),
              eq(joinRequests.userId, input.userId),
            ),
          )
          .limit(1);
        return row ? toJoinRequest(row) : null;
      },

      async listJoinRequests(input: ListJoinRequestsInput): Promise<JoinRequest[]> {
        const rows = await db
          .select()
          .from(joinRequests)
          .where(
            input.status === undefined
              ? eq(joinRequests.conversationId, input.conversationId)
              : and(
                  eq(joinRequests.conversationId, input.conversationId),
                  eq(joinRequests.status, input.status),
                ),
          )
          // Newest-first, with the id breaking ties so the order is stable
          // across reads (SQLite guarantees none without a full ORDER BY).
          .orderBy(desc(joinRequests.createdAt), desc(joinRequests.id))
          .limit(input.limit);
        return rows.map(toJoinRequest);
      },

      async resolveJoinRequest(input: ResolveJoinRequestInput): Promise<JoinRequest> {
        const [row] = await db
          .update(joinRequests)
          .set({
            status: input.status,
            resolvedAt: input.resolvedAt,
            resolvedBy: input.resolvedBy,
          })
          .where(
            and(
              eq(joinRequests.conversationId, input.conversationId),
              eq(joinRequests.userId, input.userId),
            ),
          )
          .returning();
        if (!row) {
          throw new Error(
            `sqliteAdapter: no join request from user "${input.userId}" in "${input.conversationId}".`,
          );
        }
        return toJoinRequest(row);
      },
    },
  };
}
