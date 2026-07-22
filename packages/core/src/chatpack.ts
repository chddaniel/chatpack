/**
 * The Chatpack core engine (M1): 1:1 domain logic, permission checks, and
 * validation, driven through a {@link StorageAdapter}.
 *
 * @module
 */

import type { ChatpackOptions, ChatpackUser, PermissionContext } from "./config";
import { ChatpackError } from "./errors";
import { createHandler, type ChatpackHandler, type HandlerOptions } from "./handler";
import type { StorageAdapter } from "./storage";
import { TelemetryCounters, resolveTelemetryEnabled } from "./telemetry";
import type { Conversation, Message, Metadata, MessageRole } from "./types";

/** Default page size for list endpoints. */
const DEFAULT_LIMIT = 50;
/** Hard cap for list endpoints. */
const MAX_LIMIT = 200;

/**
 * Compute the deterministic pair key for two user ids: sorted and joined with
 * `":"`. Guarantees one direct conversation per user pair (MVP §8) — see
 * `docs/decisions/0002-pair-key.md`.
 */
export function pairKeyFor(userIdA: string, userIdB: string): string {
  return [userIdA, userIdB].sort().join(":");
}

/** Input for {@link ChatpackApi.getOrCreateConversation}. */
export interface GetOrCreateConversationInput {
  /** The requesting (current) user. */
  userId: string;
  /** The other participant. */
  otherUserId: string;
  /** Metadata to set if the conversation is created. */
  metadata?: Metadata;
}

/** Input for {@link ChatpackApi.listConversations}. */
export interface ListConversationsApiInput {
  userId: string;
  limit?: number;
  cursor?: string;
}

/** Result of {@link ChatpackApi.listConversations}. */
export interface ListConversationsApiResult {
  conversations: Conversation[];
  nextCursor: string | null;
}

/** Input for {@link ChatpackApi.getConversation}. */
export interface GetConversationInput {
  userId: string;
  conversationId: string;
}

/** Input for {@link ChatpackApi.sendMessage}. */
export interface SendMessageInput {
  userId: string;
  conversationId: string;
  /** Message text. Must be non-empty. */
  body: string;
  /** Defaults to `"user"`. AI escape hatch only. */
  role?: MessageRole;
  metadata?: Metadata;
}

/** Input for {@link ChatpackApi.listMessages}. */
export interface ListMessagesApiInput {
  userId: string;
  conversationId: string;
  limit?: number;
  cursor?: string;
}

/** Result of {@link ChatpackApi.listMessages}. */
export interface ListMessagesApiResult {
  /** Newest-first (descending `seq`). */
  messages: Message[];
  nextCursor: string | null;
}

/** Input for {@link ChatpackApi.editMessage}. */
export interface EditMessageInput {
  userId: string;
  messageId: string;
  /** The new body. Must be non-empty. */
  body: string;
}

/** Input for {@link ChatpackApi.deleteMessage}. */
export interface DeleteMessageInput {
  userId: string;
  messageId: string;
}

/** Input for {@link ChatpackApi.markRead}. */
export interface MarkReadInput {
  userId: string;
  conversationId: string;
  /** The last message the user has read. */
  messageId: string;
}

/**
 * The server-side core API. Every method takes the acting `userId` explicitly
 * and enforces permissions before touching storage.
 */
export interface ChatpackApi {
  /**
   * Find or create the direct conversation between `userId` and
   * `otherUserId`. Idempotent per user pair.
   */
  getOrCreateConversation(input: GetOrCreateConversationInput): Promise<Conversation>;

  /** List the conversations `userId` participates in, most-recently-active first. */
  listConversations(input: ListConversationsApiInput): Promise<ListConversationsApiResult>;

  /** Fetch one conversation. Requires read permission. */
  getConversation(input: GetConversationInput): Promise<Conversation>;

  /** Send a text message. Requires write permission. */
  sendMessage(input: SendMessageInput): Promise<Message>;

  /** List messages newest-first with cursor pagination. Requires read permission. */
  listMessages(input: ListMessagesApiInput): Promise<ListMessagesApiResult>;

  /** Edit a message's body. Only the original sender may edit. */
  editMessage(input: EditMessageInput): Promise<Message>;

  /** Soft-delete a message. Only the original sender may delete. */
  deleteMessage(input: DeleteMessageInput): Promise<Message>;

