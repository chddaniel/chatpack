/** Composes the framework-agnostic Chatpack client and its resource actions. */
import type { Metadata, MessageRole } from "@chatpack/core";
import type { ChatClientOptions } from "./config";
import type { ChatClientResult } from "./errors";
import {
  createPluginContext,
  disposePlugins,
  type ChatClientPlugin,
  type PluginSurfaces,
} from "./plugin";
import { createRealtime, type ChatRealtime } from "./realtime";
import {
  createRequester,
  normalizeBasePath,
  unwrapResult,
  type ClientRequestInit,
  type ChatpackRequester,
} from "./request";
import { createChatpackCache, type ChatpackCache } from "./store-cache";
import type { ReadonlyStore } from "./store";
import type {
  ClientConversation,
  ClientConversationPage,
  ClientMessage,
  ClientMessagePage,
} from "./wire";

/** Input for creating a conversation with another user. */
export interface ConversationCreateInput {
  otherUserId: string;
  metadata?: Metadata;
}

/** Optional pagination input for listing conversations. */
export interface ConversationListInput {
  limit?: number;
  cursor?: string;
}

/** Input for loading one conversation. */
export interface ConversationGetInput {
  conversationId: string;
}

/** Input for marking a message as read. */
export interface MarkReadInput {
  conversationId: string;
  messageId: string;
}

/** Pagination input for listing messages in a conversation. */
export interface MessageListInput {
  conversationId: string;
  limit?: number;
  cursor?: string;
}

/** Input for sending a message. */
export interface MessageSendInput {
  conversationId: string;
  body: string;
  role?: MessageRole;
  /**
   * Quote-reply to this message (ADR 0013). Must be a message in the same
   * conversation; replying to a deleted one is allowed.
   */
  replyToMessageId?: string;
  metadata?: Metadata;
}

/** Input for adding or removing one of your own reactions. */
export interface MessageReactInput {
  messageId: string;
  /** Any non-empty string up to 32 characters - emoji, `:shortcode:`, or a custom id. */
  emoji: string;
}

/** Input for editing a message. */
export interface MessageEditInput {
  messageId: string;
  body: string;
}

/** Input for deleting a message. */
export interface MessageDeleteInput {
  messageId: string;
}

/** Per-request headers and cancellation options. */
export interface ChatClientRequestOptions {
  headers?: HeadersInit;
  signal?: AbortSignal;
}

/** Typed actions for the conversations resource. */
export interface ConversationActions {
  create(
    input: ConversationCreateInput,
    options?: ChatClientRequestOptions,
  ): Promise<ChatClientResult<ClientConversation>>;
  list(
    input?: ConversationListInput,
    options?: ChatClientRequestOptions,
  ): Promise<ChatClientResult<ClientConversationPage>>;
  get(
    input: ConversationGetInput,
    options?: ChatClientRequestOptions,
  ): Promise<ChatClientResult<ClientConversation>>;
  markRead(
    input: MarkReadInput,
    options?: ChatClientRequestOptions,
  ): Promise<ChatClientResult<{ ok: true }>>;
}

/** Typed actions for the messages resource. */
export interface MessageActions {
  list(
    input: MessageListInput,
    options?: ChatClientRequestOptions,
  ): Promise<ChatClientResult<ClientMessagePage>>;
  send(
    input: MessageSendInput,
    options?: ChatClientRequestOptions,
  ): Promise<ChatClientResult<ClientMessage>>;
  edit(
    input: MessageEditInput,
    options?: ChatClientRequestOptions,
  ): Promise<ChatClientResult<ClientMessage>>;
  delete(
    input: MessageDeleteInput,
    options?: ChatClientRequestOptions,
  ): Promise<ChatClientResult<ClientMessage>>;
  /** Add one of your own reactions. Idempotent - reacting twice is one reaction. */
  react(
    input: MessageReactInput,
    options?: ChatClientRequestOptions,
  ): Promise<ChatClientResult<ClientMessage>>;
  /** Remove one of your own reactions. Idempotent - removing a missing one is a no-op. */
  unreact(
    input: MessageReactInput,
    options?: ChatClientRequestOptions,
  ): Promise<ChatClientResult<ClientMessage>>;
}

/** Public framework-agnostic Chatpack client surface. */
export interface ChatClient {
  conversations: ConversationActions;
  messages: MessageActions;
  realtime: ChatRealtime;
  $store: ChatpackCache;
  $getPluginState(id: string): ReadonlyStore<unknown> | null;
  dispose(): void;
}

