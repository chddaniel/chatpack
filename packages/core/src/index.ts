/**
 * `@chatpack/core` - open-source chat infrastructure for developers.
 *
 * The public surface is intentionally small (MVP §2): the {@link chatpack}
 * factory, the {@link StorageAdapter} contract for adapter authors, and the
 * domain types.
 *
 * @module
 */

// Factory + engine types
export {
  chatpack,
  pairKeyFor,
  MAX_CONVERSATION_NAME_LENGTH,
  MAX_GROUP_PARTICIPANTS,
  MAX_INVITES_PER_CONVERSATION,
  MAX_JOIN_REQUEST_MESSAGE_LENGTH,
  MAX_MENTIONS_PER_MESSAGE,
  type ChatpackApi,
  type ChatpackInstance,
  type GetOrCreateConversationInput,
  type GetConversationInput,
  type ListConversationsApiInput,
  type ListConversationsApiResult,
  type SendMessageInput,
  type ListMessagesApiInput,
  type ListMessagesApiResult,
  type SearchMessagesApiInput,
  type SearchMessagesApiResult,
  type ListMessagesAfterInput,
  type EditMessageInput,
  type DeleteMessageInput,
  type MarkReadInput,
  type ReactionApiInput,
  // Group conversations (docs/decisions/0017)
  type CreateGroupConversationApiInput,
  type AddParticipantsApiInput,
  type RemoveParticipantApiInput,
  type SetParticipantRoleApiInput,
  type UpdateConversationApiInput,
  // Invite links + join requests (docs/decisions/0019)
  type CreateInviteApiInput,
  type ListInvitesApiInput,
  type RevokeInviteApiInput,
  type InviteCodeApiInput,
  type AcceptInviteApiInput,
  type AcceptInviteResult,
  type RequestToJoinApiInput,
  type ListJoinRequestsApiInput,
  type ResolveJoinRequestApiInput,
  type ResolveJoinRequestApiResult,
  // Public channels (docs/decisions/0020)
  type ListPublicConversationsApiInput,
  type ListPublicConversationsApiResult,
  type JoinConversationApiInput,
  type JoinConversationResult,
  // Message forwarding (docs/decisions/0024)
  type ForwardMessageInput,
} from "./chatpack";

// Configuration
export type {
  ChatpackOptions,
  ChatpackUser,
  AuthHook,
  PermissionContext,
  PermissionHooks,
  MessageHooks,
  BeforeMessageSendContext,
  BeforeMessageSendResult,
  AfterMessageMutationContext,
  AfterMessageSendContext,
  MessageMutationAction,
  ModerationPermissionContext,
  CanModerateHook,
} from "./config";

// Domain types
export type {
  Conversation,
  ConversationType,
  ConversationWithUnread,
  Participant,
  ParticipantRole,
  Message,
  MessageReference,
  MessageRole,
  MessageWithDetails,
  Metadata,
  Reaction,
  ReactionSummary,
  // Mentions (docs/decisions/0023) + forwarding (docs/decisions/0024)
  MessageMention,
  ForwardProvenance,
  // Invite links + join requests (docs/decisions/0019)
  ConversationInvite,
  InvitePreview,
  JoinRequest,
  JoinRequestStatus,
  // Public channels (docs/decisions/0020)
  ChannelJoinPolicy,
  ChannelPreview,
  ChannelVisibility,
  UserBlock,
  ConversationMute,
  ReportTargetType,
  ReportStatus,
  ReportEvidence,
  ModerationReport,
  UserBan,
} from "./types";

// Storage adapter contract (for adapter authors)
export type {
  StorageAdapter,
  GetOrCreateDirectConversationInput,
  GetOrCreateDirectConversationResult,
  ListConversationsInput,
  ListConversationsResult,
  AddMessageInput,
  ListMessagesInput,
  ListMessagesResult,
  SearchMessagesInput,
  SearchMessagesResult,
  ListMessagesAfterSeqInput,
  ReactionInput,
  SetMessageMentionsInput,
  UpdateMessageInput,
  UpdateLastReadInput,
  CountUnreadInput,
  // Group conversations (docs/decisions/0017)
  CreateGroupConversationInput,
  AddParticipantsInput,
  RemoveParticipantInput,
  SetParticipantRoleInput,
  UpdateConversationInput,
  // Invite links + join requests (docs/decisions/0019) - optional capability
  InviteStorage,
  CreateInviteInput,
  DeleteInviteInput,
  CreateJoinRequestInput,
  GetJoinRequestInput,
  ListJoinRequestsInput,
  ResolveJoinRequestInput,
  // Public channels (docs/decisions/0020) - optional capability
  ChannelStorage,
  ListPublicConversationsInput,
  ListPublicConversationsResult,
  ModerationStorage,
  ModerationPage,
  BlockUserInput as StorageBlockUserInput,
  ListBlocksInput,
  MuteConversationInput as StorageMuteConversationInput,
  ListMutesInput,
  CreateReportInput,
  ListReportsInput as StorageListReportsInput,
  UpdateReportInput as StorageUpdateReportInput,
  CreateBanInput,
  ListBansInput as StorageListBansInput,
  RevokeBanInput,
} from "./storage";

// Moderation API contracts
export type {
  ModerationAction,
  ModerationApi,
  BlockUserInput,
  ListModerationInput,
  MuteConversationInput,
  ReportInput,
  ListReportsInput,
  UpdateReportInput,
  BanUserInput,
  ListBansInput,
  UnbanUserInput,
} from "./moderation";

// Canonical message-search semantics for first-party adapters.
export { countSearchTokens, getSearchTerms, scoreSearchTerms, tokenizeSearch } from "./search";

// HTTP handler (M2) + SSE (M3)
export { createHandler, type ChatpackHandler, type HandlerOptions } from "./handler";

// Transport (M3) - live event pub/sub
export {
  inProcessTransport,
  isConversationEvent,
  isEphemeralEvent,
  isMessageEvent,
  isReactionEvent,
  type Transport,
  type ChatEvent,
  type ConversationEvent,
  type EphemeralEvent,
  type ReactionEvent,
  type TransportEvent,
  type TransportListener,
} from "./transport";

// Plugin seam (docs/decisions/0008) - first-party plugins live in
// `@chatpack/core/plugins`; these types are for plugin authors.
export type {
  ChatpackPlugin,
  PluginContext,
  PluginRequestContext,
  PluginCapabilityRequestContext,
  PluginBeforeMessageSendContext,
  PluginStreamContext,
  PluginMarkReadContext,
  PluginEventDeliveredContext,
  PublishEphemeralInput,
} from "./plugin";

// Errors
export { ChatpackError, type ChatpackErrorCode } from "./errors";

// Telemetry (MVP §12 - anonymous aggregate counters + fire-and-forget flusher)
export {
  TelemetryCounters,
  startTelemetryFlusher,
  DEFAULT_TELEMETRY_ENDPOINT,
  DEFAULT_FLUSH_INTERVAL_MS,
  type TelemetryCounterName,
  type TelemetrySnapshot,
  type TelemetryPayload,
  type TelemetryFlusherOptions,
} from "./telemetry";

// Package version
export { VERSION } from "./version";
