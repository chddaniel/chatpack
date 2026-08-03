/** JSON wire types returned by the Chatpack HTTP handler. */

import type {
  ConversationWithUnread,
  MessageReference,
  MessageWithDetails,
  Metadata,
  Participant,
  ReactionSummary,
} from "@chatpack/core";

/** Recursively convert server `Date` values to JSON timestamp strings. */
export type Jsonify<T> = T extends Date
  ? string
  : T extends readonly (infer Item)[]
    ? Jsonify<Item>[]
    : T extends object
      ? { [Key in keyof T]: Jsonify<T[Key]> }
      : T;

/** Conversation shape returned over HTTP. */
export type ClientConversation = Jsonify<ConversationWithUnread>;
/**
 * Message shape returned over HTTP, including the server-hydrated `replyTo`
 * preview and `reactions` summary (ADR 0013).
 */
export type ClientMessage = Jsonify<MessageWithDetails>;
/** Quote-reply preview of a parent message. */
export type ClientMessageReference = Jsonify<MessageReference>;
/** Reactions of one kind on a message, grouped by emoji. */
export type ClientReactionSummary = Jsonify<ReactionSummary>;
/** Participant shape returned over HTTP. */
export type ClientParticipant = Jsonify<Participant>;
/** Metadata shape returned over HTTP. */
export type ClientMetadata = Jsonify<Metadata>;

/** Paginated conversation response. */
export interface ClientConversationPage {
  conversations: ClientConversation[];
  nextCursor: string | null;
}

/** Paginated message response, newest message first. */
export interface ClientMessagePage {
  messages: ClientMessage[];
  nextCursor: string | null;
}

/** Presence state returned by the presence plugin. */
export interface ClientPresence {
  online: boolean;
  lastSeenAt: string | null;
}

/** Presence snapshot response envelope. */
export interface ClientPresenceResponse {
  presence: Record<string, ClientPresence>;
}

/** Success response used by action-only plugin routes. */
export interface ClientOkResponse {
  ok: true;
}
