/**
 * `@chatpack/adapter-memory` — in-memory {@link StorageAdapter} for Chatpack.
 *
 * Zero-setup storage backed by JavaScript Maps. Perfect for demos, examples,
 * and fast deterministic tests. **Data is lost when the process exits** — use
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
  GetOrCreateDirectConversationInput,
  GetOrCreateDirectConversationResult,
  ListConversationsInput,
  ListConversationsResult,
  ListMessagesAfterSeqInput,
  ListMessagesInput,
  ListMessagesResult,
  Message,
  Participant,
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
      // Stored ascending by seq — walk forward, collect seq > afterSeq.
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
  };
}