/** Chatpack client surface with the actions and state contributed by plugins. */
export type ChatClientWithPlugins<Plugins extends readonly ChatClientPlugin[]> = ChatClient &
  PluginSurfaces<Plugins>;

function requestOptions(
  options: ChatClientRequestOptions | undefined,
): Pick<ClientRequestInit, "headers" | "signal"> {
  return options === undefined
    ? {}
    : {
        ...(options.headers === undefined ? {} : { headers: options.headers }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      };
}

/** Creates an isolated Chatpack client instance. */
export function createChatClient<
  Plugins extends readonly ChatClientPlugin[] = readonly ChatClientPlugin[],
>(options: ChatClientOptions<Plugins> = {}): ChatClientWithPlugins<Plugins> {
  const basePath = normalizeBasePath(options.basePath);
  const plugins: readonly ChatClientPlugin[] = options.plugins ?? [];
  const credentials = options.credentials ?? "same-origin";
  const requesterOptions = {
    basePath,
    credentials,
    ...(options.baseURL === undefined ? {} : { baseURL: options.baseURL }),
    ...(options.headers === undefined ? {} : { headers: options.headers }),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  };
  const requester: ChatpackRequester = createRequester(requesterOptions);
  const cache = createChatpackCache(options.userId === undefined ? {} : { userId: options.userId });
  const eventTypes = [
    "message.created",
    "message.updated",
    "message.deleted",
    "reaction.added",
    "reaction.removed",
    ...plugins.flatMap((plugin) => plugin.eventTypes),
  ];
  /**
   * Conversations whose first message arrived over the stream before the list
   * knew about them; guards against firing the same backfill twice.
   */
  const backfilling = new Set<string>();

  /**
   * A brand-new conversation started by the other user has no row in the
   * loaded list, so there is nothing to reorder. Fetch it once and prepend it
   * (with the server's authoritative `unreadCount`) instead of silently
   * dropping the update.
   */
  async function backfillConversation(conversationId: string): Promise<void> {
    if (backfilling.has(conversationId)) return;
    backfilling.add(conversationId);
    try {
      const result = await requester.request<unknown>(
        "/conversations/" + encodeURIComponent(conversationId),
      );
      const conversation = unwrapResult<ClientConversation>(result, "conversation");
      if (conversation.error === null) cache.prependConversation(conversation.data);
    } finally {
      backfilling.delete(conversationId);
    }
  }

  const realtime = createRealtime({
    url: (options.baseURL?.replace(/\/+$/g, "") ?? "") + basePath + "/stream",
    credentials,
    eventSource: options.eventSource ?? ((url, init) => new EventSource(url, init)),
    eventTypes: [...new Set(eventTypes)],
    onEvent: (event) => {
      cache.applyEvent(event);
      if (
        !("ephemeral" in event) &&
        event.type === "message.created" &&
        cache.isMissingFromConversations(event.conversationId)
      ) {
        void backfillConversation(event.conversationId);
      }
    },
  });
  const pluginContext = createPluginContext(requester, realtime);
  const pluginSurfaces: Record<string, object> = {};
  const pluginInstances: Array<{ dispose?: () => void }> = [];
  const pluginState = new Map<string, ReadonlyStore<unknown>>();

  for (const plugin of plugins) {
    if (Object.hasOwn(pluginSurfaces, plugin.id)) {
      throw new Error('chatpack: duplicate client plugin id "' + plugin.id + '".');
    }
    const instance = plugin.create(pluginContext);
    pluginInstances.push(instance);
    pluginState.set(plugin.id, instance.state);
    pluginSurfaces[plugin.id] = { ...instance.actions, state: instance.state };
  }

  const conversationActions: ConversationActions = {
    async create(input, optionsForRequest) {
      const result = await requester.request<unknown>("/conversations", {
        method: "POST",
        body: input,
        ...requestOptions(optionsForRequest),
      });
      const conversation = unwrapResult<ClientConversation>(result, "conversation");
      if (conversation.error === null) cache.setConversation(conversation.data.id, conversation);
      return conversation;
    },
    async list(input = {}, optionsForRequest) {
      cache.setConversationsLoading();
      const result = await requester.request<ClientConversationPage>("/conversations", {
        query: { limit: input.limit, cursor: input.cursor },
        ...requestOptions(optionsForRequest),
      });
      cache.setConversations(result, input.cursor !== undefined);
      return result;
    },
    async get(input, optionsForRequest) {
      cache.setConversationLoading(input.conversationId);
      const result = await requester.request<unknown>(
        "/conversations/" + encodeURIComponent(input.conversationId),
        requestOptions(optionsForRequest),
      );
      const conversation = unwrapResult<ClientConversation>(result, "conversation");
      cache.setConversation(input.conversationId, conversation);
      return conversation;
    },
    async markRead(input, optionsForRequest) {
      const result = await requester.request<{ ok: true }>(
        "/conversations/" + encodeURIComponent(input.conversationId) + "/read",
        {
          method: "POST",
          body: { messageId: input.messageId },
          ...requestOptions(optionsForRequest),
        },
      );
      if (result.error === null) cache.applyRead(input.conversationId, input.messageId);
      return result;
    },
  };

  /**
   * Add or remove a reaction and echo the change into the cache. The response
   * carries the full message, so the local echo writes the same complete
   * snapshot the other participant receives over the stream.
   *
   * The emoji travels in the body for both verbs (see the route comment in
   * `packages/core/src/handler.ts`).
   */
  async function changeReaction(
    method: "POST" | "DELETE",
    input: MessageReactInput,
    optionsForRequest: ChatClientRequestOptions | undefined,
  ): Promise<ChatClientResult<ClientMessage>> {
    const result = await requester.request<unknown>(
      "/messages/" + encodeURIComponent(input.messageId) + "/reactions",
      {
        method,
        body: { emoji: input.emoji },
        ...requestOptions(optionsForRequest),
      },
    );
    const message = unwrapResult<ClientMessage>(result, "message");
    if (message.error === null) {
      cache.applyReactions(message.data.conversationId, message.data);
    }
    return message;
  }

  const messageActions: MessageActions = {
    async list(input, optionsForRequest) {
      cache.setMessagesLoading(input.conversationId);
      const result = await requester.request<ClientMessagePage>(
        "/conversations/" + encodeURIComponent(input.conversationId) + "/messages",
        {
          query: { limit: input.limit, cursor: input.cursor },
          ...requestOptions(optionsForRequest),
        },
      );
      cache.setMessages(input.conversationId, result, input.cursor !== undefined);
      return result;
    },
    async send(input, optionsForRequest) {
      const { conversationId, ...body } = input;
      const result = await requester.request<unknown>(
        "/conversations/" + encodeURIComponent(conversationId) + "/messages",
        {
          method: "POST",
          body,
          ...requestOptions(optionsForRequest),
        },
      );
      const message = unwrapResult<ClientMessage>(result, "message");
      if (message.error === null) {
        cache.applyEvent(
          {
            type: "message.created",
            conversationId: message.data.conversationId,
            message: message.data,
          },
          { local: true },
        );
      }
      return message;
    },
    async edit(input, optionsForRequest) {
      const result = await requester.request<unknown>(
        "/messages/" + encodeURIComponent(input.messageId),
        {
          method: "PATCH",
          body: { body: input.body },
          ...requestOptions(optionsForRequest),
        },
      );
      const message = unwrapResult<ClientMessage>(result, "message");
      if (message.error === null) {
        cache.applyEvent({
          type: "message.updated",
          conversationId: message.data.conversationId,
          message: message.data,
        });
      }
      return message;
    },
    async delete(input, optionsForRequest) {
      const result = await requester.request<unknown>(
        "/messages/" + encodeURIComponent(input.messageId),
        { method: "DELETE", ...requestOptions(optionsForRequest) },
      );
      const message = unwrapResult<ClientMessage>(result, "message");
      if (message.error === null) {
        cache.applyEvent({
          type: "message.deleted",
          conversationId: message.data.conversationId,
          message: message.data,
        });
      }
      return message;
    },
    async react(input, optionsForRequest) {
      return changeReaction("POST", input, optionsForRequest);
    },
    async unreact(input, optionsForRequest) {
      return changeReaction("DELETE", input, optionsForRequest);
    },
  };

  const client: ChatClient = {
    conversations: conversationActions,
    messages: messageActions,
    realtime,
    $store: cache,
    $getPluginState(id) {
      return pluginState.get(id) ?? null;
    },
    dispose() {
      realtime.disconnect();
      disposePlugins(pluginInstances);
    },
  };

  return Object.assign(client, pluginSurfaces) as ChatClientWithPlugins<Plugins>;
}
