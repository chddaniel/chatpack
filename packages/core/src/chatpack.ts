/**
 * The Chatpack core engine (M1): 1:1 and group domain logic, permission
 * checks, and validation, driven through a {@link StorageAdapter}.
 *
 * @module
 */

import type {
  AfterMessageMutationContext,
  BeforeMessageSendContext,
  ChatpackOptions,
  ChatpackUser,
  PermissionContext,
} from "./config";
import { ChatpackError } from "./errors";
import { createHandler, type ChatpackHandler, type HandlerOptions } from "./handler";
import type { ModerationAction, ModerationApi } from "./moderation";
import { createPluginRuntime, type PluginRuntime } from "./plugin";
import type { ModerationStorage, StorageAdapter } from "./storage";
import {
  inProcessTransport,
  type ChatEvent,
  type ConversationEvent,
  type Transport,
} from "./transport";
import { TelemetryCounters, resolveTelemetryEnabled, startTelemetryFlusher } from "./telemetry";
import type {
  ChannelJoinPolicy,
  ChannelPreview,
  ChannelVisibility,
  Conversation,
  ConversationInvite,
  ConversationWithUnread,
  ForwardProvenance,
  InvitePreview,
  JoinRequest,
  JoinRequestStatus,
  Message,
  MessageReference,
  MessageWithDetails,
  Metadata,
  MessageRole,
  ParticipantRole,
  Reaction,
  ReactionSummary,
  ModerationReport,
  ReportStatus,
  ReportTargetType,
} from "./types";

/** Default page size for list endpoints. */
const DEFAULT_LIMIT = 50;
/** Hard cap for list endpoints. */
const MAX_LIMIT = 200;
/** Max length of a reaction key (ADR 0013 §3). */
const MAX_EMOJI_LENGTH = 32;
/** How much of a quoted parent body a reply preview carries (ADR 0013 §1). */
const EXCERPT_LENGTH = 140;
/**
 * Max mentions on one message (ADR 0023 §2).
 *
 * Not really a policy limit - every mention must be a participant, and groups
 * cap at {@link MAX_GROUP_PARTICIPANTS}, so membership is already the bound and
 * an `@all` expansion of a full group fits. This exists so a hostile array is
 * rejected before core starts issuing membership lookups, which is why it is
 * checked before de-duplication.
 */
export const MAX_MENTIONS_PER_MESSAGE = 256;
const MAX_MODERATION_REASON_LENGTH = 1000;
const MAX_MODERATOR_NOTE_LENGTH = 2000;
/**
 * Max participants in one group (ADR 0017 §3). Enforced in core so every
 * adapter agrees rather than each imposing its own ceiling.
 */
export const MAX_GROUP_PARTICIPANTS = 256;
/**
 * How many `userExists` checks may be in flight at once. Not tunable on
 * purpose: it exists to keep a large group from flooding the host's connection
 * pool, and a host that wants one query for many ids should batch inside its
 * own hook.
 */
const USER_EXISTS_CONCURRENCY = 8;
/** Max length of a group name (ADR 0017 §1). */
export const MAX_CONVERSATION_NAME_LENGTH = 200;
/**
 * Max live invites one group may hold (ADR 0019). Expired invites are never
 * garbage-collected, so this is what keeps an app minting short-lived links
 * from growing the table without bound - revoke or reuse instead.
 */
export const MAX_INVITES_PER_CONVERSATION = 50;
/** Max length of the note a user attaches to a join request (ADR 0019). */
export const MAX_JOIN_REQUEST_MESSAGE_LENGTH = 500;
/**
 * Entropy of a generated invite code, in bytes (ADR 0019 §3). 32 bytes = 256
 * bits, which is 43 base64url characters.
 */
const INVITE_CODE_BYTES = 32;

/**
 * Generate an invite code: 32 cryptographically random bytes as base64url.
 *
 * Core owns this rather than the adapter (which generates every other id)
 * because an id needs to be unique while a token needs to be **unguessable** -
 * an adapter reaching for `Math.random()` would pass every test and still be
 * brute-forcible (ADR 0019 §3). base64url so it is URL-safe with nothing to
 * percent-encode, which is what lets the code live in the request path.
 */
