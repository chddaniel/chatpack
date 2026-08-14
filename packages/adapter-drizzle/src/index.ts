/**
 * `@chatpack/adapter-drizzle` - Drizzle ORM (Postgres) {@link StorageAdapter}
 * for Chatpack. Real persistence for production (M4).
 *
 * Works with any Drizzle Postgres driver - node-postgres, postgres.js, PGlite,
 * Neon, Vercel Postgres - because it only uses the dialect-agnostic Drizzle
 * query builder.
 *
 * ```ts
 * import { drizzle } from "drizzle-orm/node-postgres";
 * import { chatpack } from "@chatpack/core";
 * import { drizzleAdapter } from "@chatpack/adapter-drizzle";
 *
 * const db = drizzle(process.env.DATABASE_URL!);
 * const chat = chatpack({ storage: drizzleAdapter(db), auth });
 * ```
 *
 * Correctness notes (the parts a chat backend must get right):
 *
 * - **Monotonic `seq` under concurrency:** `addMessage` increments the
 *   conversation's `last_seq` with a single atomic
 *   `UPDATE ... SET last_seq = last_seq + 1 RETURNING` - Postgres row
 *   locking makes concurrent sends serialize correctly with no gaps-by-race
 *   and no duplicates (ADR 0003, ADR 0007).
 * - **Idempotent find-or-create:** DM creation uses
 *   `ON CONFLICT (pair_key) WHERE pair_key IS NOT NULL DO NOTHING` +
 *   re-select, so concurrent calls for the same user pair converge on one
 *   conversation (ADR 0002). Groups take the plain-insert path instead: they
 *   have no pair key and nothing to converge on (ADR 0017).
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
  isNotNull,
  isNull,
  lt,
  ne,
  notInArray,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { alias, type PgDatabase, type PgQueryResultHKT } from "drizzle-orm/pg-core";

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
  JoinRequestStatus,
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
  MessageRole,
  Metadata,
  ModerationPage,
  ModerationStorage,
  ModerationReport,
  ConversationMute,
  UserBan,
  UserBlock,
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
import { countSearchTokens, getSearchTerms } from "@chatpack/core";

import {
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
} from "./schema";

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
 * Any Drizzle Postgres database instance, regardless of driver
 * (node-postgres, postgres.js, PGlite, Neon, ...).
 */
export type DrizzlePgDatabase = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

type ConversationRow = typeof conversations.$inferSelect;
type ParticipantRow = typeof conversationParticipants.$inferSelect;
type MessageRow = typeof messages.$inferSelect;
type ReactionRow = typeof messageReactions.$inferSelect;
type MentionRow = typeof messageMentions.$inferSelect;
type InviteRow = typeof conversationInvites.$inferSelect;
type JoinRequestRow = typeof joinRequests.$inferSelect;
type BlockRow = typeof userBlocks.$inferSelect;
type MuteRow = typeof conversationMutes.$inferSelect;
type ReportRow = typeof moderationReports.$inferSelect;
type BanRow = typeof userBans.$inferSelect;

interface SearchTokenRow {
  messageId: string;
  token: string;
  occurrences: number;
}

const SEARCH_TOKEN_BATCH_SIZE = 1000;

function searchTokenRows(messageId: string, body: string): SearchTokenRow[] {
  return [...countSearchTokens(body)].map(([token, occurrences]) => ({
    messageId,
    token,
    occurrences,
  }));
}

async function insertSearchTokenRows(
  rows: SearchTokenRow[],
  insert: (batch: SearchTokenRow[]) => Promise<void>,
): Promise<void> {
  for (let offset = 0; offset < rows.length; offset += SEARCH_TOKEN_BATCH_SIZE) {
    await insert(rows.slice(offset, offset + SEARCH_TOKEN_BATCH_SIZE));
  }
}

/**
 * Rebuild the canonical token table after applying the exported migration to
 * a database that already contains messages. New messages and edits maintain
 * their rows automatically through {@link drizzleAdapter}.
 */
