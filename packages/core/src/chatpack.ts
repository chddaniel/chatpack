/**
 * The Chatpack core engine (M1): 1:1 domain logic, permission checks, and
 * validation, driven through a {@link StorageAdapter}.
 *
 * @module
 */

import type {
  AfterMessageMutationContext,
  BeforeMessageSendContext,
  ChatpackOptions,
  ChatpackUser,
  PermissionContext,
} from "./config";
import { ChatpackError } from "./errors";
import { createHandler, type ChatpackHandler, type HandlerOptions } from "./handler";
import { createPluginRuntime } from "./plugin";
import type { StorageAdapter } from "./storage";
import { inProcessTransport, type ChatEvent, type Transport } from "./transport";
import { TelemetryCounters, resolveTelemetryEnabled, startTelemetryFlusher } from "./telemetry";
import type {
  Conversation,
  ConversationWithUnread,
  Message,
  MessageReference,
  MessageWithDetails,
  Metadata,
  MessageRole,
  Reaction,
  ReactionSummary,
} from "./types";

/** Default page size for list endpoints. */
const DEFAULT_LIMIT = 50;
/** Hard cap for list endpoints. */
const MAX_LIMIT = 200;
/** Max length of a reaction key (ADR 0013 §3). */
const MAX_EMOJI_LENGTH = 32;
/** How much of a quoted parent body a reply preview carries (ADR 0013 §1). */
const EXCERPT_LENGTH = 140;

/**
 * Compute the deterministic pair key for two user ids: sorted and joined with
 * `":"`. Guarantees one direct conversation per user pair (MVP §8) - see
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
  conversations: ConversationWithUnread[];
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
  /**
   * Quote-reply to this message (`docs/decisions/0013`). Must be a message in
   * the same conversation, else `MESSAGE_NOT_FOUND`. Replying to a
   * soft-deleted message is allowed - the parent can be deleted between
   * render and send.
   */
  replyToMessageId?: string;
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
  /** Newest-first (descending `seq`), with `replyTo` and `reactions` hydrated. */
  messages: MessageWithDetails[];
  nextCursor: string | null;
}

/** Input for {@link ChatpackApi.searchMessages}. */
export interface SearchMessagesApiInput {
  userId: string;
  /** Plain-text terms to search for, case-insensitively. */
  query: string;
  limit?: number;
  cursor?: string;
}

/** Result of {@link ChatpackApi.searchMessages}. */
export interface SearchMessagesApiResult {
  messages: MessageWithDetails[];
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

/** Input for {@link ChatpackApi.listMessagesAfter}. */
export interface ListMessagesAfterInput {
  userId: string;
  conversationId: string;
  /** Return messages with `seq` strictly greater than this. */
  afterSeq: number;
  /** Max messages to return. */
  limit?: number;
}

/** Input for {@link ChatpackApi.addReaction} and {@link ChatpackApi.removeReaction}. */
export interface ReactionApiInput {
  /** The reacting user. A caller can only ever react as themselves. */
  userId: string;
  messageId: string;
  /**
   * The reaction key: any non-empty string, trimmed, up to 32 characters
   * (ADR 0013 §3). Not validated as an emoji.
   */
  emoji: string;
}

/**
 * The server-side core API. Every method takes the acting `userId` explicitly
 * and enforces permissions at the core boundary around storage access.
 */
export interface ChatpackApi {
  /**
   * Find or create the direct conversation between `userId` and
   * `otherUserId`. Idempotent per user pair.
   */
  getOrCreateConversation(input: GetOrCreateConversationInput): Promise<ConversationWithUnread>;

  /** List the conversations `userId` participates in, most-recently-active first. */
  listConversations(input: ListConversationsApiInput): Promise<ListConversationsApiResult>;

  /**
   * Fetch one conversation. Requires read permission. Throws
   * `CONVERSATION_NOT_FOUND` for unknown ids - unlike
   * `StorageAdapter.getConversation`, it never resolves to `null`.
   */
  getConversation(input: GetConversationInput): Promise<ConversationWithUnread>;

  /** Send a text message, optionally quote-replying to another. Requires write permission. */
  sendMessage(input: SendMessageInput): Promise<MessageWithDetails>;

