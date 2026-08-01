import type { ConversationWithUnread, Message, Metadata, Participant } from "@chatpack/core";

export type Jsonify<T> = T extends Date
  ? string
  : T extends readonly (infer Item)[]
    ? Jsonify<Item>[]
    : T extends object
      ? { [Key in keyof T]: Jsonify<T[Key]> }
      : T;

export type ClientConversation = Jsonify<ConversationWithUnread>;
export type ClientMessage = Jsonify<Message>;
export type ClientParticipant = Jsonify<Participant>;
export type ClientMetadata = Jsonify<Metadata>;

export interface ClientConversationPage {
  conversations: ClientConversation[];
  nextCursor: string | null;
}

export interface ClientMessagePage {
  messages: ClientMessage[];
  nextCursor: string | null;
}

export interface ClientPresence {
  online: boolean;
  lastSeenAt: string | null;
}

export interface ClientPresenceResponse {
  presence: Record<string, ClientPresence>;
}

export interface ClientOkResponse {
  ok: true;
}
