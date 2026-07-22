/**
 * `@chatpack/adapter-drizzle` — Drizzle ORM (Postgres) {@link StorageAdapter}
 * for Chatpack. Real persistence for production (M4).
 *
 * Works with any Drizzle Postgres driver — node-postgres, postgres.js, PGlite,
 * Neon, Vercel Postgres — because it only uses the dialect-agnostic Drizzle
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
 *   `UPDATE ... SET last_seq = last_seq + 1 RETURNING` — Postgres row
 *   locking makes concurrent sends serialize correctly with no gaps-by-race
 *   and no duplicates (ADR 0003, ADR 0007).
 * - **Idempotent find-or-create:** conversation creation uses
 *   `ON CONFLICT (pair_key) DO NOTHING` + re-select, so concurrent calls for
 *   the same user pair converge on one conversation (ADR 0002).
 *
 * @module
 */

import { and, asc, desc, eq, gt, lt, or, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

import type {
  AddMessageInput,
  Conversation,
  GetOrCreateDirectConversationInput,
  GetOrCreateDirectConversationResult,
  ListConversationsInput,
  ListConversationsResult,
  ListMessagesAfterSeqInput,
  ListMessagesInput,
  ListMessagesResult,
  Message,
  MessageRole,
  Metadata,
  StorageAdapter,
  UpdateLastReadInput,
  UpdateMessageInput,
} from "@chatpack/core";

import { conversationParticipants, conversations, messages } from "./schema";

export {
  chatpackSchema,
  conversationParticipants,
  conversations,
  messages,
  migrationSql,
} from "./schema";

/**
 * Any Drizzle Postgres database instance, regardless of driver
 * (node-postgres, postgres.js, PGlite, Neon, ...).
 */
export type DrizzlePgDatabase = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

type ConversationRow = typeof conversations.$inferSelect;
type ParticipantRow = typeof conversationParticipants.$inferSelect;
type MessageRow = typeof messages.$inferSelect;

function generateId(prefix: string): string {
  // 128 bits of randomness via the Web Crypto API (available in Node 19+,
  // Bun, Deno, Workers) — no extra dependency.
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
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
    metadata: (row.metadata ?? {}) as Metadata,
  };
}

function toConversation(row: ConversationRow, participantRows: ParticipantRow[]): Conversation {
  return {
    id: row.id,
    pairKey: row.pairKey,
    createdAt: row.createdAt,
    metadata: (row.metadata ?? {}) as Metadata,
    participants: participantRows.map((p) => ({
      conversationId: p.conversationId,
      userId: p.userId,
      joinedAt: p.joinedAt,
      lastReadMessageId: p.lastReadMessageId,
    })),
  };
}

/**
 * Create a Drizzle/Postgres storage adapter.
 *
 * The Chatpack tables must exist — generate a migration from the exported
 * schema with `drizzle-kit`, or run the exported {@link migrationSql} once.
 *
 * @param db - Any Drizzle Postgres database instance.
 */
export function drizzleAdapter(db: DrizzlePgDatabase): StorageAdapter {
  /** Load participant rows for a set of conversation ids. */
  async function participantsFor(
    conversationIds: string[],
  ): Promise<Map<string, ParticipantRow[]>> {
    if (conversationIds.length === 0) return new Map();
    const rows = await db
      .select()
      .from(conversationParticipants)
      .where(or(...conversationIds.map((id) => eq(conversationParticipants.conversationId, id))));
    const byConversation = new Map<string, ParticipantRow[]>();
    for (const row of rows) {
      const list = byConversation.get(row.conversationId) ?? [];
      list.push(row);
      byConversation.set(row.conversationId, list);
    }
    return byConversation;
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

  return {
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
          pairKey: input.pairKey,
          createdAt: now,
          metadata: input.metadata,
          lastSeq: 0,
          lastActivityAt: now,
        })
        .onConflictDoNothing({ target: conversations.pairKey })
        .returning({ id: conversations.id });

      const created = inserted.length > 0;
      if (created) {
        await db.insert(conversationParticipants).values(
          input.userIds.map((userId) => ({
            conversationId: id,
            userId,
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

    async getConversation(conversationId: string): Promise<Conversation | null> {
      return loadConversation(conversationId);
    },

    async listConversations(input: ListConversationsInput): Promise<ListConversationsResult> {
      // Most-recently-active first, keyset pagination on
      // (last_activity_at, id) — the cursor encodes both.
      let cursorFilter = undefined;
      if (input.cursor) {
        const separator = input.cursor.indexOf(":");
        const activityMs = Number(input.cursor.slice(0, separator));
        const cursorId = input.cursor.slice(separator + 1);
        if (Number.isFinite(activityMs) && cursorId) {
          const cursorDate = new Date(activityMs);
          cursorFilter = or(
            lt(conversations.lastActivityAt, cursorDate),
            and(eq(conversations.lastActivityAt, cursorDate), lt(conversations.id, cursorId)),
          );
        }
      }

      const membership = db
        .select({ conversationId: conversationParticipants.conversationId })
        .from(conversationParticipants)
        .where(eq(conversationParticipants.userId, input.userId));

      const rows = await db
        .select()
        .from(conversations)
        .where(
          cursorFilter
            ? and(sql`${conversations.id} IN ${membership}`, cursorFilter)
            : sql`${conversations.id} IN ${membership}`,
        )
        .orderBy(desc(conversations.lastActivityAt), desc(conversations.id))
        .limit(input.limit + 1);

      const page = rows.slice(0, input.limit);
      const hasMore = rows.length > input.limit;
      const last = page[page.length - 1];
      const nextCursor = hasMore && last ? `${last.lastActivityAt.getTime()}:${last.id}` : null;

      const participants = await participantsFor(page.map((r) => r.id));
      return {
        conversations: page.map((row) => toConversation(row, participants.get(row.id) ?? [])),
        nextCursor,
      };
    },

    async addMessage(input: AddMessageInput): Promise<Message> {
      const now = new Date();

      // THE critical line of the adapter (ADR 0003/0007): one atomic
      // read-modify-write. Postgres locks the row for the duration of the
      // UPDATE, so concurrent sends serialize and each gets a unique seq.
      const [bumped] = await db
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

      const [row] = await db
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
          metadata: input.metadata,
        })
        .returning();

      if (!row) {
        throw new Error("drizzleAdapter: message insert returned no row.");
      }
      return toMessage(row);
    },

    async getMessage(messageId: string): Promise<Message | null> {
      const [row] = await db.select().from(messages).where(eq(messages.id, messageId)).limit(1);
      return row ? toMessage(row) : null;
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

      const [row] = await db
        .update(messages)
        .set(patch)
        .where(eq(messages.id, input.messageId))
        .returning();

      if (!row) {
        throw new Error(`drizzleAdapter: unknown message "${input.messageId}".`);
      }
      return toMessage(row);
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
  };
}