  /** List messages newest-first with cursor pagination. Requires read permission. */
  listMessages(input: ListMessagesApiInput): Promise<ListMessagesApiResult>;

  /** Search non-tombstone messages in the user's participant conversations. */
  searchMessages(input: SearchMessagesApiInput): Promise<SearchMessagesApiResult>;

  /** Edit a message's body. Only the original sender may edit. */
  editMessage(input: EditMessageInput): Promise<MessageWithDetails>;

  /** Soft-delete a message. Only the original sender may delete. */
  deleteMessage(input: DeleteMessageInput): Promise<MessageWithDetails>;

  /**
   * React to a message as `userId` (`docs/decisions/0013`). Idempotent -
   * reacting twice with the same emoji leaves one reaction. Requires write
   * permission, like editing: it is a mutation the other participant sees.
   */
  addReaction(input: ReactionApiInput): Promise<MessageWithDetails>;

  /**
   * Remove one of `userId`'s own reactions. Idempotent - removing a reaction
   * that was never there is a silent no-op.
   */
  removeReaction(input: ReactionApiInput): Promise<MessageWithDetails>;

  /**
   * Update the caller's durable read-state in a conversation. Monotonic:
   * marking a message older than the current read-state is a silent no-op
   * (tolerates out-of-order client replays; never regresses unread counts).
   */
  markRead(input: MarkReadInput): Promise<void>;

  /**
   * Messages in a conversation with `seq` greater than `afterSeq`, oldest
   * first, with `replyTo` and `reactions` hydrated so a replayed frame is
   * indistinguishable from a live one. Used for SSE reconnection gap-fill
   * (MVP §9); requires read permission.
   */
  listMessagesAfter(input: ListMessagesAfterInput): Promise<MessageWithDetails[]>;
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
  /**
   * The live-event transport (M3). Defaults to the single-node in-process
   * implementation; the SSE endpoint subscribes to it.
   */
  transport: Transport;
  /** In-process anonymous telemetry counters (MVP §12). */
  telemetry: TelemetryCounters;
  /** The options this instance was created with (used by handlers in M2+). */
  options: ChatpackOptions;
}

/**
 * Create a Chatpack instance - the single entry point of `@chatpack/core`.
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
  if (options.hooks?.afterMessageMutation && options.hooks.afterMessageSend) {
    throw new ChatpackError(
      "INVALID_INPUT",
      "Configure either hooks.afterMessageMutation or the deprecated hooks.afterMessageSend, not both.",
    );
  }

  const storage: StorageAdapter = options.storage;
  const transport: Transport = options.transport ?? inProcessTransport();
  const telemetry = new TelemetryCounters(resolveTelemetryEnabled(options.telemetry));
  // Fire-and-forget aggregate flush (MVP §12). No-op when disabled; the timer
  // is unref'd, so it never keeps the process alive.
  startTelemetryFlusher(telemetry);

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

  function getOtherParticipantId(conversation: Conversation, userId: string): string {
    const other = conversation.participants.find((participant) => participant.userId !== userId);
    if (!other) {
      throw new ChatpackError(
        "INVALID_INPUT",
        `Conversation "${conversation.id}" does not have another participant.`,
      );
    }
    return other.userId;
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
    const allowed = await canReadConversation(userId, conversation);
    if (!allowed) {
      throw new ChatpackError(
        "FORBIDDEN_READ",
        `User "${userId}" may not read conversation "${conversation.id}".`,
      );
    }
  }

  async function canReadConversation(userId: string, conversation: Conversation): Promise<boolean> {
    return canRead(toPermissionContext(userId, conversation));
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

  /**
   * Decorate conversations with the viewer's `unreadCount` - one batched
   * `countUnread` call per page. Missing keys mean 0 (adapters may omit
   * conversations with nothing unread).
   */
  async function withUnread(
    userId: string,
    conversations: Conversation[],
  ): Promise<ConversationWithUnread[]> {
    if (conversations.length === 0) return [];
    const counts = await storage.countUnread({
      userId,
      conversationIds: conversations.map((c) => c.id),
    });
    return conversations.map((c) => ({ ...c, unreadCount: counts[c.id] ?? 0 }));
  }