  /** Update the caller's durable read-state in a conversation. */
  markRead(input: MarkReadInput): Promise<void>;
}

/** The object returned by {@link chatpack}. */
export interface ChatpackInstance {
  /** The server-side core API. */
  api: ChatpackApi;
  /**
   * Mount the whole REST API on one route (M2). Web-standard
   * `Request`/`Response`, so it works on Next.js App Router, Bun, Deno, and
   * Workers alike. Requires the `auth` option.
   *
   * @example Next.js App Router
   * ```ts
   * // app/api/chat/[...chatpack]/route.ts
   * import { chat } from "@/lib/chat";
   * export const { GET, POST, PATCH, DELETE } = chat.handler();
   * ```
   */
  handler(options?: HandlerOptions): ChatpackHandler;
  /** In-process anonymous telemetry counters (MVP §12). */
  telemetry: TelemetryCounters;
  /** The options this instance was created with (used by handlers in M2+). */
  options: ChatpackOptions;
}

/**
 * Create a Chatpack instance — the single entry point of `@chatpack/core`.
 *
 * @example
 * ```ts
 * import { chatpack } from "@chatpack/core";
 * import { memoryAdapter } from "@chatpack/adapter-memory";
 *
 * export const chat = chatpack({
 *   storage: memoryAdapter(),
 *   auth: async (req) => getSessionUser(req),
 * });
 * ```
 */