export async function backfillMessageSearchTokens(db: DrizzlePgDatabase): Promise<void> {
  const rows = await db
    .select({ id: messages.id, body: messages.body, deletedAt: messages.deletedAt })
    .from(messages);
  const tokens = rows.flatMap((row) => (row.deletedAt ? [] : searchTokenRows(row.id, row.body)));

  await db.delete(messageSearchTokens);
  await insertSearchTokenRows(tokens, async (batch) => {
    await db.insert(messageSearchTokens).values(batch);
  });
}

function generateId(prefix: string): string {
  // 128 bits of randomness via the Web Crypto API (available in Node 19+,
  // Bun, Deno, Workers) - no extra dependency.
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

function encodeSearchCursor(rank: number, createdAt: Date, id: string): string {
  return encodeURIComponent(JSON.stringify([rank, createdAt.getTime(), id]));
}

function decodeSearchCursor(cursor: string): [number, number, string] | null {
  try {
    const value: unknown = JSON.parse(decodeURIComponent(cursor));
    if (
      Array.isArray(value) &&
      typeof value[0] === "number" &&
      typeof value[1] === "number" &&
      typeof value[2] === "string"
    ) {
      return [value[0], value[1], value[2]];
    }
  } catch {
    // Invalid cursors restart from the first result, matching other adapter cursors.
  }
  return null;
}

function toMessage(row: MessageRow): Message {
  return {
    id: row.id,
    conversationId: row.conversationId,
    senderId: row.senderId,
    body: row.body,
    role: row.role as MessageRole,
    seq: row.seq,
    createdAt: row.createdAt,
    editedAt: row.editedAt,
    deletedAt: row.deletedAt,
    replyToMessageId: row.replyToMessageId,
    forwardedFromMessageId: row.forwardedFromMessageId,
    forwardedFromConversationId: row.forwardedFromConversationId,
    forwardedFromSenderId: row.forwardedFromSenderId,
    metadata: (row.metadata ?? {}) as Metadata,
  };
}

function toReaction(row: ReactionRow): Reaction {
  return {
    messageId: row.messageId,
    userId: row.userId,
    emoji: row.emoji,
    createdAt: row.createdAt,
  };
}

function toMention(row: MentionRow): MessageMention {
  return {
    messageId: row.messageId,
    userId: row.userId,
    createdAt: row.createdAt,
  };
}

function toInvite(row: InviteRow): ConversationInvite {
  return {
    code: row.code,
    conversationId: row.conversationId,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    maxUses: row.maxUses,
    uses: row.uses,
    requiresApproval: row.requiresApproval,
    metadata: (row.metadata ?? {}) as Metadata,
  };
}

function toJoinRequest(row: JoinRequestRow): JoinRequest {
  return {
    id: row.id,
    conversationId: row.conversationId,
    userId: row.userId,
    // Plain text column, so an unrecognized value coerces to the safe default
    // rather than widening the domain type - same rule as `type`/`role`.
    status:
      row.status === "approved" || row.status === "denied"
        ? (row.status as JoinRequestStatus)
        : "pending",
    message: row.message,
    inviteCode: row.inviteCode,
    createdAt: row.createdAt,
    resolvedAt: row.resolvedAt,
    resolvedBy: row.resolvedBy,
    metadata: (row.metadata ?? {}) as Metadata,
  };
}

function toBlock(row: BlockRow): UserBlock {
  return {
    blockerUserId: row.blockerUserId,
    blockedUserId: row.blockedUserId,
    createdAt: row.createdAt,
  };
}

function toMute(row: MuteRow): ConversationMute {
  return { userId: row.userId, conversationId: row.conversationId, createdAt: row.createdAt };
}

function toReport(row: ReportRow): ModerationReport {
  return {
    id: row.id,
    reporterUserId: row.reporterUserId,
    targetType: row.targetType as ModerationReport["targetType"],
    targetId: row.targetId,
    reason: row.reason,
    status: row.status as ModerationReport["status"],
    moderatorNote: row.moderatorNote,
    evidence: row.evidence as ModerationReport["evidence"],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toBan(row: BanRow): UserBan {
  return {
    id: row.id,
    userId: row.userId,
    createdByUserId: row.createdByUserId,
    reason: row.reason,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt,
    revokedByUserId: row.revokedByUserId,
  };
}

function toConversation(row: ConversationRow, participantRows: ParticipantRow[]): Conversation {
  return {
    id: row.id,
    // `type` and `role` are plain text columns, so a row written by an older
    // version (or by hand) is coerced to the safe default rather than widening
    // the domain type (ADR 0017).
    type: row.type === "group" ? "group" : "direct",
    pairKey: row.pairKey,
    name: row.name,
    // Same coercion, same reason (ADR 0020): both default to the closed value,
    // so an unrecognized string reads as unlisted rather than as public.
    visibility: row.visibility === "public" ? "public" : "private",
    joinPolicy: row.joinPolicy === "open" ? "open" : "approval",
    createdAt: row.createdAt,
    metadata: (row.metadata ?? {}) as Metadata,
    participants: participantRows.map((p) => ({
      conversationId: p.conversationId,
      userId: p.userId,
      role: p.role === "admin" ? "admin" : "member",
      joinedAt: p.joinedAt,
      lastReadMessageId: p.lastReadMessageId,
    })),
  };
}

/**
 * Create a Drizzle/Postgres storage adapter.
 *
 * The Chatpack tables must exist - generate a migration from the exported
 * schema with `drizzle-kit`, or run the exported {@link migrationSql} once.
 *
 * @param db - Any Drizzle Postgres database instance.
 */
export function drizzleAdapter(db: DrizzlePgDatabase): StorageAdapter {
  /**
   * Load participant rows for a set of conversation ids.
   *
   * Ordered by `joined_at` (then `user_id` to break ties, since a group's seed
   * members all share one timestamp): the creator therefore comes first, and
   * more importantly the order is **stable across reads**. Postgres gives no
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
      throw new Error(`drizzleAdapter: unknown conversation "${conversationId}".`);
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
  const moderation: ModerationStorage = {
    async isUserBanned(userId, now = new Date()) {
      return this.getActiveBan(userId, now);
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
      if (!row) throw new Error("drizzleAdapter: block insert returned no row.");
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
      if (!row) throw new Error("drizzleAdapter: mute insert returned no row.");
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
      if (!row) throw new Error("drizzleAdapter: report insert returned no row.");
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
      if (!row) throw new Error(`drizzleAdapter: unknown report "${input.reportId}".`);
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
      await db.execute(sql`
        insert into "chatpack_user_bans"
          ("id", "user_id", "created_by_user_id", "reason", "created_at",
           "expires_at", "revoked_at", "revoked_by_user_id")
        select ${id}::text, ${input.userId}::text, ${input.createdByUserId}::text,
               ${input.reason}::text, ${now}::timestamptz, ${input.expiresAt}::timestamptz,
               null::timestamptz, null::text
        where not exists (
          select 1 from "chatpack_user_bans"
          where "user_id" = ${input.userId}::text
            and "revoked_at" is null
            and ("expires_at" is null or "expires_at" > ${now}::timestamptz)
        )`);

      const active = await this.getActiveBan(input.userId, now);
      if (!active) throw new Error("drizzleAdapter: ban insert returned no row.");
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
        if (!existing[0]) throw new Error(`drizzleAdapter: unknown ban "${input.banId}".`);
        return toBan(existing[0]);
      }
      return toBan(row);
    },
  };

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
        // The `where` predicate is required, not decorative: since ADR 0017 the
        // pair_key unique index is **partial** (`WHERE pair_key IS NOT NULL`),
        // and Postgres only matches an ON CONFLICT target to a partial index
        // when the predicate is repeated here. Without it every DM insert fails
        // with "no unique or exclusion constraint matching the ON CONFLICT
        // specification".
        .onConflictDoNothing({
          target: conversations.pairKey,
          where: isNotNull(conversations.pairKey),
        })
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
          `drizzleAdapter: conversation for pairKey "${input.pairKey}" vanished after insert.`,
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
      await db.transaction(async (tx) => {
        await tx.insert(conversations).values({
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
        });
        await tx.insert(conversationParticipants).values([
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
        ]);
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
      // read-modify-write. Postgres locks the row for the duration of the
      // UPDATE, so concurrent sends serialize and each gets a unique seq.
      return db.transaction(async (tx) => {
        const [bumped] = await tx
          .update(conversations)
          .set({
            lastSeq: sql`${conversations.lastSeq} + 1`,
            lastActivityAt: now,
          })
          .where(eq(conversations.id, input.conversationId))
          .returning({ seq: conversations.lastSeq });

        if (!bumped) {
          throw new Error(`drizzleAdapter: unknown conversation "${input.conversationId}".`);
        }

        const [row] = await tx
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
            // Frozen at write time, never re-resolved (ADR 0024 §2).
            forwardedFromMessageId: input.forwardedFromMessageId,
            forwardedFromConversationId: input.forwardedFromConversationId,
            forwardedFromSenderId: input.forwardedFromSenderId,
            metadata: input.metadata,
          })
          .returning();

        if (!row) {
          throw new Error("drizzleAdapter: message insert returned no row.");
        }
        await insertSearchTokenRows(searchTokenRows(row.id, row.body), async (batch) => {
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
          // Cast away from Postgres int8 so node-postgres and PGlite both
          // return the numeric rank expected by the opaque cursor.
          rank: sql<number>`sum(${messageSearchTokens.occurrences})::integer`.as("rank"),
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

      return db.transaction(async (tx) => {
        const [row] = await tx
          .update(messages)
          .set(patch)
          .where(eq(messages.id, input.messageId))
          .returning();

        if (!row) {
          throw new Error(`drizzleAdapter: unknown message "${input.messageId}".`);
        }
        if (input.body !== undefined || input.deletedAt !== undefined) {
          await tx.delete(messageSearchTokens).where(eq(messageSearchTokens.messageId, row.id));
          if (!row.deletedAt) {
            await insertSearchTokenRows(searchTokenRows(row.id, row.body), async (batch) => {
              await tx.insert(messageSearchTokens).values(batch);
            });
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
          `drizzleAdapter: user "${input.userId}" is not a participant of "${input.conversationId}".`,
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
      // Upsert plus a delete of the complement, in one transaction: the pair is
      // what makes this a *replace* rather than an accumulate, and neither half
      // may be visible without the other. Surviving rows keep their original
      // `createdAt` because the conflict path does nothing (ADR 0023 §3).
      await db.transaction(async (tx) => {
        if (input.userIds.length > 0) {
          const now = new Date();
          await tx
            .insert(messageMentions)
            .values(
              input.userIds.map((userId) => ({
                messageId: input.messageId,
                userId,
                createdAt: now,
              })),
            )
            .onConflictDoNothing({
              target: [messageMentions.messageId, messageMentions.userId],
            });
        }
        await tx.delete(messageMentions).where(
          and(
            eq(messageMentions.messageId, input.messageId),
            // An empty set means "delete them all", so the complement is
            // everything - `notInArray` with no values is not valid SQL.
            input.userIds.length === 0
              ? undefined
              : notInArray(messageMentions.userId, input.userIds),
          ),
        );
      });
    },

    async listMentionsByMessageIds(messageIds: string[]): Promise<MessageMention[]> {
      if (messageIds.length === 0) return [];
      const rows = await db
        .select()
        .from(messageMentions)
        .where(or(...messageIds.map((id) => eq(messageMentions.messageId, id))))
        // The contract's canonical order: `userId` breaks the tie between rows
        // written in one call, which all share a timestamp.
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
          throw new Error("drizzleAdapter: failed to create invite.");
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
        // Postgres evaluates the WHERE and applies the increment under a single
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
          throw new Error("drizzleAdapter: failed to create join request.");
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
          // across reads (Postgres guarantees none without a full ORDER BY).
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
            `drizzleAdapter: no join request from user "${input.userId}" in "${input.conversationId}".`,
          );
        }
        return toJoinRequest(row);
      },
    },
  };
}