  async function withUnreadOne(
    userId: string,
    conversation: Conversation,
  ): Promise<ConversationWithUnread> {
    const [decorated] = await withUnread(userId, [conversation]);
    return decorated as ConversationWithUnread;
  }

  /** Publish a live event. Durable-first: storage write has already succeeded. */
  function publish(
    type: ChatEvent["type"],
    conversation: Conversation,
    message: MessageWithDetails,
  ): void {
    transport.publish({
      type,
      conversationId: conversation.id,
      recipientIds: conversation.participants.map((p) => p.userId),
      message,
    });
  }

  /** Validate a reaction key: non-empty after trimming, at most 32 chars. */
  function normalizeEmoji(value: string): string {
    if (typeof value !== "string" || value.trim() === "") {
      throw new ChatpackError("INVALID_INPUT", `"emoji" must be a non-empty string.`);
    }
    // Trim so "👍" and "👍 " can't become two separate buckets (ADR 0013 §3).
    const emoji = value.trim();
    if (emoji.length > MAX_EMOJI_LENGTH) {
      throw new ChatpackError(
        "INVALID_INPUT",
        `"emoji" must be at most ${MAX_EMOJI_LENGTH} characters, got ${emoji.length}.`,
      );
    }
    return emoji;
  }

  /** Build the read-only preview of a quoted parent message (ADR 0013 §1). */
  function toReference(parent: Message): MessageReference {
    const deleted = parent.deletedAt !== null;
    return {
      id: parent.id,
      senderId: parent.senderId,
      // A tombstone has an empty body already; be explicit so a future adapter
      // that keeps the text on delete still can't leak it through a quote.
      excerpt: deleted
        ? ""
        : parent.body.length > EXCERPT_LENGTH
          ? `${parent.body.slice(0, EXCERPT_LENGTH)}…`
          : parent.body,
      deleted,
    };
  }

  /** Group raw reaction rows by emoji, preserving earliest-first reactor order. */
  function summarize(reactions: Reaction[]): ReactionSummary[] {
    const byEmoji = new Map<string, ReactionSummary>();
    for (const reaction of reactions) {
      const existing = byEmoji.get(reaction.emoji);
      if (existing) {
        existing.count += 1;
        existing.userIds.push(reaction.userId);
      } else {
        byEmoji.set(reaction.emoji, {
          emoji: reaction.emoji,
          count: 1,
          userIds: [reaction.userId],
        });
      }
    }
    return [...byEmoji.values()];
  }

  /**
   * Decorate messages with `replyTo` previews and `reactions` (ADR 0013):
   * exactly two batched storage calls for the whole page, and none at all for
   * a page with no replies and no reactions.
   */
  async function withDetails(messages: Message[]): Promise<MessageWithDetails[]> {
    if (messages.length === 0) return [];

    const parentIds = [
      ...new Set(
        messages
          .map((message) => message.replyToMessageId)
          .filter((id): id is string => id !== null),
      ),
    ];
    const [parents, reactions] = await Promise.all([
      parentIds.length === 0 ? Promise.resolve([]) : storage.getMessagesByIds(parentIds),
      storage.listReactionsByMessageIds(messages.map((message) => message.id)),
    ]);

    const parentsById = new Map(parents.map((parent) => [parent.id, parent]));
    const reactionsByMessage = new Map<string, Reaction[]>();
    for (const reaction of reactions) {
      const list = reactionsByMessage.get(reaction.messageId);
      if (list) list.push(reaction);
      else reactionsByMessage.set(reaction.messageId, [reaction]);
    }

    return messages.map((message) => {
      const parent =
        message.replyToMessageId === null ? undefined : parentsById.get(message.replyToMessageId);
      return {
        ...message,
        replyTo: parent === undefined ? null : toReference(parent),
        reactions: summarize(reactionsByMessage.get(message.id) ?? []),
      };
    });
  }

  async function withDetailsOne(message: Message): Promise<MessageWithDetails> {
    const [decorated] = await withDetails([message]);
    return decorated as MessageWithDetails;
  }

