/**
 * `@chatpack/adapter-memory` - in-memory {@link StorageAdapter} for Chatpack.
 *
 * Zero-setup storage backed by JavaScript Maps. Perfect for demos, examples,
 * and fast deterministic tests. **Data is lost when the process exits** - use
 * a database adapter (e.g. `@chatpack/adapter-drizzle`) in production.
 *
 * This is also the reference implementation of the `StorageAdapter` contract:
 * if you are writing your own adapter, start by reading this file.
 *
 * @module
 */

import type {
  AddMessageInput,
  AddParticipantsInput,
  ChannelJoinPolicy,
  ChannelVisibility,
  Conversation,
  ConversationInvite,
  ConversationType,
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
  ModerationPage,
  ModerationStorage,
  ModerationReport,
  ConversationMute,
  UserBan,
  UserBlock,
  Participant,
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
import { countSearchTokens, getSearchTerms, scoreSearchTerms } from "@chatpack/core";

interface ConversationRecord {
  id: string;
  type: ConversationType;
  /** `null` for groups - only DMs have a uniqueness key (`docs/decisions/0017`). */
  pairKey: string | null;
  name: string | null;
  /** Whether the conversation is listed in the public directory (ADR 0020). */
  visibility: ChannelVisibility;
  /** How strangers get into a public channel (ADR 0020). Inert while private. */
  joinPolicy: ChannelJoinPolicy;
  createdAt: Date;
  metadata: Record<string, unknown>;
  participants: Map<string, Participant>;
  /** Monotonic per-conversation message sequence (MVP §8). */
  nextSeq: number;
  /** Global activity tick of the latest message; used for most-recently-active ordering. */
  lastActivityTick: number;
}

interface SearchCandidate {
  message: Message;
  score: number;
}

function searchCandidate(message: Message, terms: string[]): SearchCandidate | null {
  if (message.deletedAt) return null;
  const score = scoreSearchTerms(countSearchTokens(message.body), terms);
  if (score === null) return null;
  return {
    message,
    score,
  };
}

function compareSearchCandidates(a: SearchCandidate, b: SearchCandidate): number {
  return (
    b.score - a.score ||
    b.message.createdAt.getTime() - a.message.createdAt.getTime() ||
    (a.message.id < b.message.id ? 1 : a.message.id === b.message.id ? 0 : -1)
  );
}

function encodeSearchCursor(candidate: SearchCandidate): string {
  return encodeURIComponent(
    JSON.stringify([candidate.score, candidate.message.createdAt.getTime(), candidate.message.id]),
  );
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

/**
 * Create an in-memory storage adapter.
 *
 * @example
 * ```ts
 * import { chatpack } from "@chatpack/core";
 * import { memoryAdapter } from "@chatpack/adapter-memory";
 *
 * const chat = chatpack({ storage: memoryAdapter() });
 * ```
 */
export function memoryAdapter(): StorageAdapter {
  const conversations = new Map<string, ConversationRecord>();
  const conversationsByPairKey = new Map<string, string>();
  const messages = new Map<string, Message>();
  /** Message ids per conversation in insertion (ascending seq) order. */
  const messageIdsByConversation = new Map<string, string[]>();
  /**
   * Reactions per message, in insertion (earliest-first) order - the order core
   * aggregates into `ReactionSummary.userIds` (ADR 0013).
   */
  const reactionsByMessage = new Map<string, Reaction[]>();
  /**
   * Mentions per message, in insertion order - the order core assembles into
   * `MessageWithDetails.mentions` (ADR 0023 §4).
   */
  const mentionsByMessage = new Map<string, MessageMention[]>();
  /** Invites by code - the code is both the identity and the secret (ADR 0019). */
  const invitesByCode = new Map<string, ConversationInvite>();
  /**
   * Join requests keyed by conversation + user: at most one row per user per
   * conversation (ADR 0019 §5). NUL separator, since ids are opaque strings and
   * a printable one could be crafted to collide with a different pair.
   */
  const joinRequestsByKey = new Map<string, JoinRequest>();
  const joinRequestKey = (conversationId: string, userId: string): string =>
    `${conversationId}\u0000${userId}`;
  const blocks = new Map<string, UserBlock>();
  const mutes = new Map<string, ConversationMute>();
  const reports = new Map<string, ModerationReport>();
  const bans = new Map<string, UserBan>();

  let idCounter = 0;
  const nextId = (prefix: string): string => `${prefix}_${(++idCounter).toString(36)}`;
  /** Global tick so "most recently active" is comparable across conversations. */
  let activityTick = 0;

  const blockKey = (blockerUserId: string, blockedUserId: string): string =>
    `${blockerUserId}\u0000${blockedUserId}`;
  const muteKey = (userId: string, conversationId: string): string =>
    `${userId}\u0000${conversationId}`;

  /**
   * The user's newest unrevoked, unexpired ban, or `undefined`. Synchronous on
   * purpose: `createBan` has to look and insert without an `await` in between.
   */
  const findActiveBan = (userId: string, now: Date): UserBan | undefined =>
    [...bans.values()]
      .filter((ban) => ban.userId === userId && ban.revokedAt === null)
      .filter((ban) => ban.expiresAt === null || ban.expiresAt.getTime() > now.getTime())
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];

  const moderation: ModerationStorage = {
    async isUserBanned(userId, now = new Date()) {
      return this.getActiveBan(userId, now);
    },

    async isBlocked(userIdA, userIdB) {
      return blocks.has(blockKey(userIdA, userIdB)) || blocks.has(blockKey(userIdB, userIdA));
    },

    async createBlock(input) {
      const key = blockKey(input.blockerUserId, input.blockedUserId);
      const existing = blocks.get(key);
      if (existing) return { ...existing };
      const block: UserBlock = {
        blockerUserId: input.blockerUserId,
        blockedUserId: input.blockedUserId,
        createdAt: new Date(),
      };
      blocks.set(key, block);
      return { ...block };
    },

    async removeBlock(input) {
      blocks.delete(blockKey(input.blockerUserId, input.blockedUserId));
    },

    async listBlocks(input): Promise<ModerationPage<UserBlock>> {
      const items = [...blocks.values()]
        .filter((block) => block.blockerUserId === input.blockerUserId)
        .sort(
          (a, b) =>
            b.createdAt.getTime() - a.createdAt.getTime() ||
            blockKey(a.blockerUserId, a.blockedUserId).localeCompare(
              blockKey(b.blockerUserId, b.blockedUserId),
            ),
        );
      const start = input.cursor
        ? Math.max(
            0,
            items.findIndex(
              (item) => blockKey(item.blockerUserId, item.blockedUserId) === input.cursor,
            ) + 1,
          )
        : 0;
      const page = items.slice(start, start + input.limit);
      const last = page[page.length - 1];
      return {
        items: page.map((item) => ({ ...item })),
        nextCursor:
          last && start + input.limit < items.length
            ? blockKey(last.blockerUserId, last.blockedUserId)
            : null,
      };
    },

    async createMute(input) {
      const key = muteKey(input.userId, input.conversationId);
      const existing = mutes.get(key);
      if (existing) return { ...existing };
      const mute: ConversationMute = {
        userId: input.userId,
        conversationId: input.conversationId,
        createdAt: new Date(),
      };
      mutes.set(key, mute);
      return { ...mute };
    },

    async removeMute(input) {
      mutes.delete(muteKey(input.userId, input.conversationId));
    },

    async listMutes(input): Promise<ModerationPage<ConversationMute>> {
      const items = [...mutes.values()]
        .filter((mute) => mute.userId === input.userId)
        .sort(
          (a, b) =>
            b.createdAt.getTime() - a.createdAt.getTime() ||
            a.conversationId.localeCompare(b.conversationId),
        );
      const start = input.cursor
        ? Math.max(0, items.findIndex((item) => item.conversationId === input.cursor) + 1)
        : 0;
      const page = items.slice(start, start + input.limit);
      const last = page[page.length - 1];
      return {
        items: page.map((item) => ({ ...item })),
        nextCursor: last && start + input.limit < items.length ? last.conversationId : null,
      };
    },

    async findOpenReport(reporterUserId, targetType, targetId) {
      for (const report of reports.values()) {
        if (
          report.reporterUserId === reporterUserId &&
          report.targetType === targetType &&
          report.targetId === targetId &&
          (report.status === "open" || report.status === "triaged")
        ) {
          return { ...report };
        }
      }
      return null;
    },

    async createReport(input) {
      const now = new Date();
      const report: ModerationReport = {
        id: nextId("report"),
        reporterUserId: input.reporterUserId,
        targetType: input.targetType,
        targetId: input.targetId,
        reason: input.reason,
        status: "open",
        moderatorNote: null,
        evidence: input.evidence,
        createdAt: now,
        updatedAt: now,
      };
      reports.set(report.id, report);
      return { ...report };
    },

    async getReport(reportId) {
      const report = reports.get(reportId);
      return report ? { ...report } : null;
    },

    async listReports(input): Promise<ModerationPage<ModerationReport>> {
      const items = [...reports.values()]
        .filter((report) => input.status === undefined || report.status === input.status)
        .filter(
          (report) => input.targetType === undefined || report.targetType === input.targetType,
        )
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id));
      const start = input.cursor
        ? Math.max(0, items.findIndex((item) => item.id === input.cursor) + 1)
        : 0;
      const page = items.slice(start, start + input.limit);
      const last = page[page.length - 1];
      return {
        items: page.map((item) => ({ ...item })),
        nextCursor: last && start + input.limit < items.length ? last.id : null,
      };
    },

    async updateReport(input) {
      const report = reports.get(input.reportId);
      if (!report) throw new Error(`memoryAdapter: unknown report "${input.reportId}".`);
      report.status = input.status;
      report.moderatorNote = input.moderatorNote;
      report.updatedAt = new Date();
      return { ...report };
    },

    async getActiveBan(userId, now = new Date()) {
      const active = findActiveBan(userId, now);
      return active ? { ...active } : null;
    },

    async getBan(banId) {
      const ban = bans.get(banId);
      return ban ? { ...ban } : null;
    },

    async createBan(input) {
      // Look and insert in the same tick - no `await` in between (ADR 0019 §5).
      // Two concurrent bans for the same user would otherwise both see "none
      // active" across the await and mint a row each, leaving one of them alive
      // after a moderator revokes the other.
      const existing = findActiveBan(input.userId, new Date());
      if (existing) return { ...existing };
      const ban: UserBan = {
        id: nextId("ban"),
        userId: input.userId,
        createdByUserId: input.createdByUserId,
        reason: input.reason,
        createdAt: new Date(),
        expiresAt: input.expiresAt,
        revokedAt: null,
        revokedByUserId: null,
      };
      bans.set(ban.id, ban);
      return { ...ban };
    },

    async listBans(input): Promise<ModerationPage<UserBan>> {
      const now = new Date();
      const items = [...bans.values()]
        .filter(
          (ban) =>
            !input.activeOnly ||
            (ban.revokedAt === null &&
              (ban.expiresAt === null || ban.expiresAt.getTime() > now.getTime())),
        )
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id));
      const start = input.cursor
        ? Math.max(0, items.findIndex((item) => item.id === input.cursor) + 1)
        : 0;
      const page = items.slice(start, start + input.limit);
      const last = page[page.length - 1];
      return {
        items: page.map((item) => ({ ...item })),
        nextCursor: last && start + input.limit < items.length ? last.id : null,
      };
    },

    async revokeBan(input) {
      const ban = bans.get(input.banId);
      if (!ban) throw new Error(`memoryAdapter: unknown ban "${input.banId}".`);
      if (ban.revokedAt === null) {
        ban.revokedAt = new Date();
        ban.revokedByUserId = input.revokedByUserId;
      }
      return { ...ban };
    },
  };

  function toConversation(record: ConversationRecord): Conversation {
    return {
      id: record.id,
      type: record.type,
      pairKey: record.pairKey,
      name: record.name,
      visibility: record.visibility,
      joinPolicy: record.joinPolicy,
      createdAt: record.createdAt,
      metadata: { ...record.metadata },
      participants: [...record.participants.values()].map((p) => ({ ...p })),
    };
  }

  /**
   * Page a set of conversations most-recently-active first: latest message tick
   * wins, then creation time, then id for a stable total order.
   *
   * Shared by `listConversations` and the ADR 0020 channel directory - the two
   * differ only in which rows they select, and a directory that ordered
   * differently would be a second thing for clients to learn.
   */
  function pageByActivity(
    records: ConversationRecord[],
    limit: number,
    cursor: string | undefined,
  ): ListConversationsResult {
    const sorted = records.sort(
      (a, b) =>
        b.lastActivityTick - a.lastActivityTick ||
        b.createdAt.getTime() - a.createdAt.getTime() ||
        (a.id < b.id ? 1 : -1),
    );

    const start = cursor ? sorted.findIndex((c) => c.id === cursor) + 1 : 0;
    const page = sorted.slice(start, start + limit);
    const last = page[page.length - 1];
    const nextCursor = last && start + limit < sorted.length ? last.id : null;

    return { conversations: page.map(toConversation), nextCursor };
  }

  /** Read a conversation for mutation, or throw the adapter's "unknown" error. */
  function requireRecord(conversationId: string): ConversationRecord {
    const record = conversations.get(conversationId);
    if (!record) {
      throw new Error(`memoryAdapter: unknown conversation "${conversationId}".`);
    }
    return record;
  }

  return {
    moderation,
    async getOrCreateDirectConversation(
      input: GetOrCreateDirectConversationInput,
    ): Promise<GetOrCreateDirectConversationResult> {
      const existingId = conversationsByPairKey.get(input.pairKey);
      if (existingId) {
        const existing = conversations.get(existingId);
        if (existing) return { conversation: toConversation(existing), created: false };
      }

      const now = new Date();
      const id = nextId("conv");
      const record: ConversationRecord = {
        id,
        type: "direct",
        pairKey: input.pairKey,
        // A DM's title is always derived from the other participant by the UI,
        // never stored (`docs/decisions/0017`).
        name: null,
        // A DM is never discoverable and never joinable. Core refuses to change
        // either field on one, so these stay pinned for the row's whole life.
        visibility: "private",
        joinPolicy: "approval",
        createdAt: now,
        metadata: { ...input.metadata },
        participants: new Map(
          input.userIds.map((userId) => [
            userId,
            {
              conversationId: id,
              userId,
              // Both DM participants are admins: there is nothing to administer,
              // and it keeps `role` non-null everywhere (`docs/decisions/0017`).
              role: "admin",
              joinedAt: now,
              lastReadMessageId: null,
            },
          ]),
        ),
        nextSeq: 1,
        lastActivityTick: 0,
      };

      conversations.set(id, record);
      conversationsByPairKey.set(input.pairKey, id);
      messageIdsByConversation.set(id, []);
      return { conversation: toConversation(record), created: true };
    },

    async createGroupConversation(input: CreateGroupConversationInput): Promise<Conversation> {
      const now = new Date();
      const id = nextId("conv");
      const participants = new Map<string, Participant>();
      // Creator first, so a group always has at least one admin.
      participants.set(input.creatorId, {
        conversationId: id,
        userId: input.creatorId,
        role: "admin",
        joinedAt: now,
        lastReadMessageId: null,
      });
      for (const userId of input.userIds) {
        participants.set(userId, {
          conversationId: id,
          userId,
          role: "member",
          joinedAt: now,
          lastReadMessageId: null,
        });
      }

      const record: ConversationRecord = {
        id,
        type: "group",
        // No pair key, so groups never collide with DM find-or-create and two
        // groups with identical membership stay distinct (`docs/decisions/0017`).
        pairKey: null,
        name: input.name,
        // Always resolved by core, never undefined (ADR 0020 §4).
        visibility: input.visibility,
        joinPolicy: input.joinPolicy,
        createdAt: now,
        metadata: { ...input.metadata },
        participants,
        nextSeq: 1,
        lastActivityTick: 0,
      };

      conversations.set(id, record);
      messageIdsByConversation.set(id, []);
      return toConversation(record);
    },

    async addParticipants(input: AddParticipantsInput): Promise<Conversation> {
      const record = requireRecord(input.conversationId);
      const now = new Date();
      for (const userId of input.userIds) {
        // Idempotent: an existing participant keeps their role and joinedAt, so
        // a replayed add never demotes an admin (`docs/decisions/0017`).
        if (record.participants.has(userId)) continue;
        record.participants.set(userId, {
          conversationId: record.id,
          userId,
          role: "member",
          joinedAt: now,
          lastReadMessageId: null,
        });
      }
      return toConversation(record);
    },

    async removeParticipant(input: RemoveParticipantInput): Promise<Conversation> {
      const record = requireRecord(input.conversationId);
      // Idempotent, and messages stay: departure does not rewrite history.
      record.participants.delete(input.userId);
      return toConversation(record);
    },

    async setParticipantRole(input: SetParticipantRoleInput): Promise<Conversation> {
      const record = requireRecord(input.conversationId);
      const participant = record.participants.get(input.userId);
      if (!participant) {
        throw new Error(
          `memoryAdapter: user "${input.userId}" is not a participant of "${input.conversationId}".`,
        );
      }
      participant.role = input.role;
      return toConversation(record);
    },

    async updateConversation(input: UpdateConversationInput): Promise<Conversation> {
      const record = requireRecord(input.conversationId);
      // Every field is the resolved new value, not a patch - core filled in
      // whatever the caller omitted (ADR 0020 §5), so write all three.
      record.name = input.name;
      record.visibility = input.visibility;
      record.joinPolicy = input.joinPolicy;
      return toConversation(record);
    },

    async getConversation(conversationId: string): Promise<Conversation | null> {
      const record = conversations.get(conversationId);
      return record ? toConversation(record) : null;
    },

    async listConversations(input: ListConversationsInput): Promise<ListConversationsResult> {
      return pageByActivity(
        [...conversations.values()].filter((c) => c.participants.has(input.userId)),
        input.limit,
        input.cursor,
      );
    },

    async addMessage(input: AddMessageInput): Promise<Message> {
      const record = requireRecord(input.conversationId);

      const seq = record.nextSeq++;
      record.lastActivityTick = ++activityTick;

      const message: Message = {
        id: nextId("msg"),
        conversationId: input.conversationId,
        senderId: input.senderId,
        body: input.body,
        role: input.role,
        seq,
        createdAt: new Date(),
        editedAt: null,
        deletedAt: null,
        replyToMessageId: input.replyToMessageId,
        // Frozen at write time, never re-resolved (ADR 0024 §2).
        forwardedFromMessageId: input.forwardedFromMessageId,
        forwardedFromConversationId: input.forwardedFromConversationId,
        forwardedFromSenderId: input.forwardedFromSenderId,
        metadata: { ...input.metadata },
      };

      messages.set(message.id, message);
      messageIdsByConversation.get(input.conversationId)?.push(message.id);
      return { ...message };
    },

    async getMessage(messageId: string): Promise<Message | null> {
      const message = messages.get(messageId);
      return message ? { ...message } : null;
    },

    async getMessagesByIds(messageIds: string[]): Promise<Message[]> {
      // Unknown ids are simply absent - never null entries, never a throw.
      return messageIds
        .map((id) => messages.get(id))
        .filter((message): message is Message => message !== undefined)
        .map((message) => ({ ...message }));
    },

    async listMessages(input: ListMessagesInput): Promise<ListMessagesResult> {
      const ids = messageIdsByConversation.get(input.conversationId) ?? [];
      // Stored ascending by seq; newest-first means iterating from the end.
      const newestFirst = [...ids].reverse();

      const start = input.cursor ? newestFirst.indexOf(input.cursor) + 1 : 0;
      const pageIds = newestFirst.slice(start, start + input.limit);
      const last = pageIds[pageIds.length - 1];
      const nextCursor = last && start + input.limit < newestFirst.length ? last : null;

      const page = pageIds
        .map((id) => messages.get(id))
        .filter((m): m is Message => m !== undefined)
        .map((m) => ({ ...m }));

      return { messages: page, nextCursor };
    },

    async searchMessages(input: SearchMessagesInput): Promise<SearchMessagesResult> {
      const terms = getSearchTerms(input.query);
      if (terms.length === 0) return { messages: [], nextCursor: null };

      const candidates: SearchCandidate[] = [];
      for (const message of messages.values()) {
        const conversation = conversations.get(message.conversationId);
        if (!conversation?.participants.has(input.userId)) continue;
        const candidate = searchCandidate(message, terms);
        if (candidate)
          candidates.push({ message: { ...candidate.message }, score: candidate.score });
      }
      candidates.sort(compareSearchCandidates);

      const cursor = input.cursor ? decodeSearchCursor(input.cursor) : null;
      const afterCursor = cursor
        ? candidates.findIndex(
            (candidate) =>
              candidate.score < cursor[0] ||
              (candidate.score === cursor[0] &&
                candidate.message.createdAt.getTime() < cursor[1]) ||
              (candidate.score === cursor[0] &&
                candidate.message.createdAt.getTime() === cursor[1] &&
                candidate.message.id < cursor[2]),
          )
        : 0;
      const start = afterCursor === -1 ? candidates.length : afterCursor;
      const page = candidates.slice(start, start + input.limit + 1);
      const visible = page.slice(0, input.limit);
      const last = visible[visible.length - 1];
      const nextCursor = page.length > input.limit && last ? encodeSearchCursor(last) : null;

      return {
        messages: visible.map((candidate) => candidate.message),
        nextCursor,
      };
    },

    async listMessagesAfterSeq(input: ListMessagesAfterSeqInput): Promise<Message[]> {
      const ids = messageIdsByConversation.get(input.conversationId) ?? [];
      const result: Message[] = [];
      // Stored ascending by seq - walk forward, collect seq > afterSeq.
      for (const id of ids) {
        const message = messages.get(id);
        if (!message || message.seq <= input.afterSeq) continue;
        result.push({ ...message });
        if (result.length >= input.limit) break;
      }
      return result;
    },

    async updateMessage(input: UpdateMessageInput): Promise<Message> {
      const message = messages.get(input.messageId);
      if (!message) {
        throw new Error(`memoryAdapter: unknown message "${input.messageId}".`);
      }

      if (input.body !== undefined) message.body = input.body;
      if (input.editedAt !== undefined) message.editedAt = input.editedAt;
      if (input.deletedAt !== undefined) message.deletedAt = input.deletedAt;

      return { ...message };
    },

    async updateLastRead(input: UpdateLastReadInput): Promise<void> {
      const record = conversations.get(input.conversationId);
      const participant = record?.participants.get(input.userId);
      if (!record || !participant) {
        throw new Error(
          `memoryAdapter: user "${input.userId}" is not a participant of "${input.conversationId}".`,
        );
      }
      participant.lastReadMessageId = input.messageId;
    },

    async countUnread(input: CountUnreadInput): Promise<Record<string, number>> {
      const counts: Record<string, number> = {};
      for (const conversationId of input.conversationIds) {
        const record = conversations.get(conversationId);
        const participant = record?.participants.get(input.userId);
        if (!record || !participant) {
          counts[conversationId] = 0;
          continue;
        }

        // null read-state reads as seq 0: everything is unread.
        const readSeq = participant.lastReadMessageId
          ? (messages.get(participant.lastReadMessageId)?.seq ?? 0)
          : 0;

        let count = 0;
        for (const id of messageIdsByConversation.get(conversationId) ?? []) {
          const message = messages.get(id);
          // Tombstones count (they render in lists); own messages never do.
          if (message && message.seq > readSeq && message.senderId !== input.userId) count++;
        }
        counts[conversationId] = count;
      }
      return counts;
    },

    async addReaction(input: ReactionInput): Promise<Reaction[]> {
      if (!messages.has(input.messageId)) {
        throw new Error(`memoryAdapter: unknown message "${input.messageId}".`);
      }
      const current = reactionsByMessage.get(input.messageId) ?? [];
      // Idempotent (ADR 0013): the same (message, user, emoji) triple twice
      // leaves exactly one reaction.
      const exists = current.some(
        (reaction) => reaction.userId === input.userId && reaction.emoji === input.emoji,
      );
      if (!exists) {
        current.push({
          messageId: input.messageId,
          userId: input.userId,
          emoji: input.emoji,
          createdAt: new Date(),
        });
        reactionsByMessage.set(input.messageId, current);
      }
      return current.map((reaction) => ({ ...reaction }));
    },

    async removeReaction(input: ReactionInput): Promise<Reaction[]> {
      if (!messages.has(input.messageId)) {
        throw new Error(`memoryAdapter: unknown message "${input.messageId}".`);
      }
      const current = reactionsByMessage.get(input.messageId) ?? [];
      // Idempotent: removing a reaction that was never there is a no-op.
      const remaining = current.filter(
        (reaction) => !(reaction.userId === input.userId && reaction.emoji === input.emoji),
      );
      reactionsByMessage.set(input.messageId, remaining);
      return remaining.map((reaction) => ({ ...reaction }));
    },

    async listReactionsByMessageIds(messageIds: string[]): Promise<Reaction[]> {
      const result: Reaction[] = [];
      for (const messageId of messageIds) {
        // Insertion order is already earliest-first per message, which is what
        // core's `userIds` aggregation expects.
        for (const reaction of reactionsByMessage.get(messageId) ?? []) {
          result.push({ ...reaction });
        }
      }
      return result;
    },

    async setMessageMentions(input: SetMessageMentionsInput): Promise<void> {
      if (!messages.has(input.messageId)) {
        throw new Error(`memoryAdapter: unknown message "${input.messageId}".`);
      }
      // Total replace (ADR 0023 §3): an empty set clears the row entirely, so a
      // dropped id cannot survive. Surviving rows keep their original
      // `createdAt` - re-stamping them on every edit would reorder mentions that
      // did not change.
      const existing = new Map(
        (mentionsByMessage.get(input.messageId) ?? []).map((mention) => [mention.userId, mention]),
      );
      const now = new Date();
      const next = input.userIds.map(
        (userId) =>
          existing.get(userId) ?? {
            messageId: input.messageId,
            userId,
            createdAt: now,
          },
      );
      if (next.length === 0) mentionsByMessage.delete(input.messageId);
      else mentionsByMessage.set(input.messageId, next);
    },

    async listMentionsByMessageIds(messageIds: string[]): Promise<MessageMention[]> {
      const result: MessageMention[] = [];
      for (const messageId of messageIds) {
        // (createdAt, userId) is the contract's canonical order. Sorting here
        // rather than at write time is what keeps this identical to a SQL
        // adapter's ORDER BY for a set written in one call, where every row
        // shares a timestamp and insertion order is not a thing SQL preserves.
        const mentions = [...(mentionsByMessage.get(messageId) ?? [])].sort(
          (a, b) =>
            a.createdAt.getTime() - b.createdAt.getTime() ||
            (a.userId < b.userId ? -1 : a.userId === b.userId ? 0 : 1),
        );
        for (const mention of mentions) result.push({ ...mention });
      }
      return result;
    },

    /**
     * The public channel directory (`docs/decisions/0020`) - the other optional
     * capability. Its presence is also core's signal that this adapter persists
     * `visibility` and `joinPolicy`, which it does (see `ConversationRecord`).
     */
    channels: {
      async listPublicConversations(
        input: ListPublicConversationsInput,
      ): Promise<ListPublicConversationsResult> {
        // Groups only, and public only. Core already refuses to make a DM
        // public, but the filter is cheap and a hand-edited record must not leak.
        return pageByActivity(
          [...conversations.values()].filter(
            (c) => c.type === "group" && c.visibility === "public",
          ),
          input.limit,
          input.cursor,
        );
      },
    },

    /**
     * Invite links and join requests (`docs/decisions/0019`) - the optional
     * capability, implemented in full. Provided as one object, so core's single
     * `storage.invites` check is all the gating it needs.
     */
    invites: {
      async createInvite(input: CreateInviteInput): Promise<ConversationInvite> {
        // The code comes from core, which owns entropy (ADR 0019 §3) - store it
        // verbatim rather than deriving anything from it.
        const invite: ConversationInvite = {
          code: input.code,
          conversationId: input.conversationId,
          createdBy: input.createdBy,
          createdAt: new Date(),
          expiresAt: input.expiresAt,
          maxUses: input.maxUses,
          uses: 0,
          requiresApproval: input.requiresApproval,
          metadata: { ...input.metadata },
        };
        invitesByCode.set(invite.code, invite);
        return { ...invite };
      },

      async getInvite(code: string): Promise<ConversationInvite | null> {
        const invite = invitesByCode.get(code);
        // Expired and exhausted invites are returned as-is: core needs to tell
        // "no such code" (404) from "no longer usable" (410).
        return invite ? { ...invite } : null;
      },

      async listInvites(conversationId: string): Promise<ConversationInvite[]> {
        return [...invitesByCode.values()]
          .filter((invite) => invite.conversationId === conversationId)
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
          .map((invite) => ({ ...invite }));
      },

      async deleteInvite(input: DeleteInviteInput): Promise<void> {
        const invite = invitesByCode.get(input.code);
        // Scoped by conversation and idempotent: an unknown code, or one from
        // another group, is a silent no-op.
        if (invite && invite.conversationId === input.conversationId) {
          invitesByCode.delete(input.code);
        }
      },

      async consumeInvite(code: string): Promise<ConversationInvite | null> {
        const invite = invitesByCode.get(code);
        if (!invite) return null;
        if (invite.expiresAt !== null && invite.expiresAt.getTime() <= Date.now()) return null;
        if (invite.maxUses !== null && invite.uses >= invite.maxUses) return null;
        // Atomic by construction: single-threaded JS, and the check and the
        // increment sit in one synchronous block with no await between them.
        // A SQL adapter needs a conditional UPDATE ... RETURNING instead.
        invite.uses += 1;
        return { ...invite };
      },

      async createJoinRequest(input: CreateJoinRequestInput): Promise<JoinRequest> {
        const request: JoinRequest = {
          id: nextId("jreq"),
          conversationId: input.conversationId,
          userId: input.userId,
          status: "pending",
          message: input.message,
          inviteCode: input.inviteCode,
          createdAt: new Date(),
          resolvedAt: null,
          resolvedBy: null,
          metadata: { ...input.metadata },
        };
        // Replaces any previous row for this pair, so a denied-then-reasking
        // user gets one fresh pending request (ADR 0019 §5).
        joinRequestsByKey.set(joinRequestKey(input.conversationId, input.userId), request);
        return { ...request };
      },

      async getJoinRequest(input: GetJoinRequestInput): Promise<JoinRequest | null> {
        const request = joinRequestsByKey.get(joinRequestKey(input.conversationId, input.userId));
        return request ? { ...request } : null;
      },

      async listJoinRequests(input: ListJoinRequestsInput): Promise<JoinRequest[]> {
        return [...joinRequestsByKey.values()]
          .filter(
            (request) =>
              request.conversationId === input.conversationId &&
              (input.status === undefined || request.status === input.status),
          )
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
          .slice(0, input.limit)
          .map((request) => ({ ...request }));
      },

      async resolveJoinRequest(input: ResolveJoinRequestInput): Promise<JoinRequest> {
        const key = joinRequestKey(input.conversationId, input.userId);
        const request = joinRequestsByKey.get(key);
        if (!request) {
          throw new Error(
            `memoryAdapter: no join request from user "${input.userId}" in "${input.conversationId}".`,
          );
        }
        request.status = input.status;
        request.resolvedAt = input.resolvedAt;
        request.resolvedBy = input.resolvedBy;
        return { ...request };
      },
    },
  };
}
