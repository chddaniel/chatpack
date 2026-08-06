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
