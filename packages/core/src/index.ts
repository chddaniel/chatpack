/**
 * `@chatpack/core` — open-source chat infrastructure for developers.
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
  type ListMessagesAfterInput,
  type EditMessageInput,
  type DeleteMessageInput,
  type MarkReadInput,
} from "./chatpack";

// Configuration
export type {
  ChatpackOptions,
  ChatpackUser,
  AuthHook,
  PermissionContext,
  PermissionHooks,
} from "./config";

// Domain types
export type { Conversation, Participant, Message, MessageRole, Metadata } from "./types";

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
  ListMessagesAfterSeqInput,
  UpdateMessageInput,
  UpdateLastReadInput,
} from "./storage";

// HTTP handler (M2) + SSE (M3)
export { createHandler, type ChatpackHandler, type HandlerOptions } from "./handler";

// Transport (M3) — live event pub/sub
export {
  inProcessTransport,
  type Transport,
  type ChatEvent,
  type TransportListener,
} from "./transport";

// Errors
export { ChatpackError, type ChatpackErrorCode } from "./errors";

// Telemetry (MVP §12 — counters now, flusher in M5)
export { TelemetryCounters, type TelemetryCounterName, type TelemetrySnapshot } from "./telemetry";