export function chatpack(options: ChatpackOptions): ChatpackInstance {
  const storage: StorageAdapter = options.storage;
  const telemetry = new TelemetryCounters(resolveTelemetryEnabled(options.telemetry));

  const defaultPermission = (ctx: PermissionContext): boolean =>
    ctx.conversation.participantIds.includes(ctx.user.id);

  const canRead = options.permissions?.canRead ?? defaultPermission;
  const canWrite = options.permissions?.canWrite ?? defaultPermission;

  function toPermissionContext(userId: string, conversation: Conversation): PermissionContext {
    const user: ChatpackUser = { id: userId };
    return {
      user,
      conversation: {
        ...conversation,
        participantIds: conversation.participants.map((p) => p.userId),
      },
    };
  }

  async function requireConversation(conversationId: string): Promise<Conversation> {
    const conversation = await storage.getConversation(conversationId);
    if (!conversation) {
      throw new ChatpackError(
        "CONVERSATION_NOT_FOUND",
        `Conversation "${conversationId}" was not found.`,
      );
    }
    return conversation;
  }

  async function requireRead(userId: string, conversation: Conversation): Promise<void> {
    const allowed = await canRead(toPermissionContext(userId, conversation));
    if (!allowed) {
      throw new ChatpackError(
        "FORBIDDEN_READ",
        `User "${userId}" may not read conversation "${conversation.id}".`,
      );
    }
  }

  async function requireWrite(userId: string, conversation: Conversation): Promise<void> {
    const allowed = await canWrite(toPermissionContext(userId, conversation));
    if (!allowed) {
      throw new ChatpackError(
        "FORBIDDEN_WRITE",
        `User "${userId}" may not write to conversation "${conversation.id}".`,
      );
    }
  }

  function normalizeLimit(limit: number | undefined): number {
    if (limit === undefined) return DEFAULT_LIMIT;
    if (!Number.isInteger(limit) || limit < 1) {
      throw new ChatpackError("INVALID_INPUT", `"limit" must be a positive integer, got ${limit}.`);
    }
    return Math.min(limit, MAX_LIMIT);
  }

  function requireNonEmptyId(value: string, field: string): void {
    if (typeof value !== "string" || value.trim() === "") {
      throw new ChatpackError("INVALID_INPUT", `"${field}" must be a non-empty string.`);
    }
  }

  const api: ChatpackApi = {
    async getOrCreateConversation(input) {
      requireNonEmptyId(input.userId, "userId");
      requireNonEmptyId(input.otherUserId, "otherUserId");
      if (input.userId === input.otherUserId) {
        throw new ChatpackError(
          "INVALID_INPUT",
          "A direct conversation requires two distinct users.",
        );
      }

      const userIds = [input.userId, input.otherUserId].sort() as [string, string];
      const { conversation, created } = await storage.getOrCreateDirectConversation({
        pairKey: pairKeyFor(input.userId, input.otherUserId),
        userIds,
        metadata: input.metadata ?? {},
      });

      if (created) telemetry.increment("conversationsCreated");
      return conversation;
    },

    async listConversations(input) {
      requireNonEmptyId(input.userId, "userId");
      const { conversations, nextCursor } = await storage.listConversations({
        userId: input.userId,
        limit: normalizeLimit(input.limit),
        cursor: input.cursor,
      });
      return { conversations, nextCursor };
    },

    async getConversation(input) {
      requireNonEmptyId(input.userId, "userId");
      const conversation = await requireConversation(input.conversationId);
      await requireRead(input.userId, conversation);
      return conversation;
    },

    async sendMessage(input) {
      requireNonEmptyId(input.userId, "userId");
      if (typeof input.body !== "string" || input.body.trim() === "") {
        throw new ChatpackError("INVALID_INPUT", "Message body must be a non-empty string.");
      }

      const conversation = await requireConversation(input.conversationId);
      await requireWrite(input.userId, conversation);

      const message = await storage.addMessage({
        conversationId: conversation.id,
        senderId: input.userId,
        body: input.body,
        role: input.role ?? "user",
        metadata: input.metadata ?? {},
      });

      telemetry.increment("messagesSent");
      // M3: publish `message.created` on the transport here (durable-first).
      return message;
    },

    async listMessages(input) {
      requireNonEmptyId(input.userId, "userId");
      const conversation = await requireConversation(input.conversationId);
      await requireRead(input.userId, conversation);

      const { messages, nextCursor } = await storage.listMessages({
        conversationId: conversation.id,
        limit: normalizeLimit(input.limit),
        cursor: input.cursor,
      });
      return { messages, nextCursor };
    },

    async editMessage(input) {
      requireNonEmptyId(input.userId, "userId");
      if (typeof input.body !== "string" || input.body.trim() === "") {
        throw new ChatpackError("INVALID_INPUT", "Message body must be a non-empty string.");
      }

      const existing = await storage.getMessage(input.messageId);
      if (!existing) {
        throw new ChatpackError("MESSAGE_NOT_FOUND", `Message "${input.messageId}" was not found.`);
      }
      if (existing.deletedAt) {
        throw new ChatpackError("MESSAGE_DELETED", "A deleted message cannot be edited.");
      }
      if (existing.senderId !== input.userId) {
        throw new ChatpackError("NOT_MESSAGE_SENDER", "Only the sender can edit a message.");
      }

      const conversation = await requireConversation(existing.conversationId);
      await requireWrite(input.userId, conversation);

      const updated = await storage.updateMessage({
        messageId: existing.id,
        body: input.body,
        editedAt: new Date(),
      });
      // M3: publish `message.updated` on the transport here.
      return updated;
    },

    async deleteMessage(input) {
      requireNonEmptyId(input.userId, "userId");

      const existing = await storage.getMessage(input.messageId);
      if (!existing) {
        throw new ChatpackError("MESSAGE_NOT_FOUND", `Message "${input.messageId}" was not found.`);
      }
      if (existing.senderId !== input.userId) {
        throw new ChatpackError("NOT_MESSAGE_SENDER", "Only the sender can delete a message.");
      }
      if (existing.deletedAt) return existing; // idempotent

      const conversation = await requireConversation(existing.conversationId);
      await requireWrite(input.userId, conversation);

      const updated = await storage.updateMessage({
        messageId: existing.id,
        body: "",
        deletedAt: new Date(),
      });
      // M3: publish `message.deleted` on the transport here.
      return updated;
    },

    async markRead(input) {
      requireNonEmptyId(input.userId, "userId");
      const conversation = await requireConversation(input.conversationId);
      await requireRead(input.userId, conversation);

      const isParticipant = conversation.participants.some((p) => p.userId === input.userId);
      if (!isParticipant) {
        throw new ChatpackError(
          "FORBIDDEN_READ",
          "Only participants have read-state in a conversation.",
        );
      }

      const message = await storage.getMessage(input.messageId);
      if (!message || message.conversationId !== conversation.id) {
        throw new ChatpackError(
          "MESSAGE_NOT_FOUND",
          `Message "${input.messageId}" was not found in conversation "${conversation.id}".`,
        );
      }

      await storage.updateLastRead({
        conversationId: conversation.id,
        userId: input.userId,
        messageId: message.id,
      });
    },
  };

  return {
    api,
    handler: (handlerOptions?: HandlerOptions) => createHandler(api, options.auth, handlerOptions),
    telemetry,
    options,
  };
}
