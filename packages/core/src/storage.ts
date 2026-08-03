/**
 * The storage adapter contract - one of the two interfaces that carry the
 * whole Chatpack design (MVP §6).
 *
 * Core depends on this interface, never on a concrete database. Reference
 * implementations: `@chatpack/adapter-memory` (Maps) and
 * `@chatpack/adapter-drizzle` (Drizzle/Postgres).
 *
 * Adapter authors: see the "Writing a storage adapter" section of
 * CONTRIBUTING.md, and `llms.txt` at the repo root for the full guide
 * (invariants, reference schema, skeleton, verification checklist). Key
 * rules:
 *
 * - Adapters never enforce permissions - core does that before calling you.
 * - `getOrCreateDirectConversation` must be idempotent per `pairKey`.
 * - Message listing is newest-first with cursor pagination.
 * - Cursors are opaque strings **defined by the adapter**: core round-trips
 *   your `nextCursor` back into `input.cursor` verbatim. Any URL-safe
 *   encoding works.
 * - Date fields must be real `Date` instances, never ISO strings - core does
 *   not coerce, and many database drivers/HTTP clients return strings.
 * - The adapter generates conversation and message ids (any unique string).
 *
 * @module
 */

import type { Conversation, Message, Metadata, MessageRole, Reaction } from "./types";

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
   * first page. The encoding is adapter-defined - core passes your
   * `nextCursor` back verbatim. Ordering is most-recently-active first (by
   * latest message `seq`, falling back to conversation creation time).
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
  /**
   * The message this one quote-replies to, or `null` for a normal message
   * (`docs/decisions/0013`). Core has already verified it exists in the same
   * conversation - store it verbatim, no validation needed.
   */
  replyToMessageId: string | null;
  metadata: Metadata;
}

/** Input for {@link StorageAdapter.addReaction} and {@link StorageAdapter.removeReaction}. */
export interface ReactionInput {
  messageId: string;
  /** The reacting user. Comes from the auth hook, never from a request body. */
  userId: string;
  /** The reaction key, already trimmed and length-checked by core. */
  emoji: string;
}

/** Input for {@link StorageAdapter.listMessages}. */
export interface ListMessagesInput {
  conversationId: string;
  /** Max messages to return. */
  limit: number;
  /**
   * Opaque cursor from a previous page's `nextCursor`, or `undefined` for the
   * first page. The encoding is adapter-defined - core passes your
   * `nextCursor` back verbatim (the Drizzle adapter uses the previous page's
   * last `seq`). Ordering is newest-first (descending `seq`).
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

/** Input for {@link StorageAdapter.countUnread}. */
export interface CountUnreadInput {
  /** The viewer whose unread counts are being computed. */
  userId: string;
  /** Conversations to compute counts for (typically one page of a list). */
  conversationIds: string[];
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

  /**
   * Fetch many messages by id in one call - core uses this to hydrate
   * quote-reply previews, one batched call per page (`docs/decisions/0013`).
   *
   * Order does not matter and unknown ids must simply be absent from the
   * result (never `null` entries, never a throw). An empty input array must
   * return an empty array without touching the database.
   */
  getMessagesByIds(messageIds: string[]): Promise<Message[]>;

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
   * the message belongs to the conversation and the user is a participant,
   * and that the new message is not older than the current read-state.
   */
  updateLastRead(input: UpdateLastReadInput): Promise<void>;

  /**
   * Count unread messages per conversation for one viewer, batched.
   *
   * For each id in `conversationIds`, count messages where `seq` is strictly
   * greater than the `seq` of the viewer's `lastReadMessageId` (treat `null`
   * read-state as seq 0) AND `senderId !== userId` (a viewer's own messages
   * are never unread). Soft-deleted messages keep their `seq` and DO count -
   * they render as tombstones in lists, so the badge matches what the client
   * shows. All roles count.
   *
   * Return a map of conversationId → count. Ids the viewer does not
   * participate in (or that don't exist) may be omitted or returned as 0 -
   * core treats missing keys as 0.
   */
  countUnread(input: CountUnreadInput): Promise<Record<string, number>>;

  /**
   * Add a reaction (`docs/decisions/0013`). **Idempotent**: the same
   * `(messageId, userId, emoji)` triple twice must leave exactly one
   * reaction, not two and not an error.
   *
   * Returns **all** reactions on the message afterwards, so core can publish a
   * complete snapshot without a second round trip. Reactions must not touch
   * the conversation's activity ordering or `lastSeq` - a reaction is not a
   * message.
   */
  addReaction(input: ReactionInput): Promise<Reaction[]>;

  /**
   * Remove a reaction. **Idempotent**: removing one that was never there is a
   * silent no-op, not an error (an unreact can be replayed).
   *
   * Returns all remaining reactions on the message, same as
   * {@link StorageAdapter.addReaction}.
   */
  removeReaction(input: ReactionInput): Promise<Reaction[]>;

  /**
   * All reactions on a set of messages, batched - core uses this to decorate
   * message pages, one call per page.
   *
   * Sort ascending by `createdAt` so aggregated `userIds` come out
   * earliest-first. Messages with no reactions are simply absent from the
   * result; an empty input array returns an empty array.
   */
  listReactionsByMessageIds(messageIds: string[]): Promise<Reaction[]>;
}
