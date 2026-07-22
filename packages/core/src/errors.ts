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
  /** Stable machine-readable code — switch on this, not on `message`. */
  readonly code: ChatpackErrorCode;

  constructor(code: ChatpackErrorCode, message: string) {
    super(message);
    this.name = "ChatpackError";
    this.code = code;
  }
}
