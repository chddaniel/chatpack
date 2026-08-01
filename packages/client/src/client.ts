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

export interface ConversationCreateInput {
  otherUserId: string;
  metadata?: Metadata;
}

export interface ConversationListInput {
  limit?: number;
  cursor?: string;
}

export interface ConversationGetInput {
  conversationId: string;
}

export interface MarkReadInput {
  conversationId: string;
  messageId: string;
}

export interface MessageListInput {
  conversationId: string;
  limit?: number;
  cursor?: string;
}

export interface MessageSendInput {
  conversationId: string;
  body: string;
  role?: MessageRole;
  metadata?: Metadata;
}

export interface MessageEditInput {
  messageId: string;
  body: string;
}

export interface MessageDeleteInput {
  messageId: string;
}

export interface ChatClientRequestOptions {
  headers?: HeadersInit;
  signal?: AbortSignal;
}

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
}

export interface ChatClient {
  conversations: ConversationActions;
  messages: MessageActions;
  realtime: ChatRealtime;
  $store: ChatpackCache;
  $getPluginState(id: string): ReadonlyStore<unknown> | null;
  dispose(): void;
}

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
  const cache = createChatpackCache();
  const eventTypes = [
    "message.created",
    "message.updated",
    "message.deleted",
    ...plugins.flatMap((plugin) => plugin.eventTypes),
  ];
  const realtime = createRealtime({
    url: (options.baseURL?.replace(/\/+$/g, "") ?? "") + basePath + "/stream",
    credentials,
    eventSource: options.eventSource ?? ((url, init) => new EventSource(url, init)),
    eventTypes: [...new Set(eventTypes)],
    onEvent: (event) => cache.applyEvent(event),
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
      return requester.request<{ ok: true }>(
        "/conversations/" + encodeURIComponent(input.conversationId) + "/read",
        {
          method: "POST",
          body: { messageId: input.messageId },
          ...requestOptions(optionsForRequest),
        },
      );
    },
  };

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
        cache.applyEvent({
          type: "message.created",
          conversationId: message.data.conversationId,
          message: message.data,
        });
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