  /**
   * Publish a reaction change. Carries the full post-change reaction set, so
   * receiving the same event twice is harmless - and no `id:` frame, so
   * message gap-fill is undisturbed (ADR 0013 §4).
   */
  function publishReaction(
    type: "reaction.added" | "reaction.removed",
    conversation: Conversation,
    message: MessageWithDetails,
    actorId: string,
    emoji: string,
  ): void {
    transport.publish({
      type,
      conversationId: conversation.id,
      recipientIds: conversation.participants.map((p) => p.userId),
      actorId,
      emoji,
      message,
    });
  }

  /**
   * Shared body of `addReaction`/`removeReaction`: identical validation,
   * permission, and publish path - only the storage call differs.
   */
  async function changeReaction(
    input: ReactionApiInput,
    apply: (emoji: string) => Promise<Reaction[]>,
    eventType: "reaction.added" | "reaction.removed",
  ): Promise<MessageWithDetails> {
    requireNonEmptyId(input.userId, "userId");
    requireNonEmptyId(input.messageId, "messageId");
    const emoji = normalizeEmoji(input.emoji);

    const message = await storage.getMessage(input.messageId);
    if (!message) {
      throw new ChatpackError("MESSAGE_NOT_FOUND", `Message "${input.messageId}" was not found.`);
    }

    const conversation = await requireConversation(message.conversationId);
    // Write permission, like edit/delete: a reaction is a mutation the other
    // participant sees, not a read.
    await requireWrite(input.userId, conversation);

    const reactions = await apply(emoji);
    // Reuse the batched decorator for `replyTo`, then override `reactions`
    // with what the write returned - it is already the authoritative set.
    const decorated = await withDetailsOne(message);
    const updated: MessageWithDetails = { ...decorated, reactions: summarize(reactions) };
    publishReaction(eventType, conversation, updated, input.userId, emoji);
    return updated;
  }

  /**
   * Run `beforeMessageSend` (`docs/decisions/0011`) and resolve the body and
   * metadata to persist. A throwing hook aborts the write: `ChatpackError`s
   * pass through untouched, anything else becomes `MESSAGE_REJECTED` so
   * hooks can `throw new Error("Max 2000 characters.")` without importing
   * Chatpack types.
   */
  async function runBeforeMessageSend(
    ctx: BeforeMessageSendContext,
  ): Promise<{ body: string; metadata: Metadata }> {
    const hook = options.hooks?.beforeMessageSend;
    if (!hook) return { body: ctx.body, metadata: ctx.metadata };

    let result;
    try {
      result = await hook(ctx);
    } catch (err) {
      if (err instanceof ChatpackError) throw err;
      throw new ChatpackError(
        "MESSAGE_REJECTED",
        err instanceof Error && err.message ? err.message : "Message rejected.",
      );
    }

    const body = result?.body ?? ctx.body;
    if (typeof body !== "string" || body.trim() === "") {
      throw new ChatpackError(
        "INVALID_INPUT",
        "beforeMessageSend returned an empty body - throw to reject a message instead.",
      );
    }
    return { body, metadata: result?.metadata ?? ctx.metadata };
  }

  /**
   * Run the post-persistence hook once the message is persisted and broadcast.
   * The deprecated hook receives only send/edit actions for compatibility.
   */
  async function runAfterMessageMutation(
    ctx: Omit<AfterMessageMutationContext, "otherParticipantId">,
  ): Promise<void> {
    const hook = options.hooks?.afterMessageMutation;
    const deprecatedHook = ctx.action === "delete" ? undefined : options.hooks?.afterMessageSend;
    if (!hook && !deprecatedHook) return;

    let otherParticipantId: string;
    try {
      otherParticipantId = getOtherParticipantId(ctx.conversation, ctx.message.senderId);
    } catch (err) {
      console.error(
        hook
          ? "chatpack: afterMessageMutation hook failed"
          : "chatpack: afterMessageSend hook failed",
        err,
      );
      return;
    }

    if (hook) {
      try {
        await hook({ ...ctx, otherParticipantId });
      } catch (err) {
        console.error("chatpack: afterMessageMutation hook failed", err);
      }
      return;
    }

    if (ctx.action === "delete" || !deprecatedHook) return;

    try {
      await deprecatedHook({
        message: ctx.message,
        conversation: ctx.conversation,
        otherParticipantId,
        action: ctx.action,
      });
    } catch (err) {
      console.error("chatpack: afterMessageSend hook failed", err);
    }
  }

