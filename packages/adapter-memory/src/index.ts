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
  Conversation,
  CountUnreadInput,
  GetOrCreateDirectConversationInput,
  GetOrCreateDirectConversationResult,
  ListConversationsInput,
  ListConversationsResult,
  ListMessagesAfterSeqInput,
  ListMessagesInput,
  ListMessagesResult,
  Message,
  Participant,
  Reaction,
  ReactionInput,
  StorageAdapter,
  UpdateLastReadInput,
  UpdateMessageInput,
} from "@chatpack/core";

interface ConversationRecord {
  id: string;
  pairKey: string;
  createdAt: Date;
  metadata: Record<string, unknown>;
  participants: Map<string, Participant>;
  /** Monotonic per-conversation message sequence (MVP §8). */
  nextSeq: number;
  /** Global activity tick of the latest message; used for most-recently-active ordering. */
  lastActivityTick: number;
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

  let idCounter = 0;
  const nextId = (prefix: string): string => `${prefix}_${(++idCounter).toString(36)}`;
  /** Global tick so "most recently active" is comparable across conversations. */
  let activityTick = 0;

  function toConversation(record: ConversationRecord): Conversation {
    return {
      id: record.id,
      pairKey: record.pairKey,
      createdAt: record.createdAt,
      metadata: { ...record.metadata },
      participants: [...record.participants.values()].map((p) => ({ ...p })),
    };
  }

  return {
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
        pairKey: input.pairKey,
        createdAt: now,
        metadata: { ...input.metadata },
        participants: new Map(
          input.userIds.map((userId) => [
            userId,
            { conversationId: id, userId, joinedAt: now, lastReadMessageId: null },
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

    async getConversation(conversationId: string): Promise<Conversation | null> {
      const record = conversations.get(conversationId);
      return record ? toConversation(record) : null;
    },

    async listConversations(input: ListConversationsInput): Promise<ListConversationsResult> {
      // Most-recently-active first: latest message seq wins, then creation
      // time, then id for a stable total order.
      const mine = [...conversations.values()]
        .filter((c) => c.participants.has(input.userId))
        .sort(
          (a, b) =>
            b.lastActivityTick - a.lastActivityTick ||
            b.createdAt.getTime() - a.createdAt.getTime() ||
            (a.id < b.id ? 1 : -1),
        );

      const start = input.cursor ? mine.findIndex((c) => c.id === input.cursor) + 1 : 0;
      const page = mine.slice(start, start + input.limit);
      const last = page[page.length - 1];
      const nextCursor = last && start + input.limit < mine.length ? last.id : null;

      return { conversations: page.map(toConversation), nextCursor };
    },

    async addMessage(input: AddMessageInput): Promise<Message> {
      const record = conversations.get(input.conversationId);
      if (!record) {
        throw new Error(`memoryAdapter: unknown conversation "${input.conversationId}".`);
      }

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
  };
}
