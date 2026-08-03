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
  AfterMessageSendContext,
} from "./config";

// Domain types
export type {
  Conversation,
  ConversationWithUnread,
  Participant,
  Message,
  MessageReference,
  MessageRole,
  MessageWithDetails,
  Metadata,
  Reaction,
  ReactionSummary,
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
  UpdateMessageInput,
  UpdateLastReadInput,
  CountUnreadInput,
} from "./storage";

// HTTP handler (M2) + SSE (M3)
export { createHandler, type ChatpackHandler, type HandlerOptions } from "./handler";

// Transport (M3) - live event pub/sub
export {
  inProcessTransport,
  isEphemeralEvent,
  isMessageEvent,
  isReactionEvent,
  type Transport,
  type ChatEvent,
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
