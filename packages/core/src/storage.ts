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

import type {
  Conversation,
  ConversationInvite,
  JoinRequest,
  JoinRequestStatus,
  Message,
  Metadata,
  MessageRole,
  ParticipantRole,
  Reaction,
} from "./types";

/** Input for {@link StorageAdapter.createGroupConversation}. */
export interface CreateGroupConversationInput {
  /**
   * The creator, who becomes the group's first `admin`
   * (`docs/decisions/0017`).
   */
  creatorId: string;
  /**
   * Other members to seed the group with, already validated and de-duplicated
   * by core (never contains `creatorId`). May be empty - a group can start
   * with only its creator.
   */
  userIds: string[];
  /** Group title, already trimmed and length-checked by core, or `null`. */
  name: string | null;
  /** Metadata to set on the new conversation. */
  metadata: Metadata;
}

/** Input for {@link StorageAdapter.addParticipants}. */
export interface AddParticipantsInput {
  conversationId: string;
  /**
   * Users to add as `member`s, de-duplicated by core. Adding someone who is
   * already a participant must be a **no-op**, not an error - membership
   * requests can be replayed (`docs/decisions/0017`).
   */
  userIds: string[];
}

/** Input for {@link StorageAdapter.removeParticipant}. */
export interface RemoveParticipantInput {
  conversationId: string;
  /**
   * The user to remove. Removing someone who is not a participant must be a
   * silent **no-op**, not an error (`docs/decisions/0017`).
   */
  userId: string;
}

/** Input for {@link StorageAdapter.setParticipantRole}. */
export interface SetParticipantRoleInput {
  conversationId: string;
  userId: string;
  role: ParticipantRole;
}

/** Input for {@link StorageAdapter.updateConversation}. */
export interface UpdateConversationInput {
  conversationId: string;
  /** The new group title, or `null` to clear it. */
  name: string | null;
}

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

/** Input for {@link StorageAdapter.searchMessages}. */
export interface SearchMessagesInput {
  /** User whose participant conversations are searchable. */
  userId: string;
  /** Plain-text terms to search for, case-insensitively. */
  query: string;
  /** Max messages to return. */
  limit: number;
  /**
   * Opaque cursor from a previous page's `nextCursor`, or `undefined` for the
   * first page. The adapter owns the participant scope, ranking, and cursor
   * encoding.
   */
  cursor?: string | undefined;
}

/** Result of {@link StorageAdapter.searchMessages}. */
export interface SearchMessagesResult {
  /** Matching, non-tombstone messages in participant-scoped relevance order. */
  messages: Message[];
  /** Cursor for the next ranked page, or `null` when there are no more results. */
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

/** Input for {@link InviteStorage.createInvite}. */
export interface CreateInviteInput {
  conversationId: string;
  /**
   * The invite secret, generated by **core** (`docs/decisions/0019` §3) - store
   * it verbatim as the primary key. Adapters must not generate or re-derive
   * this: unguessability is a security property, not a storage detail.
   */
  code: string;
  /** Who minted the invite. */
  createdBy: string;
  /** Absolute expiry computed by core from `expiresInSeconds`, or `null`. */
  expiresAt: Date | null;
  /** Use cap, already validated by core as a positive integer, or `null`. */
  maxUses: number | null;
  /** Whether redeeming creates a pending join request instead of joining. */
  requiresApproval: boolean;
  metadata: Metadata;
}

/** Input for {@link InviteStorage.deleteInvite}. */
export interface DeleteInviteInput {
  /**
   * The conversation the invite must belong to. Scoping the delete means an
   * admin of group A can never revoke group B's invite by guessing a code.
   */
  conversationId: string;
  code: string;
}

/** Input for {@link InviteStorage.createJoinRequest}. */
export interface CreateJoinRequestInput {
  conversationId: string;
  userId: string;
  /** Requester's note, already trimmed and length-checked by core, or `null`. */
  message: string | null;
  /** The invite this request came from, or `null` for a direct ask. */
  inviteCode: string | null;
  metadata: Metadata;
}

/** Input for {@link InviteStorage.getJoinRequest}. */
export interface GetJoinRequestInput {
  conversationId: string;
  userId: string;
}

/** Input for {@link InviteStorage.listJoinRequests}. */
export interface ListJoinRequestsInput {
  conversationId: string;
  /** Only requests in this state, or `undefined` for all of them. */
  status?: JoinRequestStatus | undefined;
  /** Max requests to return. */
  limit: number;
}

/** Input for {@link InviteStorage.resolveJoinRequest}. */
export interface ResolveJoinRequestInput {
  conversationId: string;
  userId: string;
  /** The decision. Core has already checked the request exists and is pending. */
  status: Extract<JoinRequestStatus, "approved" | "denied">;
  /** The admin who decided. */
  resolvedBy: string;
  /** Decision timestamp, supplied by core so it matches the published event. */
  resolvedAt: Date;
}

/**
 * Invite links and join requests (`docs/decisions/0019`) - an **optional**
 * storage capability.
 *
 * Exposed as one namespace rather than nine individually-optional methods on
 * {@link StorageAdapter} on purpose: nine optional methods have 2⁹ possible
 * states, almost all broken, and an adapter implementing six of them would
 * typecheck and then fail at runtime on the seventh. One object is
 * all-or-nothing (ADR 0019 §2). Core reports `INVITES_UNSUPPORTED` (501) when
 * `StorageAdapter.invites` is absent.
 *
 * Two tables' worth of state: invites (a secret plus expiry/use limits) and
 * join requests (a requester plus a resolution). Core owns all validation,
 * permissions, and token generation; this contract is pure persistence with
 * one concurrency requirement - see {@link InviteStorage.consumeInvite}.
 */
export interface InviteStorage {
  /** Persist a new invite exactly as core supplies it. */
  createInvite(input: CreateInviteInput): Promise<ConversationInvite>;

