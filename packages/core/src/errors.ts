/**
 * Chatpack error types.
 *
 * Every failure from the core API is a {@link ChatpackError} with a stable
 * machine-readable `code`, so framework handlers (M2) can map errors to HTTP
 * statuses without string matching.
 *
 * @module
 */

/** Stable machine-readable error codes returned by the core API. */
export type ChatpackErrorCode =
  /** The configured storage adapter does not provide message search. */
  | "SEARCH_UNSUPPORTED"
  /** The requesting user is not allowed to read this conversation. */
  | "FORBIDDEN_READ"
  /** The requesting user is not allowed to write to this conversation. */
  | "FORBIDDEN_WRITE"
  /** The conversation does not exist. */
  | "CONVERSATION_NOT_FOUND"
  /** The message does not exist. */
  | "MESSAGE_NOT_FOUND"
  /** Only the original sender can edit or delete a message. */
  | "NOT_MESSAGE_SENDER"
  /** The message was soft-deleted and can no longer be edited. */
  | "MESSAGE_DELETED"
  /** A `beforeMessageSend` hook rejected the message (`docs/decisions/0011`). */
  | "MESSAGE_REJECTED"
  /**
   * An admin-only group action was attempted by a plain member
   * (`docs/decisions/0017`).
   */
  | "NOT_CONVERSATION_ADMIN"
  /**
   * Membership or rename was attempted on a direct conversation - a DM has
   * fixed membership and no name (`docs/decisions/0017`).
   */
  | "NOT_GROUP_CONVERSATION"
  /**
   * Removing or demoting the group's only admin. Chatpack refuses rather than
   * auto-promoting someone, because every selection rule would be an unstated
   * policy decision (`docs/decisions/0017`).
   */
  | "LAST_ADMIN_REMAINING"
  /** The group would exceed `MAX_GROUP_PARTICIPANTS` (`docs/decisions/0017`). */
  | "GROUP_LIMIT_EXCEEDED"
  /**
   * The configured storage adapter does not provide invite storage - it has no
   * `invites` capability (`docs/decisions/0019` §2).
   */
  | "INVITES_UNSUPPORTED"
  /**
   * No such invite code. A revoked invite is deliberately indistinguishable
   * from one that never existed (`docs/decisions/0019`).
   */
  | "INVITE_NOT_FOUND"
  /**
   * The invite is past its `expiresAt` or has exhausted its `maxUses`. One
   * code covers both because the client handling is identical - ask for a new
   * link (`docs/decisions/0019` §9).
   */
  | "INVITE_EXPIRED"
  /**
   * The group already holds `MAX_INVITES_PER_CONVERSATION` invites
   * (`docs/decisions/0019`).
   */
  | "INVITE_LIMIT_EXCEEDED"
  /** No join request exists for that user in that conversation. */
  | "JOIN_REQUEST_NOT_FOUND"
  /**
   * The caller asked to join a conversation they are already in. Unlike a
   * replayed invite redemption there is no truthful success value to return
   * here (`docs/decisions/0019` §5).
   */
  | "ALREADY_PARTICIPANT"
  /**
   * The configured storage adapter does not provide the channel directory - it
   * has no `channels` capability. Also raised when creating or updating a
   * conversation with a non-default `visibility` or `joinPolicy`, so an adapter
   * that ignores those fields cannot silently hand back a private group
   * (`docs/decisions/0020` §4).
   */
  | "CHANNELS_UNSUPPORTED"
  /**
   * Joining was attempted on a conversation that is not a public channel - a
   * private group, or a DM. Deliberately 403 rather than 404: core knows the
   * row exists, and a lie it would have to keep telling consistently is worse
   * than a refusal (`docs/decisions/0020` §7).
   */
  | "NOT_PUBLIC_CONVERSATION"
  /** The configured storage adapter has no moderation capability. */
  | "MODERATION_UNSUPPORTED"
  /** The authenticated Chatpack user has an active ban. */
  | "USER_BANNED"
  /** The host moderator hook denied an admin operation. */
  | "NOT_MODERATOR"
  /** A direct conversation is blocked by either participant. */
  | "DIRECT_INTERACTION_BLOCKED"
  /** A moderation report was not found. */
  | "REPORT_NOT_FOUND"
  /** A moderation ban was not found. */
  | "BAN_NOT_FOUND"
  /**
   * A message mentioned someone who is not a participant of its conversation
   * (`docs/decisions/0023` §2).
   *
   * Rejected rather than silently dropped: a dropped mention is invisible, so
   * the sender would assume a notification went out that never did. Only ids
   * **new** to an edit are checked - a stored mention of someone who has since
   * left keeps working, or fixing a typo would mean dropping a mention that was
   * valid when it was made.
   */
  | "MENTION_NOT_PARTICIPANT"
  /** Invalid input (empty body, self-conversation, bad limit, ...). */
  | "INVALID_INPUT";

/**
 * The error thrown by all Chatpack core API methods.
 *
 * @example
 * ```ts
 * try {
 *   await chat.api.sendMessage({ ... });
 * } catch (err) {
 *   if (err instanceof ChatpackError && err.code === "FORBIDDEN_WRITE") {
 *     // respond 403
 *   }
 * }
 * ```
 */
export class ChatpackError extends Error {
  /** Stable machine-readable code - switch on this, not on `message`. */
  readonly code: ChatpackErrorCode;

  constructor(code: ChatpackErrorCode, message: string) {
    super(message);
    this.name = "ChatpackError";
    this.code = code;
  }
}