  // Assigned right below `api` - the two reference each other, but plugin
  // hooks only run inside api calls, which can't happen before chatpack()
  // returns.

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
      return withUnreadOne(input.userId, conversation);
    },

    async listConversations(input) {
      requireNonEmptyId(input.userId, "userId");
      const { conversations, nextCursor } = await storage.listConversations({
        userId: input.userId,
        limit: normalizeLimit(input.limit),
        cursor: input.cursor,
      });
      return { conversations: await withUnread(input.userId, conversations), nextCursor };
    },

    async getConversation(input) {
      requireNonEmptyId(input.userId, "userId");
      const conversation = await requireConversation(input.conversationId);
      await requireRead(input.userId, conversation);
      return withUnreadOne(input.userId, conversation);
    },

    async sendMessage(input) {
      requireNonEmptyId(input.userId, "userId");
      if (typeof input.body !== "string" || input.body.trim() === "") {
        throw new ChatpackError("INVALID_INPUT", "Message body must be a non-empty string.");
      }

      const conversation = await requireConversation(input.conversationId);
      await requireWrite(input.userId, conversation);

      // A reply must point inside this conversation (ADR 0013 §1). Same error
      // as markRead uses, so a cross-conversation id can't be used to probe
      // whether a message exists somewhere the caller cannot read. Deleted
      // parents are fine - the parent can vanish between render and send.
      if (input.replyToMessageId !== undefined) {
        requireNonEmptyId(input.replyToMessageId, "replyToMessageId");
        const parent = await storage.getMessage(input.replyToMessageId);
        if (!parent || parent.conversationId !== conversation.id) {
          throw new ChatpackError(
            "MESSAGE_NOT_FOUND",
            `Message "${input.replyToMessageId}" was not found in conversation "${conversation.id}".`,
          );
        }
      }

      const hookConversation = {
        ...conversation,
        participantIds: conversation.participants.map((p) => p.userId),
      };
      const accepted = await runBeforeMessageSend({
        user: { id: input.userId },
        conversation: hookConversation,
        body: input.body,
        metadata: input.metadata ?? {},
        role: input.role ?? "user",
        action: "send",
      });

      const message = await storage.addMessage({
        conversationId: conversation.id,
        senderId: input.userId,
        body: accepted.body,
        role: input.role ?? "user",
        replyToMessageId: input.replyToMessageId ?? null,
        metadata: accepted.metadata,
      });

      telemetry.increment("messagesSent");
      const decorated = await withDetailsOne(message);
      // Durable-first (MVP §9): the message exists before anyone is told.
      publish("message.created", conversation, decorated);
      await runAfterMessageMutation({
        message,
        conversation: hookConversation,
        action: "send",
      });
      return decorated;
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
      return { messages: await withDetails(messages), nextCursor };
    },

    async searchMessages(input) {
      requireNonEmptyId(input.userId, "userId");
      if (typeof input.query !== "string" || input.query.trim() === "") {
        throw new ChatpackError("INVALID_INPUT", '"query" must be a non-empty string.');
      }
      if (!storage.searchMessages) {
        throw new ChatpackError(
          "SEARCH_UNSUPPORTED",
          "Message search is not supported by this storage adapter.",
        );
      }

      const limit = normalizeLimit(input.limit);
      const messages: Message[] = [];
      let cursor = input.cursor;

      // Adapter pages remain participant-scoped and ranked. Filtering a page
      // in core keeps custom canRead hooks effective for those results.
      for (;;) {
        const page = await storage.searchMessages({
          userId: input.userId,
          query: input.query.trim(),
          limit: limit - messages.length,
          ...(cursor !== undefined ? { cursor } : {}),
        });

        for (const message of page.messages) {
          const conversation = await storage.getConversation(message.conversationId);
          if (conversation && (await canReadConversation(input.userId, conversation))) {
            messages.push(message);
          }
        }

        if (messages.length >= limit || page.nextCursor === null) {
          return {
            messages: await withDetails(messages.slice(0, limit)),
            nextCursor: page.nextCursor,
          };
        }
        cursor = page.nextCursor;
      }
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

      // Content rules apply to edits too - otherwise a blocked word could be
      // sent clean and edited in afterwards (docs/decisions/0011).
      const hookConversation = {
        ...conversation,
        participantIds: conversation.participants.map((p) => p.userId),
      };
      const accepted = await runBeforeMessageSend({
        user: { id: input.userId },
        conversation: hookConversation,
        body: input.body,
        metadata: existing.metadata,
        role: existing.role,
        action: "edit",
      });

      const updated = await storage.updateMessage({
        messageId: existing.id,
        body: accepted.body,
        editedAt: new Date(),
      });
      const decorated = await withDetailsOne(updated);
      publish("message.updated", conversation, decorated);
      await runAfterMessageMutation({
        message: updated,
        conversation: hookConversation,
        action: "edit",
      });
      return decorated;
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
      if (existing.deletedAt) return withDetailsOne(existing); // idempotent

      const conversation = await requireConversation(existing.conversationId);
      await requireWrite(input.userId, conversation);
      const hookConversation = {
        ...conversation,
        participantIds: conversation.participants.map((p) => p.userId),
      };

      const updated = await storage.updateMessage({
        messageId: existing.id,
        body: "",
        deletedAt: new Date(),
      });
      // Reactions on a deleted message are left alone: the tombstone still
      // renders, and clearing them would be a second write for no gain.
      const decorated = await withDetailsOne(updated);
      publish("message.deleted", conversation, decorated);
      await runAfterMessageMutation({
        message: updated,
        conversation: hookConversation,
        action: "delete",
      });
      return decorated;
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

      // Monotonic: never move read-state backwards. A stale markRead (e.g. an
      // out-of-order replay after reconnect) is silently ignored so unread
      // counts can only shrink from reading, never grow.
      const participant = conversation.participants.find((p) => p.userId === input.userId);
      if (participant?.lastReadMessageId) {
        const current = await storage.getMessage(participant.lastReadMessageId);
        if (current && message.seq <= current.seq) return;
      }

      await storage.updateLastRead({
        conversationId: conversation.id,
        userId: input.userId,
        messageId: message.id,
      });

      // Durable-first, same as messages: the read-state exists before any
      // plugin (e.g. receipts) tells anyone about it.
      pluginRuntime.notifyMarkRead({
        userId: input.userId,
        conversationId: conversation.id,
        messageId: message.id,
        recipientIds: conversation.participants.map((p) => p.userId),
      });
    },

    async listMessagesAfter(input) {
      requireNonEmptyId(input.userId, "userId");
      if (!Number.isInteger(input.afterSeq) || input.afterSeq < 0) {
        throw new ChatpackError(
          "INVALID_INPUT",
          `"afterSeq" must be a non-negative integer, got ${input.afterSeq}.`,
        );
      }
      const conversation = await requireConversation(input.conversationId);
      await requireRead(input.userId, conversation);

      const missed = await storage.listMessagesAfterSeq({
        conversationId: conversation.id,
        afterSeq: input.afterSeq,
        limit: normalizeLimit(input.limit),
      });
      return withDetails(missed);
    },

    async addReaction(input) {
      return changeReaction(
        input,
        (emoji) => storage.addReaction({ messageId: input.messageId, userId: input.userId, emoji }),
        "reaction.added",
      );
    },

    async removeReaction(input) {
      return changeReaction(
        input,
        (emoji) =>
          storage.removeReaction({ messageId: input.messageId, userId: input.userId, emoji }),
        "reaction.removed",
      );
    },
  };

  const pluginRuntime = createPluginRuntime(options.plugins ?? [], api, transport);

  return {
    api,
    handler: (handlerOptions?: HandlerOptions) =>
      createHandler(api, options.auth, handlerOptions, transport, pluginRuntime),
    transport,
    telemetry,
    options,
  };
}