  /**
   * Fetch an invite by code, or `null` if unknown. Must return expired and
   * exhausted invites too - core distinguishes "no such code" (404) from "no
   * longer usable" (410), and cannot if the adapter hides the difference.
   */
  getInvite(code: string): Promise<ConversationInvite | null>;

  /**
   * All invites for one group, newest-first. Includes expired and exhausted
   * ones so an admin can see and clean them up.
   */
  listInvites(conversationId: string): Promise<ConversationInvite[]>;

  /**
   * Revoke an invite. **Idempotent**: deleting one that does not exist (or
   * belongs to another conversation) is a silent no-op, not an error.
   */
  deleteInvite(input: DeleteInviteInput): Promise<void>;

  /**
   * **Atomically** consume one use of an invite, returning the updated row - or
   * `null` if it is no longer usable (unknown, expired, or `uses` has reached
   * `maxUses`).
   *
   * The check and the increment must happen in **one statement**, or two
   * simultaneous redemptions of a `maxUses: 1` invite will both succeed. In
   * SQL that is a conditional `UPDATE ... RETURNING` (ADR 0019 §2); zero rows
   * affected is the `null` case. Do not read-then-write.
   */
  consumeInvite(code: string): Promise<ConversationInvite | null>;

  /**
   * Create a pending join request, or **replace** the existing row for the same
   * `(conversationId, userId)`.
   *
   * At most one row per user per conversation: a user who was denied and asks
   * again gets a fresh `pending` request, not a second row and not an error
   * (ADR 0019 §5).
   */
  createJoinRequest(input: CreateJoinRequestInput): Promise<JoinRequest>;

  /** One user's join request for one conversation, whatever its status, or `null`. */
  getJoinRequest(input: GetJoinRequestInput): Promise<JoinRequest | null>;

  /** Join requests for one group, newest-first, optionally filtered by status. */
  listJoinRequests(input: ListJoinRequestsInput): Promise<JoinRequest[]>;

  /**
   * Record an admin's decision on a pending request and return the updated row.
   * Core has already verified it exists and is pending, and performs the
   * participant add separately on approval. Throws if the row is gone.
   */
  resolveJoinRequest(input: ResolveJoinRequestInput): Promise<JoinRequest>;
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

  /**
   * Create a group conversation (`docs/decisions/0017`). Unlike
   * {@link StorageAdapter.getOrCreateDirectConversation} this is **not**
   * find-or-create: two groups with identical membership are two distinct
   * groups, so every call creates a new row.
   *
   * Store `type: "group"` and `pairKey: null`. The creator is persisted with
   * `role: "admin"`, everyone in `userIds` with `role: "member"`.
   */
  createGroupConversation(input: CreateGroupConversationInput): Promise<Conversation>;

  /**
   * Add members to a group, returning the **full updated conversation** so core
   * can publish a complete snapshot without a second read (the same contract
   * `addReaction` uses, `docs/decisions/0013`).
   *
   * Must be idempotent: ids that are already participants are skipped, not
   * duplicated and not an error. New participants get `role: "member"`.
   */
  addParticipants(input: AddParticipantsInput): Promise<Conversation>;

  /**
   * Remove one member from a group, returning the full updated conversation.
   *
   * Must be idempotent: removing a non-participant is a silent no-op. Core has
   * already checked permissions and the last-admin invariant. Leave the
   * removed user's messages in place - history is not rewritten by departure.
   */
  removeParticipant(input: RemoveParticipantInput): Promise<Conversation>;

  /**
   * Change one participant's role, returning the full updated conversation.
   * Core has already enforced that this cannot demote the last admin.
   */
  setParticipantRole(input: SetParticipantRoleInput): Promise<Conversation>;

  /**
   * Update a group's mutable fields (currently just `name`), returning the full
   * updated conversation. Core has already validated and trimmed the name.
   */
  updateConversation(input: UpdateConversationInput): Promise<Conversation>;

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
   * Search non-tombstone messages in the user's participant conversations by
   * body, case-insensitively, in ranked order. Core applies `canRead` to each
   * returned message's conversation.
   *
   * This is an optional capability so existing custom adapters remain valid.
   * First-party adapters use the canonical tokenizer and score exported by
   * `@chatpack/core`; custom adapters should use those helpers when they
   * implement search. Core reports `SEARCH_UNSUPPORTED` when it is omitted.
   */
  searchMessages?(input: SearchMessagesInput): Promise<SearchMessagesResult>;

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

  /**
   * Invite links and join requests (`docs/decisions/0019`) - **optional**.
   *
   * Omit it and the eight invite routes return `INVITES_UNSUPPORTED` (501)
   * while everything else works unchanged. Provide it as one complete object;
   * see {@link InviteStorage} for why it is a namespace rather than nine
   * optional methods.
   */
  invites?: InviteStorage;
}
