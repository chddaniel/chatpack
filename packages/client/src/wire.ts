/** JSON wire types returned by the Chatpack HTTP handler. */

import type {
  AcceptInviteResult,
  ChannelPreview,
  Conversation,
  ConversationInvite,
  ConversationWithUnread,
  InvitePreview,
  JoinConversationResult,
  JoinRequest,
  MessageReference,
  MessageWithDetails,
  Metadata,
  ConversationMute,
  ModerationReport,
  UserBan,
  UserBlock,
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
 * Conversation shape carried by a `participant.*` / `conversation.updated`
 * stream event (ADR 0017). Unlike {@link ClientConversation} it has no
 * `unreadCount`: that field is viewer-relative and computed per request
 * (ADR 0009), while one stream event fans out to every recipient.
 */
export type ClientConversationSnapshot = Jsonify<Conversation>;
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
/** Invite returned over HTTP. */
export type ClientConversationInvite = Jsonify<ConversationInvite>;
/** Thin invite data visible before acceptance. */
export type ClientInvitePreview = Jsonify<InvitePreview>;
/** Join request returned over HTTP. */
export type ClientJoinRequest = Jsonify<JoinRequest>;
/** Thin public-channel directory row. */
export type ClientChannelPreview = Jsonify<ChannelPreview>;
/** Result of accepting an invite. */
export type ClientAcceptInviteResult = Jsonify<AcceptInviteResult>;
/** Result of joining a public channel. */
export type ClientJoinConversationResult = Jsonify<JoinConversationResult>;
/** User block returned over HTTP. */
export type ClientUserBlock = Jsonify<UserBlock>;
/** Conversation mute returned over HTTP. */
export type ClientConversationMute = Jsonify<ConversationMute>;
/** Moderation report returned over HTTP. */
export type ClientModerationReport = Jsonify<ModerationReport>;
/** User ban returned over HTTP. */
export type ClientUserBan = Jsonify<UserBan>;

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

/** Public-channel directory response. */
export interface ClientChannelPage {
  channels: ClientChannelPreview[];
  nextCursor: string | null;
}

/** Generic cursor-paginated moderation response. */
export interface ClientModerationPage<T> {
  items: T[];
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
