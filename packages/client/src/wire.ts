/** JSON wire types returned by the Chatpack HTTP handler. */

import type { ConversationWithUnread, Message, Metadata, Participant } from "@chatpack/core";

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
/** Message shape returned over HTTP. */
export type ClientMessage = Jsonify<Message>;
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