function generateInviteCode(): string {
  const bytes = new Uint8Array(INVITE_CODE_BYTES);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Compute the deterministic pair key for two user ids: sorted and joined with
 * `":"`. Guarantees one direct conversation per user pair (MVP §8) - see
 * `docs/decisions/0002-pair-key.md`.
 */
export function pairKeyFor(userIdA: string, userIdB: string): string {
  return [userIdA, userIdB].sort().join(":");
}

/** Input for {@link ChatpackApi.getOrCreateConversation}. */
export interface GetOrCreateConversationInput {
  /** The requesting (current) user. */
  userId: string;
  /** The other participant. */
  otherUserId: string;
  /** Metadata to set if the conversation is created. */
  metadata?: Metadata;
}

/** Input for {@link ChatpackApi.createGroupConversation} (ADR 0017). */
export interface CreateGroupConversationApiInput {
  /** The creator, who becomes the group's first admin. */
  userId: string;
  /**
   * Other members to seed the group with. Optional and may be empty - a group
   * can start with only its creator, who then invites. Duplicates and the
   * creator's own id are ignored rather than rejected.
   */
  userIds?: string[];
  /**
   * Group title. Trimmed; must be non-empty if provided and at most
   * {@link MAX_CONVERSATION_NAME_LENGTH} characters. Omit for an unnamed group.
   */
  name?: string;
  /**
   * Whether to list the group in the public channel directory (ADR 0020).
   * Defaults to `"private"`. Anything other than `"private"` requires the
   * storage adapter's `channels` capability, else `CHANNELS_UNSUPPORTED`.
   */
  visibility?: ChannelVisibility;
  /**
   * How strangers joining a public channel are handled. Defaults to
   * `"approval"`. Settable while still private (it takes effect when you flip
   * visibility), but like `visibility` it needs the `channels` capability.
   */
  joinPolicy?: ChannelJoinPolicy;
  metadata?: Metadata;
}

/** Input for {@link ChatpackApi.addParticipants} (ADR 0017). */
export interface AddParticipantsApiInput {
  /** The acting user. Must be able to manage the conversation. */
  userId: string;
  conversationId: string;
  /** Users to add. Already-present ids are no-ops, not errors. */
  userIds: string[];
}

/** Input for {@link ChatpackApi.removeParticipant} (ADR 0017). */
export interface RemoveParticipantApiInput {
  /** The acting user: an admin, or the target themselves (leaving). */
  userId: string;
  conversationId: string;
  /** The user to remove. Equal to `userId` when leaving. */
  targetUserId: string;
}

/** Input for {@link ChatpackApi.setParticipantRole} (ADR 0017). */
export interface SetParticipantRoleApiInput {
  /** The acting user. Must be able to manage the conversation. */
  userId: string;
  conversationId: string;
  targetUserId: string;
  role: ParticipantRole;
}

/** Input for {@link ChatpackApi.updateConversation} (ADR 0017, ADR 0020). */
export interface UpdateConversationApiInput {
  /** The acting user. Must be able to manage the conversation. */
  userId: string;
  conversationId: string;
  /**
   * The new title, or `null` to clear it. Omit to leave the current title
   * alone - which is only useful when you are changing `visibility` or
   * `joinPolicy` instead, since an update that changes nothing is rejected.
   */
  name?: string | null;
  /**
   * Flip the channel in or out of the public directory (ADR 0020). Omit to
   * leave it unchanged. Requires the `channels` storage capability; requires
   * manage permission, like every other field here - going public is a
   * property of the room, not an invitation.
   */
  visibility?: ChannelVisibility;
  /** Change how strangers join. Omit to leave it unchanged. */
  joinPolicy?: ChannelJoinPolicy;
}

/** Input for {@link ChatpackApi.listConversations}. */
export interface ListConversationsApiInput {
  userId: string;
  limit?: number;
  cursor?: string;
}

/** Result of {@link ChatpackApi.listConversations}. */
export interface ListConversationsApiResult {
  conversations: ConversationWithUnread[];
  nextCursor: string | null;
}

/** Input for {@link ChatpackApi.getConversation}. */
export interface GetConversationInput {
  userId: string;
  conversationId: string;
}

/** Input for {@link ChatpackApi.sendMessage}. */
export interface SendMessageInput {
  userId: string;
  conversationId: string;
  /** Message text. Must be non-empty. */
  body: string;
  /** Defaults to `"user"`. AI escape hatch only. */
  role?: MessageRole;
  /**
   * Quote-reply to this message (`docs/decisions/0013`). Must be a message in
   * the same conversation, else `MESSAGE_NOT_FOUND`. Replying to a
   * soft-deleted message is allowed - the parent can be deleted between
   * render and send.
   */
  replyToMessageId?: string;
  /**
   * User ids to mark as mentioned (`docs/decisions/0023`). Every id must be a
   * participant of this conversation, else `MENTION_NOT_PARTICIPANT`.
   *
   * Supplied, never parsed: core does not read `body` (ADR 0022) and cannot
   * resolve a display name to a user id without a users table. The two may
   * therefore disagree - keeping them in step is the app's job.
   */
  mentions?: string[];
  metadata?: Metadata;
}

/** Input for {@link ChatpackApi.forwardMessage} (ADR 0024). */
export interface ForwardMessageInput {
  /**
   * The forwarder. Needs `canRead` on the source conversation and `canWrite` on
   * the target - forwarding is the one message operation that spans two.
   */
  userId: string;
  /**
   * The message to forward. Must be readable by `userId` and must not be a
   * tombstone (`MESSAGE_DELETED`) - a forward's whole payload is the copied
   * body.
   */
  messageId: string;
  /**
   * Where to forward it to. May be the same conversation the message is
   * already in; nothing special happens if it is.
   */
  toConversationId: string;
  /** Defaults to `"user"`. The source's role is deliberately not copied (ADR 0024 §4). */
  role?: MessageRole;
  /**
   * Mentions for the **new** message, validated against the target
   * conversation. The source's mentions never travel (ADR 0024 §6).
   */
  mentions?: string[];
  /**
   * Metadata for the new message. The source's metadata does not travel - it may
   * hold app-private fields scoped to readers the target never had.
   */
  metadata?: Metadata;
}

/** Input for {@link ChatpackApi.listMessages}. */
export interface ListMessagesApiInput {
  userId: string;
  conversationId: string;
  limit?: number;
  cursor?: string;
}

/** Result of {@link ChatpackApi.listMessages}. */
export interface ListMessagesApiResult {
  /** Newest-first (descending `seq`), with `replyTo` and `reactions` hydrated. */
  messages: MessageWithDetails[];
  nextCursor: string | null;
}

/** Input for {@link ChatpackApi.searchMessages}. */
export interface SearchMessagesApiInput {
  userId: string;
  /** Plain-text terms to search for, case-insensitively. */
  query: string;
  limit?: number;
  cursor?: string;
}

/** Result of {@link ChatpackApi.searchMessages}. */
export interface SearchMessagesApiResult {
  messages: MessageWithDetails[];
  nextCursor: string | null;
}

/** Input for {@link ChatpackApi.editMessage}. */
export interface EditMessageInput {
  userId: string;
  messageId: string;
  /** The new body. Must be non-empty. */
  body: string;
  /**
   * The **complete** new mention set, replacing what was stored
   * (`docs/decisions/0023` §3). Pass `[]` to clear.
   *
   * **Omit it and the stored mentions are left alone** - a client that edits a
   * body without knowing about mentions cannot silently erase them.
   *
   * Only ids that are *new* to this edit are membership-checked. Ones already
   * stored are grandfathered, so fixing a typo in a message that mentioned
   * someone who has since left still works.
   */
  mentions?: string[];
}

/** Input for {@link ChatpackApi.deleteMessage}. */
export interface DeleteMessageInput {
  userId: string;
  messageId: string;
}

/** Input for {@link ChatpackApi.markRead}. */
export interface MarkReadInput {
  userId: string;
  conversationId: string;
  /** The last message the user has read. */
  messageId: string;
}

/** Input for {@link ChatpackApi.listMessagesAfter}. */
export interface ListMessagesAfterInput {
  userId: string;
  conversationId: string;
  /** Return messages with `seq` strictly greater than this. */
  afterSeq: number;
  /** Max messages to return. */
  limit?: number;
}

/** Input for {@link ChatpackApi.addReaction} and {@link ChatpackApi.removeReaction}. */
export interface ReactionApiInput {
  /** The reacting user. A caller can only ever react as themselves. */
  userId: string;
  messageId: string;
  /**
   * The reaction key: any non-empty string, trimmed, up to 32 characters
   * (ADR 0013 §3). Not validated as an emoji.
   */
  emoji: string;
}

/** Input for {@link ChatpackApi.createInvite} (ADR 0019). */
export interface CreateInviteApiInput {
  /** The acting user. Must satisfy `canInvite` (admin by default). */
  userId: string;
  conversationId: string;
  /**
   * Lifetime in seconds from now. Omit for an invite that never expires.
   * Must be a positive integer.
   */
  expiresInSeconds?: number;
  /**
   * How many times the link may be redeemed. Omit for unlimited. Must be a
   * positive integer.
   */
  maxUses?: number;
  /**
   * When `true`, redeeming this link creates a pending join request for an
   * admin to resolve instead of joining outright. Defaults to `false`.
   */
  requiresApproval?: boolean;
  metadata?: Metadata;
}

/** Input for {@link ChatpackApi.listInvites} (ADR 0019). */
export interface ListInvitesApiInput {
  /** The acting user. Must be able to manage the conversation. */
  userId: string;
  conversationId: string;
}

/** Input for {@link ChatpackApi.revokeInvite} (ADR 0019). */
export interface RevokeInviteApiInput {
  /** The acting user. Must be able to manage the conversation. */
  userId: string;
  conversationId: string;
  /** The code to revoke. Revoking an unknown code is a silent no-op. */
  code: string;
}

/** Input for {@link ChatpackApi.getInvitePreview} and {@link ChatpackApi.acceptInvite}. */
export interface InviteCodeApiInput {
  /** The acting user. Any authenticated user may preview or accept. */
  userId: string;
  code: string;
}

/** Input for {@link ChatpackApi.acceptInvite} (ADR 0019). */
export interface AcceptInviteApiInput extends InviteCodeApiInput {
  /**
   * A note for the admins, used only when the invite requires approval.
   * Trimmed, at most {@link MAX_JOIN_REQUEST_MESSAGE_LENGTH} characters.
   */
  message?: string;
}

/**
 * What accepting an invite produced (ADR 0019 §4): either membership, or a
 * request awaiting approval. `status` discriminates the two, so a client never
 * has to guess which happened from which field is null.
 */
export type AcceptInviteResult =
  | {
      status: "joined";
      /** The group, now including the caller. */
      conversation: ConversationWithUnread;
      joinRequest: null;
    }
  | {
      status: "pending";
      /** Not yet a member, so no conversation is returned. */
      conversation: null;
      /** The pending request an admin must resolve. */
      joinRequest: JoinRequest;
    };

/** Input for {@link ChatpackApi.requestToJoin} (ADR 0019). */
export interface RequestToJoinApiInput {
  /** The requesting user. Must not already be a participant. */
  userId: string;
  conversationId: string;
  /**
   * An optional note for the admins. Trimmed, at most
   * {@link MAX_JOIN_REQUEST_MESSAGE_LENGTH} characters.
   */
  message?: string;
}

/** Input for {@link ChatpackApi.listJoinRequests} (ADR 0019). */
export interface ListJoinRequestsApiInput {
  /** The acting user. Must be able to manage the conversation. */
  userId: string;
  conversationId: string;
  /** Only requests in this state. Defaults to `"pending"` - the moderation queue. */
  status?: JoinRequestStatus;
  limit?: number;
}

/** Input for {@link ChatpackApi.resolveJoinRequest} (ADR 0019). */
export interface ResolveJoinRequestApiInput {
  /** The acting user. Must be able to manage the conversation. */
  userId: string;
  conversationId: string;
  /** Whose request to resolve - one pending request per user per group. */
  targetUserId: string;
  decision: "approve" | "deny";
}

/** Result of {@link ChatpackApi.resolveJoinRequest} (ADR 0019). */
export interface ResolveJoinRequestApiResult {
  /** The resolved request, now `approved` or `denied`. */
  joinRequest: JoinRequest;
  /**
   * The group including its new member, or `null` when the request was denied.
   */
  conversation: ConversationWithUnread | null;
}

/** Input for {@link ChatpackApi.listPublicConversations} (ADR 0020). */
export interface ListPublicConversationsApiInput {
  /**
   * The acting user. Any authenticated user may browse; the id is used only to
   * fill in `alreadyParticipant` and `requestPending` on each row.
   */
  userId: string;
  limit?: number;
  cursor?: string;
}

/** Result of {@link ChatpackApi.listPublicConversations} (ADR 0020). */
export interface ListPublicConversationsApiResult {
  /** Thin previews, most-recently-active first. Never participant ids. */
  channels: ChannelPreview[];
  nextCursor: string | null;
}

/** Input for {@link ChatpackApi.joinConversation} (ADR 0020). */
export interface JoinConversationApiInput {
  /** The joining user. Must not already be a participant. */
  userId: string;
  /** The public channel to join. Private groups and DMs are refused. */
  conversationId: string;
  /**
   * A note for the admins, used only when the channel's `joinPolicy` is
   * `"approval"`. Trimmed, at most {@link MAX_JOIN_REQUEST_MESSAGE_LENGTH}
   * characters.
   */
  message?: string;
}

/**
 * What joining a channel produced (ADR 0020 §5): either membership, or a
 * request awaiting approval. Deliberately the same shape as
 * {@link AcceptInviteResult} - a client that can render one can render the
 * other, because from the joiner's side the two paths are the same event.
 */
export type JoinConversationResult =
  | {
      status: "joined";
      /** The channel, now including the caller. */
      conversation: ConversationWithUnread;
      joinRequest: null;
    }
  | {
      status: "pending";
      /** Not yet a member, so no conversation is returned. */
      conversation: null;
      /** The pending request an admin must resolve. */
      joinRequest: JoinRequest;
    };

/**
 * The server-side core API. Every method takes the acting `userId` explicitly
 * and enforces permissions at the core boundary around storage access.
 */
export interface ChatpackApi {
  /** Durable user and moderator controls. */
  moderation: ModerationApi;
  /**
   * Find or create the direct conversation between `userId` and
   * `otherUserId`. Idempotent per user pair.
   */
  getOrCreateConversation(input: GetOrCreateConversationInput): Promise<ConversationWithUnread>;

  /**
   * Create a group conversation with `userId` as its first admin
   * (`docs/decisions/0017`).
   *
   * **Not** idempotent, unlike {@link ChatpackApi.getOrCreateConversation}: two
   * groups with the same members are two distinct groups.
   */
  createGroupConversation(input: CreateGroupConversationApiInput): Promise<ConversationWithUnread>;

  /**
   * Add members to a group. Requires manage permission (admin by default).
   * Ids that are already members are skipped silently, so a replayed request
   * is harmless.
   */
  addParticipants(input: AddParticipantsApiInput): Promise<ConversationWithUnread>;

  /**
   * Remove a member from a group, or leave it (`targetUserId === userId`).
   * Removing someone else requires manage permission; leaving never does.
   *
   * Throws `LAST_ADMIN_REMAINING` if this would leave the group with no admin -
   * promote someone first. Removing a non-member is a silent no-op.
   */
  removeParticipant(input: RemoveParticipantApiInput): Promise<ConversationWithUnread>;

  /**
   * Promote or demote a member. Requires manage permission. Demoting the only
   * admin throws `LAST_ADMIN_REMAINING`.
   */
  setParticipantRole(input: SetParticipantRoleApiInput): Promise<ConversationWithUnread>;

  /**
   * Rename a group (or clear its name with `null`). Requires manage
   * permission. Throws `NOT_GROUP_CONVERSATION` for a DM.
   */
  updateConversation(input: UpdateConversationApiInput): Promise<ConversationWithUnread>;

  /** List the conversations `userId` participates in, most-recently-active first. */
  listConversations(input: ListConversationsApiInput): Promise<ListConversationsApiResult>;

  /**
   * Fetch one conversation. Requires read permission. Throws
   * `CONVERSATION_NOT_FOUND` for unknown ids - unlike
   * `StorageAdapter.getConversation`, it never resolves to `null`.
   */
  getConversation(input: GetConversationInput): Promise<ConversationWithUnread>;

  /** Send a text message, optionally quote-replying to another. Requires write permission. */
  sendMessage(input: SendMessageInput): Promise<MessageWithDetails>;

  /** List messages newest-first with cursor pagination. Requires read permission. */
  listMessages(input: ListMessagesApiInput): Promise<ListMessagesApiResult>;

  /** Search non-tombstone messages in the user's participant conversations. */
  searchMessages(input: SearchMessagesApiInput): Promise<SearchMessagesApiResult>;

  /** Edit a message's body. Only the original sender may edit. */
  editMessage(input: EditMessageInput): Promise<MessageWithDetails>;

  /**
   * Copy a message into another conversation, keeping frozen provenance
   * (`docs/decisions/0024`).
   *
   * The returned message is the **new** one in the target conversation: a real
   * message with its own `seq`, sent by the forwarder, whose body is a verbatim
   * copy. Needs `canRead` on the source and `canWrite` on the target. Nothing is
   * published to the source - being forwarded is not an event it can act on, and
   * saying so would leak that the target exists.
   */
  forwardMessage(input: ForwardMessageInput): Promise<MessageWithDetails>;

  /** Soft-delete a message. Only the original sender may delete. */
  deleteMessage(input: DeleteMessageInput): Promise<MessageWithDetails>;

  /**
   * React to a message as `userId` (`docs/decisions/0013`). Idempotent -
   * reacting twice with the same emoji leaves one reaction. Requires write
   * permission, like editing: it is a mutation the other participant sees.
   */
  addReaction(input: ReactionApiInput): Promise<MessageWithDetails>;

  /**
   * Remove one of `userId`'s own reactions. Idempotent - removing a reaction
   * that was never there is a silent no-op.
   */
  removeReaction(input: ReactionApiInput): Promise<MessageWithDetails>;

  /**
   * Update the caller's durable read-state in a conversation. Monotonic:
   * marking a message older than the current read-state is a silent no-op
   * (tolerates out-of-order client replays; never regresses unread counts).
   */
  markRead(input: MarkReadInput): Promise<void>;

  /**
   * Messages in a conversation with `seq` greater than `afterSeq`, oldest
   * first, with `replyTo` and `reactions` hydrated so a replayed frame is
   * indistinguishable from a live one. Used for SSE reconnection gap-fill
   * (MVP §9); requires read permission.
   */
  listMessagesAfter(input: ListMessagesAfterInput): Promise<MessageWithDetails[]>;

  /**
   * Mint a shareable invite link for a group (`docs/decisions/0019`). Requires
   * `canInvite` (admin by default).
   *
   * The returned `code` is the secret - hand the whole object to the admin who
   * asked, and build your own URL around it (Chatpack does not know your
   * frontend's routes). Throws `INVITES_UNSUPPORTED` if the storage adapter has
   * no `invites` capability, and `NOT_GROUP_CONVERSATION` for a DM.
   */
  createInvite(input: CreateInviteApiInput): Promise<ConversationInvite>;

  /**
   * All of a group's invites, newest-first, including expired and exhausted
   * ones so they can be cleaned up. Requires manage permission.
   */
  listInvites(input: ListInvitesApiInput): Promise<ConversationInvite[]>;

  /**
   * Revoke an invite. Requires manage permission. Idempotent - revoking a code
   * that does not exist (or belongs to another group) is a silent no-op.
   */
  revokeInvite(input: RevokeInviteApiInput): Promise<void>;

  /**
   * What an invite admits you to, before you accept (`docs/decisions/0019`
   * §10). Any authenticated user holding the code may call this.
   *
   * Deliberately minimal - a name and a participant *count*, never the
   * participant ids: this is the one route reachable by non-members, so
   * returning the conversation would leak the whole membership list to anyone
   * with a link. Throws `INVITE_NOT_FOUND`, or `INVITE_EXPIRED` when the code
   * is past its expiry or use cap.
   */
  getInvitePreview(input: InviteCodeApiInput): Promise<InvitePreview>;

  /**
   * Redeem an invite: join the group, or create a pending join request when the
   * invite has `requiresApproval` (`docs/decisions/0019` §4). Check `status` on
   * the result to tell which happened.
   *
   * Idempotent for a caller who is already a participant: returns the
   * conversation and does **not** consume a use.
   */
  acceptInvite(input: AcceptInviteApiInput): Promise<AcceptInviteResult>;

  /**
   * Ask to join a group by id, without an invite (`docs/decisions/0019`).
   * Throws `ALREADY_PARTICIPANT` if the caller is already in it.
   *
   * Note this requires no permission check by design: asking is not entering,
   * and an admin decides. Gate discovery in your own app if a group's id
   * should not be guessable.
   */
  requestToJoin(input: RequestToJoinApiInput): Promise<JoinRequest>;

  /**
   * A group's join requests, newest-first, `pending` by default. Requires
   * manage permission. This is the moderation queue - Chatpack publishes no
   * event when a request arrives, so poll it (ADR 0019 §6).
   */
  listJoinRequests(input: ListJoinRequestsApiInput): Promise<JoinRequest[]>;

  /**
   * Approve or deny a pending join request (`docs/decisions/0019`). Requires
   * manage permission. Approving adds the user as a `member` and publishes
   * `participant.added`, exactly as an admin-initiated add would.
   *
   * Throws `JOIN_REQUEST_NOT_FOUND` when there is no pending request for that
   * user - including when it has already been resolved, so two admins racing
   * on the same request cannot both apply it.
   */
  resolveJoinRequest(input: ResolveJoinRequestApiInput): Promise<ResolveJoinRequestApiResult>;

  /**
   * Browse public channels (`docs/decisions/0020`), most-recently-active first.
   * Any authenticated user may call this; there is no permission hook, because
   * "public" is the permission.
   *
   * Returns {@link ChannelPreview}s, not conversations: the directory is the
   * widest-reaching read in Chatpack, so it carries a participant *count* and
   * never ids - the same reasoning as {@link ChatpackApi.getInvitePreview},
   * applied to a bigger audience. Throws `CHANNELS_UNSUPPORTED` if the storage
   * adapter has no `channels` capability.
   */
  listPublicConversations(
    input: ListPublicConversationsApiInput,
  ): Promise<ListPublicConversationsApiResult>;

  /**
   * Join a public channel by id (`docs/decisions/0020` §5): admitted
   * immediately when its `joinPolicy` is `"open"`, or given a pending
   * {@link JoinRequest} when it is `"approval"`. Check `status` on the result.
   *
   * Throws `NOT_PUBLIC_CONVERSATION` for a private group or a DM,
   * `ALREADY_PARTICIPANT` when the caller is already in, and
   * `GROUP_LIMIT_EXCEEDED` when the channel is full. An `"approval"` channel
   * also needs the `invites` capability, since the queue lives there.
   */
  joinConversation(input: JoinConversationApiInput): Promise<JoinConversationResult>;
}

/** The object returned by {@link chatpack}. */
export interface ChatpackInstance {
  /** The server-side core API. */
  api: ChatpackApi;
  /**
   * Mount the whole REST API on one route (M2). Web-standard
   * `Request`/`Response`, so it works on Next.js App Router, Bun, Deno, and
   * Workers alike. Requires the `auth` option.
   *
   * @example Next.js App Router
   * ```ts
   * // app/api/chat/[...chatpack]/route.ts
   * import { chat } from "@/lib/chat";
   * export const { GET, POST, PATCH, DELETE, PUT } = chat.handler();
   * ```
   */
  handler(options?: HandlerOptions): ChatpackHandler;
  /**
   * The live-event transport (M3). Defaults to the single-node in-process
   * implementation; the SSE endpoint subscribes to it.
   */
  transport: Transport;
  /** In-process anonymous telemetry counters (MVP §12). */
  telemetry: TelemetryCounters;
  /** The options this instance was created with (used by handlers in M2+). */
  options: ChatpackOptions;
}

/**
 * Create a Chatpack instance - the single entry point of `@chatpack/core`.
 *
 * @example
 * ```ts
 * import { chatpack } from "@chatpack/core";
 * import { memoryAdapter } from "@chatpack/adapter-memory";
 *
 * export const chat = chatpack({
 *   storage: memoryAdapter(),
 *   auth: async (req) => getSessionUser(req),
 * });
 * ```
 */
export function chatpack(options: ChatpackOptions): ChatpackInstance {
  if (options.hooks?.afterMessageMutation && options.hooks.afterMessageSend) {
    throw new ChatpackError(
      "INVALID_INPUT",
      "Configure either hooks.afterMessageMutation or the deprecated hooks.afterMessageSend, not both.",
    );
  }

  const storage: StorageAdapter = options.storage;
  const moderationStorage: ModerationStorage | undefined = storage.moderation;
  // Enforcing bans costs a lookup on every call and on every SSE heartbeat, so
  // it follows the *host's* config, not the adapter's capability: `banUser` is
  // the only way to mint a ban and it needs `canModerate`, so an adapter that
  // merely can store bans has none to find. `enforceBans` opts in explicitly
  // for hosts that write ban rows outside Chatpack.
  const banEnforcement: ModerationStorage | null =
    moderationStorage &&
    (options.moderation?.enforceBans ?? options.moderation?.canModerate !== undefined)
      ? moderationStorage
      : null;
  const transport: Transport = options.transport ?? inProcessTransport();
  const telemetry = new TelemetryCounters(resolveTelemetryEnabled(options.telemetry));
  // Fire-and-forget aggregate flush (MVP §12). No-op when disabled; the timer
  // is unref'd, so it never keeps the process alive.
  startTelemetryFlusher(telemetry);

  const defaultPermission = (ctx: PermissionContext): boolean =>
    ctx.conversation.participantIds.includes(ctx.user.id);

  const canRead = options.permissions?.canRead ?? defaultPermission;
  const canWrite = options.permissions?.canWrite ?? defaultPermission;
  // Manage authority is admin-only by default (ADR 0017 §3) - a strictly
  // narrower default than read/write, so it cannot be the shared
  // `defaultPermission`.
  const canManage =
    options.permissions?.canManage ??
    ((ctx: PermissionContext): boolean =>
      ctx.conversation.participants.some((p) => p.userId === ctx.user.id && p.role === "admin"));
  // Minting a link defaults to the same admin authority as managing (ADR 0019
  // §8) - it falls back to `canManage` rather than the admin literal so that
  // configuring only `canManage` keeps invites consistent with it.
  const canInvite = options.permissions?.canInvite ?? canManage;

  function requireModerationStorage(): ModerationStorage {
    if (!moderationStorage) {
      throw new ChatpackError(
        "MODERATION_UNSUPPORTED",
        "This storage adapter does not provide moderation persistence.",
      );
    }
    return moderationStorage;
  }

  async function requireActiveUser(userId: string): Promise<void> {
    const activeStorage = banEnforcement;
    if (!activeStorage) return;
    const ban = await activeStorage.isUserBanned(userId);
    if (ban) {
      throw new ChatpackError("USER_BANNED", `User "${userId}" has an active Chatpack ban.`);
    }
  }

  /**
   * Checks ids in bounded batches rather than one at a time, so creating a
   * 50-member group costs a handful of round trips instead of 50. The cap
   * matters as much as the parallelism: a 256-member group must not open 256
   * simultaneous queries against a host pool that is usually far smaller.
   *
   * The reported id is the first missing one in the caller's order, never the
   * first query to settle, so the same input always produces the same error.
   */
  async function requireKnownUsers(userIds: string[]): Promise<void> {
    const userExists = options.userExists;
    if (!userExists) return;
    const unique = [...new Set(userIds)];
    const missing = new Set<string>();
    for (let start = 0; start < unique.length; start += USER_EXISTS_CONCURRENCY) {
      const batch = unique.slice(start, start + USER_EXISTS_CONCURRENCY);
      const found = await Promise.all(batch.map((userId) => userExists(userId)));
      batch.forEach((userId, index) => {
        if (!found[index]) missing.add(userId);
      });
      // Batches follow caller order, so the earliest missing id overall is in
      // the first batch that reports one - no need to check the rest.
      if (missing.size > 0) break;
    }
    const first = userIds.find((userId) => missing.has(userId));
    if (first !== undefined) {
      throw new ChatpackError("USER_NOT_FOUND", `User "${first}" was not found.`);
    }
  }

  async function requireModerator(
    userId: string,
    action: ModerationAction,
    extra: { targetUserId?: string; reportId?: string; banId?: string } = {},
  ): Promise<void> {
    await requireActiveUser(userId);
    const allowed = await options.moderation?.canModerate?.({
      user: { id: userId },
      action,
      ...extra,
    });
    if (!allowed) {
      throw new ChatpackError("NOT_MODERATOR", "This action requires moderator access.");
    }
  }

  function normalizeModerationReason(value: string): string {
    if (typeof value !== "string" || value.trim() === "") {
      throw new ChatpackError("INVALID_INPUT", `"reason" must be a non-empty string.`);
    }
    const reason = value.trim();
    if (reason.length > MAX_MODERATION_REASON_LENGTH) {
      throw new ChatpackError(
        "INVALID_INPUT",
        `"reason" must be at most ${MAX_MODERATION_REASON_LENGTH} characters.`,
      );
    }
    return reason;
  }

  function normalizeOptionalModerationReason(value: string | null | undefined): string | null {
    if (value === undefined || value === null) return null;
    return normalizeModerationReason(value);
  }

  function normalizeModeratorNote(value: string | null | undefined): string | null {
    if (value === undefined || value === null) return null;
    if (typeof value !== "string") {
      throw new ChatpackError("INVALID_INPUT", `"moderatorNote" must be a string or null.`);
    }
    const note = value.trim();
    if (note.length > MAX_MODERATOR_NOTE_LENGTH) {
      throw new ChatpackError(
        "INVALID_INPUT",
        `"moderatorNote" must be at most ${MAX_MODERATOR_NOTE_LENGTH} characters.`,
      );
    }
    return note === "" ? null : note;
  }

  function normalizeReportStatus(value: ReportStatus): ReportStatus {
    if (value !== "open" && value !== "triaged" && value !== "resolved" && value !== "dismissed") {
      throw new ChatpackError(
        "INVALID_INPUT",
        `"status" must be "open", "triaged", "resolved", or "dismissed".`,
      );
    }
    return value;
  }

  function normalizeReportTargetType(value: ReportTargetType): ReportTargetType {
    if (value !== "user" && value !== "message" && value !== "conversation") {
      throw new ChatpackError(
        "INVALID_INPUT",
        `"targetType" must be "user", "message", or "conversation".`,
      );
    }
    return value;
  }

  function toPermissionContext(userId: string, conversation: Conversation): PermissionContext {
    const user: ChatpackUser = { id: userId };
    return {
      user,
      conversation: {
        ...conversation,
        participantIds: conversation.participants.map((p) => p.userId),
      },
    };
  }

  /** Everyone in the conversation except `userId` (ADR 0017 §5). */
  function recipientsExcluding(conversation: Conversation, userId: string): string[] {
    return conversation.participants
      .map((participant) => participant.userId)
      .filter((id) => id !== userId);
  }

  /**
   * Membership and rename only apply to groups: a DM's participants are fixed
   * by its `pairKey` (ADR 0002), and it has no name.
   */
  function requireGroup(conversation: Conversation): void {
    if (conversation.type !== "group") {
      throw new ChatpackError(
        "NOT_GROUP_CONVERSATION",
        `Conversation "${conversation.id}" is a direct conversation - membership and name are fixed.`,
      );
    }
  }

  async function requireManage(userId: string, conversation: Conversation): Promise<void> {
    const allowed = await canManage(toPermissionContext(userId, conversation));
    if (!allowed) {
      throw new ChatpackError(
        "NOT_CONVERSATION_ADMIN",
        `User "${userId}" may not administer conversation "${conversation.id}".`,
      );
    }
  }

  /** Invite creation has its own authority, defaulting to manage (ADR 0019 §8). */
  async function requireInvite(userId: string, conversation: Conversation): Promise<void> {
    const allowed = await canInvite(toPermissionContext(userId, conversation));
    if (!allowed) {
      throw new ChatpackError(
        "NOT_CONVERSATION_ADMIN",
        `User "${userId}" may not create invites for conversation "${conversation.id}".`,
      );
    }
  }

  /**
   * The adapter's invite capability, or `INVITES_UNSUPPORTED` (ADR 0019 §2).
   *
   * One namespace rather than nine optional methods, so this single check
   * covers every invite route - a partially-implemented capability cannot exist.
   */
  function requireInviteStorage() {
    const invites = storage.invites;
    if (!invites) {
      throw new ChatpackError(
        "INVITES_UNSUPPORTED",
        "Invite links and join requests are not supported by this storage adapter.",
      );
    }
    return invites;
  }

  /**
   * The adapter's channel capability, or `CHANNELS_UNSUPPORTED` (ADR 0020 §4).
   *
   * Gates the directory query *and* every write of a non-default `visibility` or
   * `joinPolicy`. The second one is the important one: those are plain fields on
   * an input object, so a pre-0020 adapter accepts them and drops them silently -
   * you would create a public channel, get a 201, and never find it in any
   * directory. Failing at the write turns that into an error the developer sees
   * once, rather than a channel their users can't reach.
   */
  function requireChannelStorage() {
    const channels = storage.channels;
    if (!channels) {
      throw new ChatpackError(
        "CHANNELS_UNSUPPORTED",
        "Public channels are not supported by this storage adapter.",
      );
    }
    return channels;
  }

  /** Validate a {@link ChannelVisibility}, falling back to `fallback`. */
  function normalizeVisibility(
    value: ChannelVisibility | undefined,
    fallback: ChannelVisibility,
  ): ChannelVisibility {
    if (value === undefined) return fallback;
    if (value !== "private" && value !== "public") {
      throw new ChatpackError(
        "INVALID_INPUT",
        `"visibility" must be "private" or "public", got ${JSON.stringify(value)}.`,
      );
    }
    return value;
  }

  /**
   * Validate a {@link ChannelJoinPolicy}, falling back to `fallback`.
   *
   * New conversations fall back to `"approval"`, the safer of the two: between
   * "a stranger is in the room" and "a stranger is in a queue", only one is
   * recoverable (ADR 0020 §3).
   */
  function normalizeJoinPolicy(
    value: ChannelJoinPolicy | undefined,
    fallback: ChannelJoinPolicy,
  ): ChannelJoinPolicy {
    if (value === undefined) return fallback;
    if (value !== "open" && value !== "approval") {
      throw new ChatpackError(
        "INVALID_INPUT",
        `"joinPolicy" must be "open" or "approval", got ${JSON.stringify(value)}.`,
      );
    }
    return value;
  }

  /**
   * Resolve `visibility`/`joinPolicy` against the current (or default) values,
   * requiring the `channels` capability only when the result is not the
   * all-private default (ADR 0020 §4).
   *
   * Keyed on the resolved values, not on which fields were present: a client
   * that always sends `visibility: "private"` must keep working on an adapter
   * with no `channels` capability, because nothing it asked for needs one.
   */
  function resolveChannelFields(
    visibility: ChannelVisibility | undefined,
    joinPolicy: ChannelJoinPolicy | undefined,
    current: { visibility: ChannelVisibility; joinPolicy: ChannelJoinPolicy } = {
      visibility: "private",
      joinPolicy: "approval",
    },
  ): { visibility: ChannelVisibility; joinPolicy: ChannelJoinPolicy } {
    const resolved = {
      visibility: normalizeVisibility(visibility, current.visibility),
      joinPolicy: normalizeJoinPolicy(joinPolicy, current.joinPolicy),
    };
    const changed =
      resolved.visibility !== current.visibility || resolved.joinPolicy !== current.joinPolicy;
    const nonDefault = resolved.visibility !== "private" || resolved.joinPolicy !== "approval";
    if (changed && nonDefault) requireChannelStorage();
    return resolved;
  }

  /** Validate the optional note on a join request (ADR 0019). */
  function normalizeJoinMessage(value: string | null | undefined): string | null {
    if (value === undefined || value === null) return null;
    if (typeof value !== "string") {
      throw new ChatpackError("INVALID_INPUT", `"message" must be a string or null.`);
    }
    const message = value.trim();
    if (message === "") return null;
    if (message.length > MAX_JOIN_REQUEST_MESSAGE_LENGTH) {
      throw new ChatpackError(
        "INVALID_INPUT",
        `"message" must be at most ${MAX_JOIN_REQUEST_MESSAGE_LENGTH} characters, got ${message.length}.`,
      );
    }
    return message;
  }

  /** Validate a positive-integer invite limit (`expiresInSeconds`, `maxUses`). */
  function normalizePositiveInt(value: number | undefined, field: string): number | null {
    if (value === undefined || value === null) return null;
    if (!Number.isInteger(value) || value < 1) {
      throw new ChatpackError(
        "INVALID_INPUT",
        `"${field}" must be a positive integer, got ${value}.`,
      );
    }
    return value;
  }

  /**
   * Whether an invite is still redeemable. Core checks this for the preview and
   * for the already-participant shortcut; the authoritative check lives in the
   * adapter's atomic `consumeInvite`, because only one statement can decide a
   * race (ADR 0019 §2).
   */
  function isInviteUsable(invite: ConversationInvite): boolean {
    if (invite.expiresAt !== null && invite.expiresAt.getTime() <= Date.now()) return false;
    if (invite.maxUses !== null && invite.uses >= invite.maxUses) return false;
    return true;
  }

  /** Load an invite by code, or throw 404 (ADR 0019 §9). */
  async function requireInviteByCode(code: string): Promise<ConversationInvite> {
    const invites = requireInviteStorage();
    requireNonEmptyId(code, "code");
    const invite = await invites.getInvite(code);
    if (!invite) {
      throw new ChatpackError("INVITE_NOT_FOUND", "That invite link is not valid.");
    }
    return invite;
  }

  /**
   * Throw 410 for an expired or exhausted invite.
   *
   * Kept separate from the 404 lookup so `acceptInvite` can take its idempotent
   * shortcuts first: someone who has already joined - or already has a pending
   * request - must get their truthful success value back even once the link they
   * used is spent, or a double-clicked one-use link answers 410 to the very
   * person it admitted (ADR 0019 §5).
   */
  function assertInviteUsable(invite: ConversationInvite): void {
    if (isInviteUsable(invite)) return;
    throw new ChatpackError(
      "INVITE_EXPIRED",
      invite.maxUses !== null && invite.uses >= invite.maxUses
        ? "That invite link has already been used the maximum number of times."
        : "That invite link has expired.",
    );
  }

  /** Load an invite by code, or throw 404/410 (ADR 0019 §9). */
  async function requireUsableInvite(code: string): Promise<ConversationInvite> {
    const invite = await requireInviteByCode(code);
    assertInviteUsable(invite);
    return invite;
  }

  /**
   * Room for one more member? Checked against a fresh read rather than the
   * caller's earlier one: an invite can sit unredeemed while the group fills up.
   *
   * `acceptInvite` calls this *before* consuming a use, so redeeming into a full
   * group costs the link nothing.
   */
  function assertGroupHasRoom(conversation: Conversation): void {
    if (conversation.participants.length + 1 > MAX_GROUP_PARTICIPANTS) {
      throw new ChatpackError(
        "GROUP_LIMIT_EXCEEDED",
        `A group may hold at most ${MAX_GROUP_PARTICIPANTS} participants, got ${conversation.participants.length + 1}.`,
      );
    }
  }

  /**
   * Add one approved/invited user to a group and publish `participant.added` -
   * the shared tail of `acceptInvite` and an approved `resolveJoinRequest`.
   *
   * Reuses the ADR 0017 event on purpose: joining by link and being added by an
   * admin are the same change to the same list, so members and the joiner get
   * the same live update either way (ADR 0019 §6).
   */
  async function admitToGroup(
    conversation: Conversation,
    userId: string,
    actorId: string,
  ): Promise<Conversation> {
    assertGroupHasRoom(conversation);
    const updated = await storage.addParticipants({
      conversationId: conversation.id,
      userIds: [userId],
    });
    publishConversation(
      "participant.added",
      updated,
      actorId,
      [userId],
      updated.participants.map((p) => p.userId),
    );
    return updated;
  }

  /**
   * Validate a group name: trimmed, non-empty, length-capped (ADR 0017 §1).
   * `null`/`undefined` means "no name", which is legitimate for a group.
   */
  function normalizeGroupName(value: string | null | undefined): string | null {
    if (value === undefined || value === null) return null;
    if (typeof value !== "string") {
      throw new ChatpackError("INVALID_INPUT", `"name" must be a string or null.`);
    }
    const name = value.trim();
    if (name === "") {
      throw new ChatpackError(
        "INVALID_INPUT",
        `"name" must be non-empty when provided - pass null to clear it.`,
      );
    }
    if (name.length > MAX_CONVERSATION_NAME_LENGTH) {
      throw new ChatpackError(
        "INVALID_INPUT",
        `"name" must be at most ${MAX_CONVERSATION_NAME_LENGTH} characters, got ${name.length}.`,
      );
    }
    return name;
  }

  /**
   * De-duplicate a member id list and validate each entry, dropping ids in
   * `exclude` (the creator on create, existing members on add). Duplicates are
   * dropped rather than rejected - a client sending the same id twice means one
   * member, not an error.
   */
  function normalizeUserIds(userIds: unknown, field: string, exclude: Set<string> = new Set()) {
    if (userIds === undefined) return [];
    if (!Array.isArray(userIds)) {
      throw new ChatpackError("INVALID_INPUT", `"${field}" must be an array of user ids.`);
    }
    const seen = new Set<string>();
    for (const id of userIds) {
      requireNonEmptyId(id, `${field}[]`);
      if (!exclude.has(id)) seen.add(id);
    }
    return [...seen];
  }

  /**
   * Enforce "a group always has at least one admin" (ADR 0017 §3).
   *
   * Chatpack refuses rather than auto-promoting: every selection rule (oldest
   * member? next in insertion order?) is a policy decision the application
   * owns. `nextRoles` is the membership as it would be after the change.
   */
  function requireAdminRemains(
    conversation: Conversation,
    nextRoles: { userId: string; role: ParticipantRole }[],
  ): void {
    if (nextRoles.some((participant) => participant.role === "admin")) return;
    throw new ChatpackError(
      "LAST_ADMIN_REMAINING",
      `Conversation "${conversation.id}" must keep at least one admin - promote another member first.`,
    );
  }

  async function requireConversation(conversationId: string): Promise<Conversation> {
    const conversation = await storage.getConversation(conversationId);
    if (!conversation) {
      throw new ChatpackError(
        "CONVERSATION_NOT_FOUND",
        `Conversation "${conversationId}" was not found.`,
      );
    }
    return conversation;
  }

  async function requireDirectInteractionAllowed(
    userId: string,
    conversation: Conversation,
  ): Promise<void> {
    if (conversation.type !== "direct" || !moderationStorage) return;
    const otherUserId = conversation.participants.find((p) => p.userId !== userId)?.userId;
    if (otherUserId && (await moderationStorage.isBlocked(userId, otherUserId))) {
      throw new ChatpackError(
        "DIRECT_INTERACTION_BLOCKED",
        "Direct interaction is blocked by one of the participants.",
      );
    }
  }

  async function requireRead(userId: string, conversation: Conversation): Promise<void> {
    const allowed = await canReadConversation(userId, conversation);
    if (!allowed) {
      throw new ChatpackError(
        "FORBIDDEN_READ",
        `User "${userId}" may not read conversation "${conversation.id}".`,
      );
    }
  }

  async function canReadConversation(userId: string, conversation: Conversation): Promise<boolean> {
    return canRead(toPermissionContext(userId, conversation));
  }

  async function requireWrite(userId: string, conversation: Conversation): Promise<void> {
    const allowed = await canWrite(toPermissionContext(userId, conversation));
    if (!allowed) {
      throw new ChatpackError(
        "FORBIDDEN_WRITE",
        `User "${userId}" may not write to conversation "${conversation.id}".`,
      );
    }
  }

  function normalizeLimit(limit: number | undefined): number {
    if (limit === undefined) return DEFAULT_LIMIT;
    if (!Number.isInteger(limit) || limit < 1) {
      throw new ChatpackError("INVALID_INPUT", `"limit" must be a positive integer, got ${limit}.`);
    }
    return Math.min(limit, MAX_LIMIT);
  }

  function requireNonEmptyId(value: string, field: string): void {
    if (typeof value !== "string" || value.trim() === "") {
      throw new ChatpackError("INVALID_INPUT", `"${field}" must be a non-empty string.`);
    }
  }

  /**
   * Decorate conversations with the viewer's `unreadCount` - one batched
   * `countUnread` call per page. Missing keys mean 0 (adapters may omit
   * conversations with nothing unread).
   */
  async function withUnread(
    userId: string,
    conversations: Conversation[],
  ): Promise<ConversationWithUnread[]> {
    if (conversations.length === 0) return [];
    const counts = await storage.countUnread({
      userId,
      conversationIds: conversations.map((c) => c.id),
    });
    return conversations.map((c) => ({ ...c, unreadCount: counts[c.id] ?? 0 }));
  }

  async function withUnreadOne(
    userId: string,
    conversation: Conversation,
  ): Promise<ConversationWithUnread> {
    const [decorated] = await withUnread(userId, [conversation]);
    return decorated as ConversationWithUnread;
  }

  /** Publish a live event. Durable-first: storage write has already succeeded. */
  function publish(
    type: ChatEvent["type"],
    conversation: Conversation,
    message: MessageWithDetails,
  ): void {
    transport.publish({
      type,
      conversationId: conversation.id,
      recipientIds: conversation.participants.map((p) => p.userId),
      message,
    });
  }

  /**
   * Publish a membership or rename change (ADR 0017 §4). Carries the full
   * post-change conversation, and no `id:` frame is emitted for it - a
   * membership change allocates no `seq`, so it must not disturb gap-fill.
   */
  function publishConversation(
    type: ConversationEvent["type"],
    conversation: Conversation,
    actorId: string,
    affectedUserIds: string[],
    recipientIds: string[],
  ): void {
    transport.publish({
      type,
      conversationId: conversation.id,
      recipientIds,
      actorId,
      affectedUserIds,
      conversation,
    });
  }

  /** Validate a reaction key: non-empty after trimming, at most 32 chars. */
  function normalizeEmoji(value: string): string {
    if (typeof value !== "string" || value.trim() === "") {
      throw new ChatpackError("INVALID_INPUT", `"emoji" must be a non-empty string.`);
    }
    // Trim so "👍" and "👍 " can't become two separate buckets (ADR 0013 §3).
    const emoji = value.trim();
    if (emoji.length > MAX_EMOJI_LENGTH) {
      throw new ChatpackError(
        "INVALID_INPUT",
        `"emoji" must be at most ${MAX_EMOJI_LENGTH} characters, got ${emoji.length}.`,
      );
    }
    return emoji;
  }

  /** Build the read-only preview of a quoted parent message (ADR 0013 §1). */
  function toReference(parent: Message): MessageReference {
    const deleted = parent.deletedAt !== null;
    return {
      id: parent.id,
      senderId: parent.senderId,
      // A tombstone has an empty body already; be explicit so a future adapter
      // that keeps the text on delete still can't leak it through a quote.
      excerpt: deleted
        ? ""
        : parent.body.length > EXCERPT_LENGTH
          ? `${parent.body.slice(0, EXCERPT_LENGTH)}…`
          : parent.body,
      deleted,
    };
  }

  /** Group raw reaction rows by emoji, preserving earliest-first reactor order. */
  function summarize(reactions: Reaction[]): ReactionSummary[] {
    const byEmoji = new Map<string, ReactionSummary>();
    for (const reaction of reactions) {
      const existing = byEmoji.get(reaction.emoji);
      if (existing) {
        existing.count += 1;
        existing.userIds.push(reaction.userId);
      } else {
        byEmoji.set(reaction.emoji, {
          emoji: reaction.emoji,
          count: 1,
          userIds: [reaction.userId],
        });
      }
    }
    return [...byEmoji.values()];
  }

  /**
   * Assemble a forward's provenance from the stored columns (ADR 0024 §2).
   *
   * Pure - no storage call, nothing to go stale, and no permission question,
   * because the three ids were frozen when the forward was written. The columns
   * move together, so one being set is enough to treat the message as a forward;
   * the guard is written over all three anyway so a half-written row from a
   * hand-edited database degrades to `null` instead of a partial object.
   */
  function toForwardProvenance(message: Message): ForwardProvenance | null {
    if (
      message.forwardedFromMessageId === null ||
      message.forwardedFromConversationId === null ||
      message.forwardedFromSenderId === null
    ) {
      return null;
    }
    return {
      messageId: message.forwardedFromMessageId,
      conversationId: message.forwardedFromConversationId,
      senderId: message.forwardedFromSenderId,
    };
  }

  /**
   * Decorate messages with `replyTo` previews, `reactions` and `mentions`
   * (ADR 0013, ADR 0023 §4): at most three batched storage calls for the whole
   * page, and none at all for a page with no replies, reactions or mentions.
   *
   * `forwardedFrom` is assembled inline rather than fetched - it is stored on the
   * row, which is the whole point of ADR 0024 §2.
   */
  async function withDetails(messages: Message[]): Promise<MessageWithDetails[]> {
    if (messages.length === 0) return [];

    const parentIds = [
      ...new Set(
        messages
          .map((message) => message.replyToMessageId)
          .filter((id): id is string => id !== null),
      ),
    ];
    const messageIds = messages.map((message) => message.id);
    const [parents, reactions, mentions] = await Promise.all([
      parentIds.length === 0 ? Promise.resolve([]) : storage.getMessagesByIds(parentIds),
      storage.listReactionsByMessageIds(messageIds),
      storage.listMentionsByMessageIds(messageIds),
    ]);

    const parentsById = new Map(parents.map((parent) => [parent.id, parent]));
    const reactionsByMessage = new Map<string, Reaction[]>();
    for (const reaction of reactions) {
      const list = reactionsByMessage.get(reaction.messageId);
      if (list) list.push(reaction);
      else reactionsByMessage.set(reaction.messageId, [reaction]);
    }
    const mentionsByMessage = new Map<string, string[]>();
    for (const mention of mentions) {
      const list = mentionsByMessage.get(mention.messageId);
      if (list) list.push(mention.userId);
      else mentionsByMessage.set(mention.messageId, [mention.userId]);
    }

    return messages.map((message) => {
      const parent =
        message.replyToMessageId === null ? undefined : parentsById.get(message.replyToMessageId);
      return {
        ...message,
        replyTo: parent === undefined ? null : toReference(parent),
        reactions: summarize(reactionsByMessage.get(message.id) ?? []),
        mentions: mentionsByMessage.get(message.id) ?? [],
        forwardedFrom: toForwardProvenance(message),
      };
    });
  }

  /**
   * Validate a mention set against a conversation's membership (ADR 0023 §2).
   *
   * `grandfathered` holds ids already stored on the message, which are exempt:
   * a mention is checked once, when it is claimed, and re-checking on every edit
   * would make fixing a typo impossible once the mentioned person left (§3).
   *
   * Returns the de-duplicated set to store, keeping the first occurrence of a
   * repeated id. That is the order handed to storage, not the order it reads
   * back in: `listMentionsByMessageIds` sorts by `(createdAt, userId)`, and a
   * set written in one call shares a timestamp. Mentions are a set.
   */
  function normalizeMentions(
    value: string[],
    conversation: Conversation,
    grandfathered: ReadonlySet<string> = new Set(),
  ): string[] {
    if (!Array.isArray(value)) {
      throw new ChatpackError("INVALID_INPUT", `"mentions" must be an array of user ids.`);
    }
    // Length-checked before de-duplication so a hostile array is rejected
    // without core walking it (ADR 0023 §2).
    if (value.length > MAX_MENTIONS_PER_MESSAGE) {
      throw new ChatpackError(
        "INVALID_INPUT",
        `"mentions" must hold at most ${MAX_MENTIONS_PER_MESSAGE} user ids, got ${value.length}.`,
      );
    }

    const participantIds = new Set(conversation.participants.map((p) => p.userId));
    const seen = new Set<string>();
    const mentions: string[] = [];
    for (const [index, userId] of value.entries()) {
      requireNonEmptyId(userId, `mentions[${index}]`);
      if (seen.has(userId)) continue;
      seen.add(userId);
      if (!participantIds.has(userId) && !grandfathered.has(userId)) {
        throw new ChatpackError(
          "MENTION_NOT_PARTICIPANT",
          `User "${userId}" is not a participant of conversation "${conversation.id}" and cannot be mentioned.`,
        );
      }
      mentions.push(userId);
    }
    return mentions;
  }

  async function withDetailsOne(message: Message): Promise<MessageWithDetails> {
    const [decorated] = await withDetails([message]);
    return decorated as MessageWithDetails;
  }

  /**
   * Publish a reaction change. Carries the full post-change reaction set, so
   * receiving the same event twice is harmless - and no `id:` frame, so
   * message gap-fill is undisturbed (ADR 0013 §4).
   */
  function publishReaction(
    type: "reaction.added" | "reaction.removed",
    conversation: Conversation,
    message: MessageWithDetails,
    actorId: string,
    emoji: string,
  ): void {
    transport.publish({
      type,
      conversationId: conversation.id,
      recipientIds: conversation.participants.map((p) => p.userId),
      actorId,
      emoji,
      message,
    });
  }

  /**
   * Shared body of `addReaction`/`removeReaction`: identical validation,
   * permission, and publish path - only the storage call differs.
   */
  async function changeReaction(
    input: ReactionApiInput,
    apply: (emoji: string) => Promise<Reaction[]>,
    eventType: "reaction.added" | "reaction.removed",
  ): Promise<MessageWithDetails> {
    requireNonEmptyId(input.userId, "userId");
    await requireActiveUser(input.userId);
    requireNonEmptyId(input.messageId, "messageId");
    const emoji = normalizeEmoji(input.emoji);

    const message = await storage.getMessage(input.messageId);
    if (!message) {
      throw new ChatpackError("MESSAGE_NOT_FOUND", `Message "${input.messageId}" was not found.`);
    }

    const conversation = await requireConversation(message.conversationId);
    // Write permission, like edit/delete: a reaction is a mutation the other
    // participant sees, not a read.
    await requireWrite(input.userId, conversation);
    await requireDirectInteractionAllowed(input.userId, conversation);

    const reactions = await apply(emoji);
    // Reuse the batched decorator for `replyTo`, then override `reactions`
    // with what the write returned - it is already the authoritative set.
    const decorated = await withDetailsOne(message);
    const updated: MessageWithDetails = { ...decorated, reactions: summarize(reactions) };
    publishReaction(eventType, conversation, updated, input.userId, emoji);
    return updated;
  }

  /**
   * Run `beforeMessageSend` (`docs/decisions/0011`) and resolve the body and
   * metadata to persist. A throwing hook aborts the write: `ChatpackError`s
   * pass through untouched, anything else becomes `MESSAGE_REJECTED` so
   * hooks can `throw new Error("Max 2000 characters.")` without importing
   * Chatpack types.
   */
  async function runBeforeMessageSend(
    ctx: BeforeMessageSendContext,
  ): Promise<{ body: string; metadata: Metadata }> {
    const hook = options.hooks?.beforeMessageSend;
    let accepted = { body: ctx.body, metadata: ctx.metadata };
    if (hook) {
      let result;
      try {
        result = await hook(ctx);
      } catch (err) {
        if (err instanceof ChatpackError) throw err;
        throw new ChatpackError(
          "MESSAGE_REJECTED",
          err instanceof Error && err.message ? err.message : "Message rejected.",
        );
      }

      const body = result?.body ?? ctx.body;
      if (typeof body !== "string" || body.trim() === "") {
        throw new ChatpackError(
          "INVALID_INPUT",
          "beforeMessageSend returned an empty body - throw to reject a message instead.",
        );
      }
      accepted = { body, metadata: result?.metadata ?? ctx.metadata };
    }

    const body = accepted.body;
    if (typeof body !== "string" || body.trim() === "") {
      throw new ChatpackError("INVALID_INPUT", "Message body must be a non-empty string.");
    }
    if (!pluginRuntime.hasPlugins) return accepted;

    const pluginAccepted = await pluginRuntime.runBeforeMessageSend({
      ...ctx,
      ...accepted,
    });
    if (typeof pluginAccepted.body !== "string" || pluginAccepted.body.trim() === "") {
      throw new ChatpackError(
        "INVALID_INPUT",
        "A plugin beforeMessageSend hook returned an empty body - throw to reject a message instead.",
      );
    }
    return {
      body: pluginAccepted.body,
      metadata: pluginAccepted.metadata ?? accepted.metadata,
    };
  }

  /**
   * Run the post-persistence hook once the message is persisted and broadcast.
   * The deprecated hook receives only send/edit actions for compatibility.
   */
  async function runAfterMessageMutation(
    ctx: Omit<AfterMessageMutationContext, "otherParticipantId" | "recipientIds">,
  ): Promise<void> {
    const hook = options.hooks?.afterMessageMutation;
    const deprecatedHook = ctx.action === "delete" ? undefined : options.hooks?.afterMessageSend;
    if (!hook && !deprecatedHook) return;

    // Correct for both conversation types, and the field integrations should
    // use (ADR 0017 §5). For a 1:1 `recipientIds[0]` is exactly what
    // `getOtherParticipantId` returned in 0.6.0, and for a group it is the same
    // "first non-sender participant" - so the deprecated field keeps its
    // shipped meaning without a second lookup that can throw.
    const recipientIds = recipientsExcluding(ctx.conversation, ctx.message.senderId);
    const otherParticipantId = recipientIds[0];

    if (hook) {
      try {
        // A creator-only group has no recipients. The modern hook still fires
        // with an empty list - analytics and queue integrations care about the
        // message, not just the notification - so the deprecated single-valued
        // field degrades to "" rather than suppressing the whole hook.
        await hook({ ...ctx, recipientIds, otherParticipantId: otherParticipantId ?? "" });
      } catch (err) {
        console.error("chatpack: afterMessageMutation hook failed", err);
      }
      return;
    }

    if (ctx.action === "delete" || !deprecatedHook) return;
    // The deprecated hook predates groups and its contract promises a real id,
    // so it stays suppressed when there is no other participant - exactly the
    // 0.6.0 behavior (`ea605ae`).
    if (otherParticipantId === undefined) return;

    try {
      await deprecatedHook({
        message: ctx.message,
        conversation: ctx.conversation,
        recipientIds,
        otherParticipantId,
        action: ctx.action,
      });
    } catch (err) {
      console.error("chatpack: afterMessageSend hook failed", err);
    }
  }

  // Assigned right below `api` - the two reference each other, but plugin
  // hooks only run inside api calls, which can't happen before chatpack()
  // returns.

  const moderationApi: ModerationApi = {
    async blockUser(input) {
      requireNonEmptyId(input.userId, "userId");
      requireNonEmptyId(input.targetUserId, "targetUserId");
      await requireActiveUser(input.userId);
      if (input.userId === input.targetUserId) {
        throw new ChatpackError("INVALID_INPUT", "A user cannot block themselves.");
      }
      return requireModerationStorage().createBlock({
        blockerUserId: input.userId,
        blockedUserId: input.targetUserId,
      });
    },

    async unblockUser(input) {
      requireNonEmptyId(input.userId, "userId");
      requireNonEmptyId(input.targetUserId, "targetUserId");
      await requireActiveUser(input.userId);
      if (input.userId === input.targetUserId) {
        throw new ChatpackError("INVALID_INPUT", "A user cannot unblock themselves.");
      }
      await requireModerationStorage().removeBlock({
        blockerUserId: input.userId,
        blockedUserId: input.targetUserId,
      });
    },

    async listBlockedUsers(input) {
      requireNonEmptyId(input.userId, "userId");
      await requireActiveUser(input.userId);
      const page = await requireModerationStorage().listBlocks({
        blockerUserId: input.userId,
        limit: normalizeLimit(input.limit),
        ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
      });
      return { blocks: page.items, nextCursor: page.nextCursor };
    },

    async muteConversation(input) {
      requireNonEmptyId(input.userId, "userId");
      requireNonEmptyId(input.conversationId, "conversationId");
      await requireActiveUser(input.userId);
      const conversation = await requireConversation(input.conversationId);
      await requireRead(input.userId, conversation);
      return requireModerationStorage().createMute({
        userId: input.userId,
        conversationId: input.conversationId,
      });
    },

    async unmuteConversation(input) {
      requireNonEmptyId(input.userId, "userId");
      requireNonEmptyId(input.conversationId, "conversationId");
      await requireActiveUser(input.userId);
      const conversation = await requireConversation(input.conversationId);
      await requireRead(input.userId, conversation);
      await requireModerationStorage().removeMute({
        userId: input.userId,
        conversationId: input.conversationId,
      });
    },

    async listMutedConversations(input) {
      requireNonEmptyId(input.userId, "userId");
      await requireActiveUser(input.userId);
      const page = await requireModerationStorage().listMutes({
        userId: input.userId,
        limit: normalizeLimit(input.limit),
        ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
      });
      return { mutes: page.items, nextCursor: page.nextCursor };
    },

    async report(input) {
      requireNonEmptyId(input.userId, "userId");
      requireNonEmptyId(input.targetId, "targetId");
      await requireActiveUser(input.userId);
      const targetType = normalizeReportTargetType(input.targetType);
      const reason = normalizeModerationReason(input.reason);
      if (targetType === "user" && input.targetId === input.userId) {
        throw new ChatpackError("INVALID_INPUT", "A user cannot report themselves.");
      }

      let evidence: ModerationReport["evidence"];
      if (targetType === "user") {
        evidence = { targetType: "user" };
      } else if (targetType === "message") {
        const message = await storage.getMessage(input.targetId);
        if (!message) {
          throw new ChatpackError(
            "MESSAGE_NOT_FOUND",
            `Message "${input.targetId}" was not found.`,
          );
        }
        const conversation = await requireConversation(message.conversationId);
        await requireRead(input.userId, conversation);
        evidence = {
          targetType: "message",
          messageId: message.id,
          conversationId: message.conversationId,
          senderId: message.senderId,
          body: message.body,
          deletedAt: message.deletedAt,
          createdAt: message.createdAt,
        };
      } else {
        const conversation = await requireConversation(input.targetId);
        await requireRead(input.userId, conversation);
        evidence = {
          targetType: "conversation",
          conversationId: conversation.id,
          type: conversation.type,
          name: conversation.name,
          participantIds: conversation.participants.map((p) => p.userId),
        };
      }

      const moderation = requireModerationStorage();
      const existing = await moderation.findOpenReport(input.userId, targetType, input.targetId);
      if (existing) return existing;
      return moderation.createReport({
        reporterUserId: input.userId,
        targetType,
        targetId: input.targetId,
        reason,
        evidence,
      });
    },

    async listReports(input) {
      requireNonEmptyId(input.userId, "userId");
      const targetType =
        input.targetType === undefined ? undefined : normalizeReportTargetType(input.targetType);
      const status = input.status === undefined ? undefined : normalizeReportStatus(input.status);
      await requireModerator(input.userId, "reports.read");
      const page = await requireModerationStorage().listReports({
        ...(status === undefined ? {} : { status }),
        ...(targetType === undefined ? {} : { targetType }),
        limit: normalizeLimit(input.limit),
        ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
      });
      return { reports: page.items, nextCursor: page.nextCursor };
    },

    async getReport(input) {
      requireNonEmptyId(input.userId, "userId");
      requireNonEmptyId(input.reportId, "reportId");
      await requireModerator(input.userId, "reports.read", { reportId: input.reportId });
      const report = await requireModerationStorage().getReport(input.reportId);
      if (!report) {
        throw new ChatpackError("REPORT_NOT_FOUND", `Report "${input.reportId}" was not found.`);
      }
      return report;
    },

    async updateReport(input) {
      requireNonEmptyId(input.userId, "userId");
      requireNonEmptyId(input.reportId, "reportId");
      const status = normalizeReportStatus(input.status);
      const moderatorNote = normalizeModeratorNote(input.moderatorNote);
      await requireModerator(input.userId, "reports.update", { reportId: input.reportId });
      const moderation = requireModerationStorage();
      if (!(await moderation.getReport(input.reportId))) {
        throw new ChatpackError("REPORT_NOT_FOUND", `Report "${input.reportId}" was not found.`);
      }
      return moderation.updateReport({
        reportId: input.reportId,
        status,
        moderatorNote,
      });
    },

    async listBans(input) {
      requireNonEmptyId(input.userId, "userId");
      await requireModerator(input.userId, "bans.read");
      const page = await requireModerationStorage().listBans({
        activeOnly: input.activeOnly ?? true,
        limit: normalizeLimit(input.limit),
        ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
      });
      return { bans: page.items, nextCursor: page.nextCursor };
    },

    async banUser(input) {
      requireNonEmptyId(input.userId, "userId");
      requireNonEmptyId(input.targetUserId, "targetUserId");
      await requireModerator(input.userId, "bans.create", {
        targetUserId: input.targetUserId,
      });
      if (input.userId === input.targetUserId) {
        throw new ChatpackError("INVALID_INPUT", "A moderator cannot ban themselves.");
      }
      if (input.expiresAt !== undefined && input.expiresAt !== null) {
        if (!(input.expiresAt instanceof Date) || input.expiresAt.getTime() <= Date.now()) {
          throw new ChatpackError("INVALID_INPUT", `"expiresAt" must be a future date or null.`);
        }
      }
      const moderation = requireModerationStorage();
      // No read-then-write here: `createBan` returns the user's existing active
      // ban rather than minting a second one, and decides that in a single
      // statement so two moderators cannot both win (ADR 0019 §5).
      return moderation.createBan({
        userId: input.targetUserId,
        createdByUserId: input.userId,
        reason: normalizeOptionalModerationReason(input.reason),
        expiresAt: input.expiresAt === undefined ? null : input.expiresAt,
      });
    },

    async unbanUser(input) {
      requireNonEmptyId(input.userId, "userId");
      requireNonEmptyId(input.banId, "banId");
      await requireModerator(input.userId, "bans.revoke", { banId: input.banId });
      const moderation = requireModerationStorage();
      if (!(await moderation.getBan(input.banId))) {
        throw new ChatpackError("BAN_NOT_FOUND", `Ban "${input.banId}" was not found.`);
      }
      return moderation.revokeBan({ banId: input.banId, revokedByUserId: input.userId });
    },
  };

  const api: ChatpackApi = {
    moderation: moderationApi,
    async getOrCreateConversation(input) {
      requireNonEmptyId(input.userId, "userId");
      requireNonEmptyId(input.otherUserId, "otherUserId");
      await requireActiveUser(input.userId);
      await requireActiveUser(input.otherUserId);
      if (input.userId === input.otherUserId) {
        throw new ChatpackError(
          "INVALID_INPUT",
          "A direct conversation requires two distinct users.",
        );
      }
      await requireKnownUsers([input.otherUserId]);
      if (
        moderationStorage &&
        (await moderationStorage.isBlocked(input.userId, input.otherUserId))
      ) {
        throw new ChatpackError(
          "DIRECT_INTERACTION_BLOCKED",
          "Direct interaction is blocked by one of the participants.",
        );
      }

      const userIds = [input.userId, input.otherUserId].sort() as [string, string];
      const { conversation, created } = await storage.getOrCreateDirectConversation({
        pairKey: pairKeyFor(input.userId, input.otherUserId),
        userIds,
        metadata: input.metadata ?? {},
      });

      if (created) telemetry.increment("conversationsCreated");
      return withUnreadOne(input.userId, conversation);
    },

    async createGroupConversation(input) {
      requireNonEmptyId(input.userId, "userId");
      await requireActiveUser(input.userId);
      const name = normalizeGroupName(input.name);
      // The creator is always a member, so passing their own id is redundant
      // rather than wrong - drop it instead of erroring.
      const userIds = normalizeUserIds(input.userIds, "userIds", new Set([input.userId]));

      // +1 for the creator.
      if (userIds.length + 1 > MAX_GROUP_PARTICIPANTS) {
        throw new ChatpackError(
          "GROUP_LIMIT_EXCEEDED",
          `A group may hold at most ${MAX_GROUP_PARTICIPANTS} participants, got ${userIds.length + 1}.`,
        );
      }
      await requireKnownUsers(userIds);

      const { visibility, joinPolicy } = resolveChannelFields(input.visibility, input.joinPolicy);

      const conversation = await storage.createGroupConversation({
        creatorId: input.userId,
        userIds,
        name,
        visibility,
        joinPolicy,
        metadata: input.metadata ?? {},
      });

      telemetry.increment("conversationsCreated");
      // Seeded members learn about the group the same way later ones do, so a
      // client that is already streaming does not need to poll for it.
      if (userIds.length > 0) {
        publishConversation(
          "participant.added",
          conversation,
          input.userId,
          userIds,
          conversation.participants.map((p) => p.userId),
        );
      }
      return withUnreadOne(input.userId, conversation);
    },

    async addParticipants(input) {
      requireNonEmptyId(input.userId, "userId");
      await requireActiveUser(input.userId);
      const conversation = await requireConversation(input.conversationId);
      requireGroup(conversation);
      await requireManage(input.userId, conversation);

      const existing = new Set(conversation.participants.map((p) => p.userId));
      const userIds = normalizeUserIds(input.userIds, "userIds", existing);
      if (userIds.length === 0) {
        // Everyone requested is already a member: idempotent no-op, and no
        // event - nothing changed, so notifying would be a lie.
        return withUnreadOne(input.userId, conversation);
      }

      if (existing.size + userIds.length > MAX_GROUP_PARTICIPANTS) {
        throw new ChatpackError(
          "GROUP_LIMIT_EXCEEDED",
          `A group may hold at most ${MAX_GROUP_PARTICIPANTS} participants, got ${existing.size + userIds.length}.`,
        );
      }
      await requireKnownUsers(userIds);

      const updated = await storage.addParticipants({
        conversationId: conversation.id,
        userIds,
      });
      publishConversation(
        "participant.added",
        updated,
        input.userId,
        userIds,
        updated.participants.map((p) => p.userId),
      );
      return withUnreadOne(input.userId, updated);
    },

    async removeParticipant(input) {
      requireNonEmptyId(input.userId, "userId");
      requireNonEmptyId(input.targetUserId, "targetUserId");
      await requireActiveUser(input.userId);
      const conversation = await requireConversation(input.conversationId);
      requireGroup(conversation);

      // Leaving is always allowed; removing someone else needs authority.
      const isLeaving = input.targetUserId === input.userId;
      if (!isLeaving) await requireManage(input.userId, conversation);

      const target = conversation.participants.find((p) => p.userId === input.targetUserId);
      if (!target) {
        // Idempotent: removing a non-member is a silent no-op so a replayed
        // request cannot fail (ADR 0017 §3).
        return withUnreadOne(input.userId, conversation);
      }

      requireAdminRemains(
        conversation,
        conversation.participants.filter((p) => p.userId !== input.targetUserId),
      );

      // Captured BEFORE the write: the removed user must receive this event -
      // it is the only signal telling their client to drop the conversation
      // (ADR 0017 §4).
      const recipientIds = conversation.participants.map((p) => p.userId);

      const updated = await storage.removeParticipant({
        conversationId: conversation.id,
        userId: input.targetUserId,
      });
      publishConversation(
        "participant.removed",
        updated,
        input.userId,
        [input.targetUserId],
        recipientIds,
      );
      return withUnreadOne(input.userId, updated);
    },

    async setParticipantRole(input) {
      requireNonEmptyId(input.userId, "userId");
      requireNonEmptyId(input.targetUserId, "targetUserId");
      await requireActiveUser(input.userId);
      if (input.role !== "admin" && input.role !== "member") {
        throw new ChatpackError("INVALID_INPUT", `"role" must be "admin" or "member".`);
      }

      const conversation = await requireConversation(input.conversationId);
      requireGroup(conversation);
      await requireManage(input.userId, conversation);

      const target = conversation.participants.find((p) => p.userId === input.targetUserId);
      if (!target) {
        throw new ChatpackError(
          "INVALID_INPUT",
          `User "${input.targetUserId}" is not a participant of conversation "${conversation.id}".`,
        );
      }
      if (target.role === input.role) {
        // Already in the requested role: no write, no event.
        return withUnreadOne(input.userId, conversation);
      }

      requireAdminRemains(
        conversation,
        conversation.participants.map((p) =>
          p.userId === input.targetUserId ? { ...p, role: input.role } : p,
        ),
      );

      const updated = await storage.setParticipantRole({
        conversationId: conversation.id,
        userId: input.targetUserId,
        role: input.role,
      });
      // A role change is conversation metadata, not membership - clients
      // re-render permissions from the snapshot.
      publishConversation(
        "conversation.updated",
        updated,
        input.userId,
        [input.targetUserId],
        updated.participants.map((p) => p.userId),
      );
      return withUnreadOne(input.userId, updated);
    },

    async updateConversation(input) {
      requireNonEmptyId(input.userId, "userId");
      await requireActiveUser(input.userId);
      const conversation = await requireConversation(input.conversationId);
      requireGroup(conversation);
      await requireManage(input.userId, conversation);

      // Three independently-optional fields (ADR 0020 §5): an omitted one keeps
      // its current value, so `visibility`-only and `name`-only calls both work.
      // An update with nothing in it is a mistake worth reporting, not a no-op.
      if (
        input.name === undefined &&
        input.visibility === undefined &&
        input.joinPolicy === undefined
      ) {
        throw new ChatpackError(
          "INVALID_INPUT",
          `An update must change something - provide "name", "visibility", or "joinPolicy".`,
        );
      }

      const name = input.name === undefined ? conversation.name : normalizeGroupName(input.name);
      const { visibility, joinPolicy } = resolveChannelFields(
        input.visibility,
        input.joinPolicy,
        conversation,
      );

      const updated = await storage.updateConversation({
        conversationId: conversation.id,
        name,
        visibility,
        joinPolicy,
      });
      publishConversation(
        "conversation.updated",
        updated,
        input.userId,
        [],
        updated.participants.map((p) => p.userId),
      );
      return withUnreadOne(input.userId, updated);
    },

    async listConversations(input) {
      requireNonEmptyId(input.userId, "userId");
      await requireActiveUser(input.userId);
      const { conversations, nextCursor } = await storage.listConversations({
        userId: input.userId,
        limit: normalizeLimit(input.limit),
        cursor: input.cursor,
      });
      return { conversations: await withUnread(input.userId, conversations), nextCursor };
    },

    async getConversation(input) {
      requireNonEmptyId(input.userId, "userId");
      await requireActiveUser(input.userId);
      const conversation = await requireConversation(input.conversationId);
      await requireRead(input.userId, conversation);
      return withUnreadOne(input.userId, conversation);
    },

    async sendMessage(input) {
      requireNonEmptyId(input.userId, "userId");
      await requireActiveUser(input.userId);
      if (typeof input.body !== "string" || input.body.trim() === "") {
        throw new ChatpackError("INVALID_INPUT", "Message body must be a non-empty string.");
      }

      const conversation = await requireConversation(input.conversationId);
      await requireWrite(input.userId, conversation);
      await requireDirectInteractionAllowed(input.userId, conversation);

      // A reply must point inside this conversation (ADR 0013 §1). Same error
      // as markRead uses, so a cross-conversation id can't be used to probe
      // whether a message exists somewhere the caller cannot read. Deleted
      // parents are fine - the parent can vanish between render and send.
      if (input.replyToMessageId !== undefined) {
        requireNonEmptyId(input.replyToMessageId, "replyToMessageId");
        const parent = await storage.getMessage(input.replyToMessageId);
        if (!parent || parent.conversationId !== conversation.id) {
          throw new ChatpackError(
            "MESSAGE_NOT_FOUND",
            `Message "${input.replyToMessageId}" was not found in conversation "${conversation.id}".`,
          );
        }
      }

      // Validated before the hook runs so `beforeMessageSend` sees the final,
      // de-duplicated set rather than whatever the client sent (ADR 0023 §2).
      const mentions =
        input.mentions === undefined ? [] : normalizeMentions(input.mentions, conversation);

      const hookConversation = {
        ...conversation,
        participantIds: conversation.participants.map((p) => p.userId),
      };
      const accepted = await runBeforeMessageSend({
        user: { id: input.userId },
        conversation: hookConversation,
        body: input.body,
        metadata: input.metadata ?? {},
        role: input.role ?? "user",
        action: "send",
        mentions,
        forwardedFrom: null,
      });

      const message = await storage.addMessage({
        conversationId: conversation.id,
        senderId: input.userId,
        body: accepted.body,
        role: input.role ?? "user",
        replyToMessageId: input.replyToMessageId ?? null,
        forwardedFromMessageId: null,
        forwardedFromConversationId: null,
        forwardedFromSenderId: null,
        metadata: accepted.metadata,
      });
      // After the insert - mentions key off the message id. Skipped entirely
      // when there are none, so an app that never mentions pays no write.
      if (mentions.length > 0) {
        await storage.setMessageMentions({ messageId: message.id, userIds: mentions });
      }

      telemetry.increment("messagesSent");
      const decorated = await withDetailsOne(message);
      // Durable-first (MVP §9): the message exists before anyone is told.
      publish("message.created", conversation, decorated);
      await runAfterMessageMutation({
        message,
        conversation: hookConversation,
        action: "send",
        mentions,
      });
      return decorated;
    },

    async forwardMessage(input) {
      requireNonEmptyId(input.userId, "userId");
      await requireActiveUser(input.userId);
      requireNonEmptyId(input.messageId, "messageId");
      requireNonEmptyId(input.toConversationId, "toConversationId");

      const source = await storage.getMessage(input.messageId);
      if (!source) {
        throw new ChatpackError("MESSAGE_NOT_FOUND", `Message "${input.messageId}" was not found.`);
      }

      // Read permission on the source: you may only forward what you can see.
      // `requireRead` throws FORBIDDEN_READ, matching what a direct fetch of the
      // source conversation would have said (ADR 0024 §3).
      const sourceConversation = await requireConversation(source.conversationId);
      await requireRead(input.userId, sourceConversation);

      // A tombstone has an empty body, and a forward's whole payload is the copy.
      // Unlike a quote-reply (ADR 0013 §1) there is nothing left to point at.
      if (source.deletedAt !== null) {
        throw new ChatpackError("MESSAGE_DELETED", "A deleted message cannot be forwarded.");
      }

      // Write permission on the target, plus the same block and ban checks an
      // ordinary send makes - forwarding must not be a way around either.
      const target = await requireConversation(input.toConversationId);
      await requireWrite(input.userId, target);
      await requireDirectInteractionAllowed(input.userId, target);

      // The source's mentions never travel: their ids were checked against the
      // source's membership (ADR 0024 §6). A fresh set is checked against the
      // target, like any other send.
      const mentions =
        input.mentions === undefined ? [] : normalizeMentions(input.mentions, target);

      const hookConversation = {
        ...target,
        participantIds: target.participants.map((p) => p.userId),
      };
      const provenance: ForwardProvenance = {
        messageId: source.id,
        conversationId: source.conversationId,
        senderId: source.senderId,
      };
      // `action: "send"` deliberately, not a third action - a host filtering on
      // "send" must keep covering forwards, or shipping this would silently
      // exempt every existing content rule (ADR 0024 §5). Hosts that need to
      // branch read `forwardedFrom` instead.
      const accepted = await runBeforeMessageSend({
        user: { id: input.userId },
        conversation: hookConversation,
        body: source.body,
        metadata: input.metadata ?? {},
        role: input.role ?? "user",
        action: "send",
        mentions,
        forwardedFrom: provenance,
      });

      const message = await storage.addMessage({
        conversationId: target.id,
        senderId: input.userId,
        body: accepted.body,
        role: input.role ?? "user",
        // Not a reply, and the source's parent is not in this conversation.
        replyToMessageId: null,
        forwardedFromMessageId: provenance.messageId,
        forwardedFromConversationId: provenance.conversationId,
        forwardedFromSenderId: provenance.senderId,
        metadata: accepted.metadata,
      });
      if (mentions.length > 0) {
        await storage.setMessageMentions({ messageId: message.id, userIds: mentions });
      }

      telemetry.increment("messagesSent");
      const decorated = await withDetailsOne(message);
      // Published to the target only. The source is told nothing: being
      // forwarded is not an event it can act on, and saying so would leak that
      // the target exists (ADR 0024).
      publish("message.created", target, decorated);
      await runAfterMessageMutation({
        message,
        conversation: hookConversation,
        action: "send",
        mentions,
      });
      return decorated;
    },

    async listMessages(input) {
      requireNonEmptyId(input.userId, "userId");
      await requireActiveUser(input.userId);
      const conversation = await requireConversation(input.conversationId);
      await requireRead(input.userId, conversation);

      const { messages, nextCursor } = await storage.listMessages({
        conversationId: conversation.id,
        limit: normalizeLimit(input.limit),
        cursor: input.cursor,
      });
      return { messages: await withDetails(messages), nextCursor };
    },

    async searchMessages(input) {
      requireNonEmptyId(input.userId, "userId");
      await requireActiveUser(input.userId);
      if (typeof input.query !== "string" || input.query.trim() === "") {
        throw new ChatpackError("INVALID_INPUT", '"query" must be a non-empty string.');
      }
      if (!storage.searchMessages) {
        throw new ChatpackError(
          "SEARCH_UNSUPPORTED",
          "Message search is not supported by this storage adapter.",
        );
      }

      const limit = normalizeLimit(input.limit);
      const messages: Message[] = [];
      let cursor = input.cursor;

      // Adapter pages remain participant-scoped and ranked. Filtering a page
      // in core keeps custom canRead hooks effective for those results.
      for (;;) {
        const page = await storage.searchMessages({
          userId: input.userId,
          query: input.query.trim(),
          limit: limit - messages.length,
          ...(cursor !== undefined ? { cursor } : {}),
        });

        for (const message of page.messages) {
          const conversation = await storage.getConversation(message.conversationId);
          if (conversation && (await canReadConversation(input.userId, conversation))) {
            messages.push(message);
          }
        }

        if (messages.length >= limit || page.nextCursor === null) {
          return {
            messages: await withDetails(messages.slice(0, limit)),
            nextCursor: page.nextCursor,
          };
        }
        cursor = page.nextCursor;
      }
    },

    async editMessage(input) {
      requireNonEmptyId(input.userId, "userId");
      await requireActiveUser(input.userId);
      if (typeof input.body !== "string" || input.body.trim() === "") {
        throw new ChatpackError("INVALID_INPUT", "Message body must be a non-empty string.");
      }

      const existing = await storage.getMessage(input.messageId);
      if (!existing) {
        throw new ChatpackError("MESSAGE_NOT_FOUND", `Message "${input.messageId}" was not found.`);
      }
      if (existing.deletedAt) {
        throw new ChatpackError("MESSAGE_DELETED", "A deleted message cannot be edited.");
      }
      if (existing.senderId !== input.userId) {
        throw new ChatpackError("NOT_MESSAGE_SENDER", "Only the sender can edit a message.");
      }

      const conversation = await requireConversation(existing.conversationId);
      await requireWrite(input.userId, conversation);
      await requireDirectInteractionAllowed(input.userId, conversation);

      // The stored set does double duty: it is what the hooks report when the
      // caller left `mentions` out, and it is the grandfathered set that makes
      // re-editing a message work after a mentioned person left (ADR 0023 §3).
      const stored = await storage.listMentionsByMessageIds([existing.id]);
      const storedIds = stored.map((mention) => mention.userId);
      const mentions =
        input.mentions === undefined
          ? storedIds
          : normalizeMentions(input.mentions, conversation, new Set(storedIds));

      // Content rules apply to edits too - otherwise a blocked word could be
      // sent clean and edited in afterwards (docs/decisions/0011).
      const hookConversation = {
        ...conversation,
        participantIds: conversation.participants.map((p) => p.userId),
      };
      const accepted = await runBeforeMessageSend({
        user: { id: input.userId },
        conversation: hookConversation,
        body: input.body,
        metadata: existing.metadata,
        role: existing.role,
        action: "edit",
        mentions,
        forwardedFrom: toForwardProvenance(existing),
      });

      const updated = await storage.updateMessage({
        messageId: existing.id,
        body: accepted.body,
        editedAt: new Date(),
      });
      // Only written when the caller actually passed the field: an edit that
      // omits `mentions` must not erase what a mentions-unaware client did not
      // send back.
      if (input.mentions !== undefined) {
        await storage.setMessageMentions({ messageId: existing.id, userIds: mentions });
      }
      const decorated = await withDetailsOne(updated);
      publish("message.updated", conversation, decorated);
      await runAfterMessageMutation({
        message: updated,
        conversation: hookConversation,
        action: "edit",
        mentions,
      });
      return decorated;
    },

    async deleteMessage(input) {
      requireNonEmptyId(input.userId, "userId");
      await requireActiveUser(input.userId);

      const existing = await storage.getMessage(input.messageId);
      if (!existing) {
        throw new ChatpackError("MESSAGE_NOT_FOUND", `Message "${input.messageId}" was not found.`);
      }
      if (existing.senderId !== input.userId) {
        throw new ChatpackError("NOT_MESSAGE_SENDER", "Only the sender can delete a message.");
      }
      if (existing.deletedAt) return withDetailsOne(existing); // idempotent

      const conversation = await requireConversation(existing.conversationId);
      await requireWrite(input.userId, conversation);
      await requireDirectInteractionAllowed(input.userId, conversation);
      const hookConversation = {
        ...conversation,
        participantIds: conversation.participants.map((p) => p.userId),
      };

      const updated = await storage.updateMessage({
        messageId: existing.id,
        body: "",
        deletedAt: new Date(),
      });
      // Reactions and mentions on a deleted message are left alone: the tombstone
      // still renders, and clearing them would be a second write for no gain.
      const decorated = await withDetailsOne(updated);
      publish("message.deleted", conversation, decorated);
      await runAfterMessageMutation({
        message: updated,
        conversation: hookConversation,
        action: "delete",
        // Already hydrated above, so reporting them costs nothing extra.
        mentions: decorated.mentions,
      });
      return decorated;
    },

    async markRead(input) {
      requireNonEmptyId(input.userId, "userId");
      await requireActiveUser(input.userId);
      const conversation = await requireConversation(input.conversationId);
      await requireRead(input.userId, conversation);

      const isParticipant = conversation.participants.some((p) => p.userId === input.userId);
      if (!isParticipant) {
        throw new ChatpackError(
          "FORBIDDEN_READ",
          "Only participants have read-state in a conversation.",
        );
      }

      const message = await storage.getMessage(input.messageId);
      if (!message || message.conversationId !== conversation.id) {
        throw new ChatpackError(
          "MESSAGE_NOT_FOUND",
          `Message "${input.messageId}" was not found in conversation "${conversation.id}".`,
        );
      }

      // Monotonic: never move read-state backwards. A stale markRead (e.g. an
      // out-of-order replay after reconnect) is silently ignored so unread
      // counts can only shrink from reading, never grow.
      const participant = conversation.participants.find((p) => p.userId === input.userId);
      if (participant?.lastReadMessageId) {
        const current = await storage.getMessage(participant.lastReadMessageId);
        if (current && message.seq <= current.seq) return;
      }

      await storage.updateLastRead({
        conversationId: conversation.id,
        userId: input.userId,
        messageId: message.id,
      });

      // Durable-first, same as messages: the read-state exists before any
      // plugin (e.g. receipts) tells anyone about it.
      pluginRuntime.notifyMarkRead({
        userId: input.userId,
        conversationId: conversation.id,
        messageId: message.id,
        recipientIds: conversation.participants.map((p) => p.userId),
      });
    },

    async listMessagesAfter(input) {
      requireNonEmptyId(input.userId, "userId");
      await requireActiveUser(input.userId);
      if (!Number.isInteger(input.afterSeq) || input.afterSeq < 0) {
        throw new ChatpackError(
          "INVALID_INPUT",
          `"afterSeq" must be a non-negative integer, got ${input.afterSeq}.`,
        );
      }
      const conversation = await requireConversation(input.conversationId);
      await requireRead(input.userId, conversation);

      const missed = await storage.listMessagesAfterSeq({
        conversationId: conversation.id,
        afterSeq: input.afterSeq,
        limit: normalizeLimit(input.limit),
      });
      return withDetails(missed);
    },

    async addReaction(input) {
      return changeReaction(
        input,
        (emoji) => storage.addReaction({ messageId: input.messageId, userId: input.userId, emoji }),
        "reaction.added",
      );
    },

    async removeReaction(input) {
      return changeReaction(
        input,
        (emoji) =>
          storage.removeReaction({ messageId: input.messageId, userId: input.userId, emoji }),
        "reaction.removed",
      );
    },

    async createInvite(input) {
      const invites = requireInviteStorage();
      requireNonEmptyId(input.userId, "userId");
      const conversation = await requireConversation(input.conversationId);
      // A DM's membership is fixed by its pairKey (ADR 0002), so there is
      // nothing an invite could admit anyone to.
      requireGroup(conversation);
      await requireInvite(input.userId, conversation);

      const expiresInSeconds = normalizePositiveInt(input.expiresInSeconds, "expiresInSeconds");
      const maxUses = normalizePositiveInt(input.maxUses, "maxUses");
      if (input.requiresApproval !== undefined && typeof input.requiresApproval !== "boolean") {
        throw new ChatpackError("INVALID_INPUT", `"requiresApproval" must be a boolean.`);
      }

      // Expired invites are inert but never swept (ADR 0019 consequences), so
      // the cap is what bounds the table for an app minting short-lived links.
      const existing = await invites.listInvites(conversation.id);
      if (existing.length >= MAX_INVITES_PER_CONVERSATION) {
        throw new ChatpackError(
          "INVITE_LIMIT_EXCEEDED",
          `A conversation may hold at most ${MAX_INVITES_PER_CONVERSATION} invites - revoke an existing one first.`,
        );
      }

      return invites.createInvite({
        conversationId: conversation.id,
        code: generateInviteCode(),
        createdBy: input.userId,
        expiresAt:
          expiresInSeconds === null ? null : new Date(Date.now() + expiresInSeconds * 1000),
        maxUses,
        requiresApproval: input.requiresApproval ?? false,
        metadata: input.metadata ?? {},
      });
    },

    async listInvites(input) {
      const invites = requireInviteStorage();
      requireNonEmptyId(input.userId, "userId");
      const conversation = await requireConversation(input.conversationId);
      requireGroup(conversation);
      await requireManage(input.userId, conversation);
      return invites.listInvites(conversation.id);
    },

    async revokeInvite(input) {
      const invites = requireInviteStorage();
      requireNonEmptyId(input.userId, "userId");
      requireNonEmptyId(input.code, "code");
      const conversation = await requireConversation(input.conversationId);
      requireGroup(conversation);
      await requireManage(input.userId, conversation);
      // Scoped by conversation, so an admin of one group can never revoke
      // another group's invite by guessing a code.
      await invites.deleteInvite({ conversationId: conversation.id, code: input.code });
    },

    async getInvitePreview(input) {
      requireNonEmptyId(input.userId, "userId");
      const invite = await requireUsableInvite(input.code);
      const conversation = await storage.getConversation(invite.conversationId);
      if (!conversation) {
        // The group was deleted out from under the invite. "Not valid" is both
        // true and the same answer the holder can act on.
        throw new ChatpackError("INVITE_NOT_FOUND", "That invite link is not valid.");
      }

      // A count, never the ids: this is the only route non-members can reach,
      // and returning the conversation would leak the membership list to
      // anyone holding a link (ADR 0019 §10).
      return {
        conversationId: conversation.id,
        name: conversation.name,
        participantCount: conversation.participants.length,
        requiresApproval: invite.requiresApproval,
        invitedBy: invite.createdBy,
        alreadyParticipant: conversation.participants.some((p) => p.userId === input.userId),
      };
    },

    async acceptInvite(input) {
      const invites = requireInviteStorage();
      requireNonEmptyId(input.userId, "userId");
      const message = normalizeJoinMessage(input.message);
      // Deliberately not `requireUsableInvite`: the 410 check comes *after* the
      // idempotent shortcuts below, so a spent link still answers truthfully to
      // whoever it already admitted.
      const invite = await requireInviteByCode(input.code);

      // A held invite whose group has since been deleted reads as an invalid
      // link, not as a missing conversation the holder never knew about.
      const conversation = await storage.getConversation(invite.conversationId);
      if (!conversation) {
        throw new ChatpackError("INVITE_NOT_FOUND", "That invite link is not valid.");
      }

      // Already a member: return the conversation and burn no use. There is a
      // truthful success value here, so returning it beats erroring - a
      // double-clicked link must not cost a use (ADR 0019 §5).
      if (conversation.participants.some((p) => p.userId === input.userId)) {
        return {
          status: "joined",
          conversation: await withUnreadOne(input.userId, conversation),
          joinRequest: null,
        };
      }

      if (invite.requiresApproval) {
        const pending = await invites.getJoinRequest({
          conversationId: conversation.id,
          userId: input.userId,
        });
        // A second click while waiting returns the same request rather than
        // resetting it - and, as above, consumes nothing.
        if (pending && pending.status === "pending") {
          return { status: "pending", conversation: null, joinRequest: pending };
        }
      }

      // No shortcut applied, so this call is going to spend a use - which means
      // an expired or exhausted link is now the holder's answer.
      assertInviteUsable(invite);
      // And a full group is too, checked before the use is spent: failing after
      // consuming would silently cost the link one of its redemptions.
      if (!invite.requiresApproval) assertGroupHasRoom(conversation);

      // Consume only once the request is definitely going to do something. The
      // adapter decides the race atomically; `null` means someone else took the
      // last use between our check and this call.
      const consumed = await invites.consumeInvite(invite.code);
      if (!consumed) {
        throw new ChatpackError(
          "INVITE_EXPIRED",
          "That invite link is no longer usable - ask for a new one.",
        );
      }

      if (invite.requiresApproval) {
        const joinRequest = await invites.createJoinRequest({
          conversationId: conversation.id,
          userId: input.userId,
          message,
          inviteCode: invite.code,
          metadata: {},
        });
        // No event: the requester is not in the conversation, nothing on any
        // member's screen is stale, and admins poll the queue (ADR 0019 §6).
        return { status: "pending", conversation: null, joinRequest };
      }

      // The invite's creator is the actor: they authorized this membership when
      // they minted the link, and the joiner has no authority of their own.
      const updated = await admitToGroup(conversation, input.userId, invite.createdBy);
      return {
        status: "joined",
        conversation: await withUnreadOne(input.userId, updated),
        joinRequest: null,
      };
    },

    async requestToJoin(input) {
      const invites = requireInviteStorage();
      requireNonEmptyId(input.userId, "userId");
      const message = normalizeJoinMessage(input.message);
      const conversation = await requireConversation(input.conversationId);
      requireGroup(conversation);

      // No permission check by design: asking is not entering, and an admin
      // decides (ADR 0019). Gate discoverability above Chatpack if group ids
      // should not be guessable.
      if (conversation.participants.some((p) => p.userId === input.userId)) {
        throw new ChatpackError(
          "ALREADY_PARTICIPANT",
          `User "${input.userId}" is already a participant of conversation "${conversation.id}".`,
        );
      }

      const existing = await invites.getJoinRequest({
        conversationId: conversation.id,
        userId: input.userId,
      });
      // Re-asking while pending returns the same row: idempotent, and it stops
      // a client from bumping itself up a newest-first moderation queue.
      if (existing && existing.status === "pending") return existing;

      return invites.createJoinRequest({
        conversationId: conversation.id,
        userId: input.userId,
        message,
        inviteCode: null,
        metadata: {},
      });
    },

    async listJoinRequests(input) {
      const invites = requireInviteStorage();
      requireNonEmptyId(input.userId, "userId");
      if (
        input.status !== undefined &&
        input.status !== "pending" &&
        input.status !== "approved" &&
        input.status !== "denied"
      ) {
        throw new ChatpackError(
          "INVALID_INPUT",
          `"status" must be "pending", "approved" or "denied".`,
        );
      }

      const conversation = await requireConversation(input.conversationId);
      requireGroup(conversation);
      await requireManage(input.userId, conversation);

      return invites.listJoinRequests({
        conversationId: conversation.id,
        // Defaults to the moderation queue - the list an admin opens this for.
        status: input.status ?? "pending",
        limit: normalizeLimit(input.limit),
      });
    },

    async resolveJoinRequest(input) {
      const invites = requireInviteStorage();
      requireNonEmptyId(input.userId, "userId");
      requireNonEmptyId(input.targetUserId, "targetUserId");
      if (input.decision !== "approve" && input.decision !== "deny") {
        throw new ChatpackError("INVALID_INPUT", `"decision" must be "approve" or "deny".`);
      }

      const conversation = await requireConversation(input.conversationId);
      requireGroup(conversation);
      await requireManage(input.userId, conversation);

      const existing = await invites.getJoinRequest({
        conversationId: conversation.id,
        userId: input.targetUserId,
      });
      // An already-resolved request is reported as not found, so two admins
      // racing on the same queue entry cannot both apply a decision.
      if (!existing || existing.status !== "pending") {
        throw new ChatpackError(
          "JOIN_REQUEST_NOT_FOUND",
          `No pending join request from user "${input.targetUserId}" in conversation "${conversation.id}".`,
        );
      }

      const joinRequest = await invites.resolveJoinRequest({
        conversationId: conversation.id,
        userId: input.targetUserId,
        status: input.decision === "approve" ? "approved" : "denied",
        resolvedBy: input.userId,
        resolvedAt: new Date(),
      });

      if (input.decision === "deny") {
        // The row is kept so the requester can be told, and so a fresh ask
        // replaces it rather than stacking (ADR 0019 §5).
        return { joinRequest, conversation: null };
      }

      const updated = await admitToGroup(conversation, input.targetUserId, input.userId);
      return { joinRequest, conversation: await withUnreadOne(input.userId, updated) };
    },

    async listPublicConversations(input) {
      const channels = requireChannelStorage();
      requireNonEmptyId(input.userId, "userId");

      const { conversations, nextCursor } = await channels.listPublicConversations({
        limit: normalizeLimit(input.limit),
        cursor: input.cursor,
      });

      // `requestPending` needs the invite capability, which channels do not
      // require: an all-`open` directory works without it. Without it nothing is
      // ever pending, which is the truth for that adapter.
      const invites = storage.invites;
      const pending = new Set<string>();
      if (invites) {
        const rows = await Promise.all(
          conversations.map(async (conversation) => {
            const request = await invites.getJoinRequest({
              conversationId: conversation.id,
              userId: input.userId,
            });
            return request && request.status === "pending" ? conversation.id : null;
          }),
        );
        for (const id of rows) if (id !== null) pending.add(id);
      }

      return {
        channels: conversations.map((conversation) => ({
          conversationId: conversation.id,
          name: conversation.name,
          participantCount: conversation.participants.length,
          joinPolicy: conversation.joinPolicy,
          createdAt: conversation.createdAt,
          metadata: conversation.metadata,
          alreadyParticipant: conversation.participants.some((p) => p.userId === input.userId),
          requestPending: pending.has(conversation.id),
        })),
        nextCursor,
      };
    },

    async joinConversation(input) {
      requireChannelStorage();
      requireNonEmptyId(input.userId, "userId");
      const message = normalizeJoinMessage(input.message);
      const conversation = await requireConversation(input.conversationId);

      // 403, not 404: core knows the row exists, and a 404 here is a lie it
      // would then have to tell consistently everywhere else (ADR 0020 §7).
      // The group check comes first only so a DM gets the more specific error.
      requireGroup(conversation);
      if (conversation.visibility !== "public") {
        throw new ChatpackError(
          "NOT_PUBLIC_CONVERSATION",
          `Conversation "${conversation.id}" is not a public channel - you need an invite.`,
        );
      }

      // No truthful "you joined" to return, and unlike a replayed invite
      // redemption there is no link use to protect (ADR 0019 §5).
      if (conversation.participants.some((p) => p.userId === input.userId)) {
        throw new ChatpackError(
          "ALREADY_PARTICIPANT",
          `User "${input.userId}" is already a participant of conversation "${conversation.id}".`,
        );
      }

      if (conversation.joinPolicy === "approval") {
        // The queue is invite storage, so an approval channel needs that
        // capability too - checked here rather than at the top, because an
        // all-`open` directory legitimately has no use for it.
        const invites = requireInviteStorage();
        const existing = await invites.getJoinRequest({
          conversationId: conversation.id,
          userId: input.userId,
        });
        // Same idempotency as `requestToJoin`: re-asking while pending returns
        // the same row rather than bumping yourself up a newest-first queue.
        if (existing && existing.status === "pending") {
          return { status: "pending", conversation: null, joinRequest: existing };
        }

        const joinRequest = await invites.createJoinRequest({
          conversationId: conversation.id,
          userId: input.userId,
          message,
          // No invite was presented - the channel's own policy sent them here.
          inviteCode: null,
          metadata: {},
        });
        return { status: "pending", conversation: null, joinRequest };
      }

      // Open channel: the joiner is their own actor. Nobody vouched for them,
      // and the channel being public is the authorization.
      const updated = await admitToGroup(conversation, input.userId, input.userId);
      return {
        status: "joined",
        conversation: await withUnreadOne(input.userId, updated),
        joinRequest: null,
      };
    },
  };

  const pluginRuntime: PluginRuntime = createPluginRuntime(options.plugins ?? [], api, transport);

  return {
    api,
    handler: (handlerOptions?: HandlerOptions) =>
      createHandler(
        api,
        options.auth,
        handlerOptions,
        transport,
        pluginRuntime,
        // Left undefined when bans are not enforced, so neither the pre-routing
        // check nor the SSE heartbeat re-check runs at all.
        banEnforcement === null
          ? undefined
          : async (userId) => Boolean(await banEnforcement.isUserBanned(userId)),
      ),
    transport,
    telemetry,
    options,
  };
}
