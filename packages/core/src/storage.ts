/**
 * The storage adapter contract — one of the two interfaces that carry the
 * whole Chatpack design (MVP §6).
 *
 * Core depends on this interface, never on a concrete database. Reference
 * implementations: `@chatpack/adapter-memory` (Maps) and
 * `@chatpack/adapter-drizzle` (Drizzle/Postgres).
 *
 * Adapter authors: see the "Writing a storage adapter" section of
 * CONTRIBUTING.md. Key rules:
 *
 * - Adapters never enforce permissions — core does that before calling you.
 * - `getOrCreateDirectConversation` must be idempotent per `pairKey`.
 * - Message listing is newest-first with cursor pagination.
 *
 * @module
 */

import type { Conversation, Message, Metadata, MessageRole } from "./types";

/** Input for {@link StorageAdapter.getOrCreateDirectConversation}. */
export interface GetOrCreateDirectConversationInput {
  /**
   * Deterministic pair key computed by core (sorted user ids joined with
   * `":"`). The adapter must treat this as the uniqueness key for direct
   * conversations.
   */
  pairKey: string;
  /** The two participant user ids, already validated and sorted by core. */
  userIds: [string, string];
  /** Metadata to set if (and only if) the conversation is created. */
  metadata: Metadata;
}

/** Result of {@link StorageAdapter.getOrCreateDirectConversation}. */
export interface GetOrCreateDirectConversationResult {
  conversation: Conversation;
  /** `true` if this call created the conversation, `false` if it already existed. */
  created: boolean;
}

/** Input for {@link StorageAdapter.listConversations}. */
export interface ListConversationsInput {
  /** Only conversations this user participates in. */
  userId: string;
  /** Max conversations to return. */
  limit: number;
  /**
   * Opaque cursor from a previous page's `nextCursor`, or `undefined` for the
   * first page. Ordering is most-recently-active first (by latest message
   * `seq`, falling back to conversation creation time).
   */
  cursor?: string | undefined;
}

/** Result of {@link StorageAdapter.listConversations}. */
export interface ListConversationsResult {
  conversations: Conversation[];
  /** Cursor for the next page, or `null` when there are no more results. */
  nextCursor: string | null;
}

/** Input for {@link StorageAdapter.addMessage}. */
export interface AddMessageInput {
  conversationId: string;
  senderId: string;
  body: string;
  role: MessageRole;
  metadata: Metadata;
}

/** Input for {@link StorageAdapter.listMessages}. */
export interface ListMessagesInput {
  conversationId: string;
  /** Max messages to return. */
  limit: number;
  /**
   * Opaque cursor from a previous page's `nextCursor`, or `undefined` for the
   * first page. Ordering is newest-first (descending `seq`).
   */
  cursor?: string | undefined;
}

/** Result of {@link StorageAdapter.listMessages}. */
export interface ListMessagesResult {
  /** Messages in newest-first order (descending `seq`). */
  messages: Message[];
  /** Cursor for the next (older) page, or `null` when there are no more results. */
  nextCursor: string | null;
}

/** Input for {@link StorageAdapter.updateMessage}. */
export interface UpdateMessageInput {
  messageId: string;
  /** New body text (edit). */
  body?: string | undefined;
  /** Set the edited timestamp. */
  editedAt?: Date | undefined;
  /** Set the soft-delete timestamp. */
  deletedAt?: Date | undefined;
}

/** Input for {@link StorageAdapter.listMessagesAfterSeq}. */
export interface ListMessagesAfterSeqInput {
  conversationId: string;
  /** Return messages with `seq` strictly greater than this. */
  afterSeq: number;
  /** Max messages to return. */
  limit: number;
}

/** Input for {@link StorageAdapter.updateLastRead}. */
export interface UpdateLastReadInput {
  conversationId: string;
  userId: string;
  /** The id of the last message the user has read. */
  messageId: string;
}

/**
 * Durable reads/writes for the chat domain.
 *
 * Implement this interface to back Chatpack with any database. The contract
 * is deliberately small: conversations (find-or-create by pair, list, fetch),
 * messages (add, list, update-in-place), and read-state.
 */
export interface StorageAdapter {
  /**
   * Find the direct conversation for `pairKey`, or atomically create it with
   * both participants. Must be idempotent: concurrent calls with the same
   * `pairKey` must converge on a single conversation.
   */
  getOrCreateDirectConversation(
    input: GetOrCreateDirectConversationInput,
  ): Promise<GetOrCreateDirectConversationResult>;

  /** Fetch a conversation (with participants) by id, or `null` if unknown. */
  getConversation(conversationId: string): Promise<Conversation | null>;

  /** List the conversations a user participates in, most-recently-active first. */
  listConversations(input: ListConversationsInput): Promise<ListConversationsResult>;

  /**
   * Persist a new message and assign it the next monotonic `seq` for its
   * conversation (strictly increasing, never reused).
   */
  addMessage(input: AddMessageInput): Promise<Message>;

  /** Fetch a single message by id, or `null` if unknown. */
  getMessage(messageId: string): Promise<Message | null>;

  /** List messages in a conversation, newest-first, with cursor pagination. */
  listMessages(input: ListMessagesInput): Promise<ListMessagesResult>;

  /**
   * List messages with `seq` strictly greater than `afterSeq`, **oldest
   * first**. Powers SSE reconnection gap-fill (MVP §9): the client says
   * "I have up to seq X", the server replays what it missed from storage.
   */
  listMessagesAfterSeq(input: ListMessagesAfterSeqInput): Promise<Message[]>;

  /**
   * Update a message in place (edit body / set editedAt / set deletedAt).
   * Returns the updated message. Throws if the message does not exist.
   */
  updateMessage(input: UpdateMessageInput): Promise<Message>;

  /**
   * Set a participant's `lastReadMessageId`. Core has already validated that
   * the message belongs to the conversation and the user is a participant.
   */
  updateLastRead(input: UpdateLastReadInput): Promise<void>;
}
