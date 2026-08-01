/** Per-client cache contracts for REST results and durable stream updates. */
import type { ChatClientResult, ChatpackClientError } from "./errors";
import type { DurableChatEvent, ChatpackEvent } from "./realtime";
import { createStore, type ReadonlyStore, type Store } from "./store";
import type {
  ClientConversation,
  ClientConversationPage,
  ClientMessage,
  ClientMessagePage,
} from "./wire";

/** Loading and result state for one cached query. */
export interface QueryState<T> {
  data: T | null;
  error: ChatpackClientError | null;
  isPending: boolean;
  isRefetching: boolean;
}

/** Snapshot held by the Chatpack client cache. */
export interface ChatpackCacheSnapshot {
  conversations: QueryState<ClientConversationPage>;
  conversationsById: Record<string, QueryState<ClientConversation>>;
  messagesByConversation: Record<string, QueryState<ClientMessagePage>>;
}

function emptyQuery<T>(): QueryState<T> {
  return { data: null, error: null, isPending: true, isRefetching: false };
}

/** Observable cache used by REST actions and React hooks. */
export interface ChatpackCache extends ReadonlyStore<ChatpackCacheSnapshot> {
  setConversationsLoading(): void;
  setConversations(result: ChatClientResult<ClientConversationPage>, append: boolean): void;
  setConversationLoading(conversationId: string): void;
  setConversation(conversationId: string, result: ChatClientResult<ClientConversation>): void;
  setMessagesLoading(conversationId: string): void;
  setMessages(
    conversationId: string,
    result: ChatClientResult<ClientMessagePage>,
    append: boolean,
  ): void;
  applyEvent(event: ChatpackEvent): void;
}

function replaceMessage(messages: ClientMessage[], message: ClientMessage): ClientMessage[] {
  const index = messages.findIndex((item) => item.id === message.id);
  if (index !== -1 && messages[index]!.seq > message.seq) return messages;
  const next =
    index === -1
      ? [...messages, message]
      : messages.map((item, itemIndex) => (itemIndex === index ? message : item));
  return next.sort((left, right) => right.seq - left.seq);
}

function mergeMessages(current: ClientMessage[], incoming: ClientMessage[]): ClientMessage[] {
  let merged = current;
  for (const message of incoming) merged = replaceMessage(merged, message);
  return merged;
}

function applyDurableEvent(
  query: QueryState<ClientMessagePage>,
  event: DurableChatEvent,
): QueryState<ClientMessagePage> {
  if (query.data === null) return query;
  return {
    ...query,
    data: {
      ...query.data,
      messages: replaceMessage(query.data.messages, event.message),
    },
  };
}

/** Creates an empty isolated Chatpack cache. */
export function createChatpackCache(): ChatpackCache {
  const store: Store<ChatpackCacheSnapshot> = createStore({
    conversations: emptyQuery<ClientConversationPage>(),
    conversationsById: {},
    messagesByConversation: {},
  });

  return {
    getSnapshot: store.getSnapshot,
    subscribe: store.subscribe,
    setConversationsLoading() {
      store.update((current) => ({
        ...current,
        conversations: {
          ...current.conversations,
          isPending: current.conversations.data === null,
          isRefetching: current.conversations.data !== null,
          error: null,
        },
      }));
    },
    setConversations(result, append) {
      store.update((current) => {
        if (result.error !== null) {
          return {
            ...current,
            conversations: {
              data: current.conversations.data,
              error: result.error,
              isPending: false,
              isRefetching: false,
            },
          };
        }
        const data =
          append && current.conversations.data !== null
            ? {
                conversations: [
                  ...current.conversations.data.conversations,
                  ...result.data.conversations,
                ],
                nextCursor: result.data.nextCursor,
              }
            : result.data;
        return {
          ...current,
          conversations: { data, error: null, isPending: false, isRefetching: false },
        };
      });
    },
    setConversationLoading(conversationId) {
      store.update((current) => ({
        ...current,
        conversationsById: {
          ...current.conversationsById,
          [conversationId]: {
            ...(current.conversationsById[conversationId] ?? emptyQuery<ClientConversation>()),
            isPending: current.conversationsById[conversationId]?.data === null,
            isRefetching: current.conversationsById[conversationId]?.data !== null,
            error: null,
          },
        },
      }));
    },
    setConversation(conversationId, result) {
      store.update((current) => ({
        ...current,
        conversationsById: {
          ...current.conversationsById,
          [conversationId]:
            result.error === null
              ? { data: result.data, error: null, isPending: false, isRefetching: false }
              : {
                  data: current.conversationsById[conversationId]?.data ?? null,
                  error: result.error,
                  isPending: false,
                  isRefetching: false,
                },
        },
      }));
    },
    setMessagesLoading(conversationId) {
      store.update((current) => ({
        ...current,
        messagesByConversation: {
          ...current.messagesByConversation,
          [conversationId]: {
            ...(current.messagesByConversation[conversationId] ?? emptyQuery<ClientMessagePage>()),
            isPending: current.messagesByConversation[conversationId]?.data === null,
            isRefetching: current.messagesByConversation[conversationId]?.data !== null,
            error: null,
          },
        },
      }));
    },
    setMessages(conversationId, result, append) {
      store.update((current) => {
        const previous = current.messagesByConversation[conversationId];
        const query =
          result.error !== null
            ? {
                data: previous?.data ?? null,
                error: result.error,
                isPending: false,
                isRefetching: false,
              }
            : {
                data:
                  append && previous?.data !== null && previous?.data !== undefined
                    ? {
                        messages: mergeMessages(previous.data.messages, result.data.messages),
                        nextCursor: result.data.nextCursor,
                      }
                    : result.data,
                error: null,
                isPending: false,
                isRefetching: false,
              };
        return {
          ...current,
          messagesByConversation: { ...current.messagesByConversation, [conversationId]: query },
        };
      });
    },
    applyEvent(event) {
      if ("ephemeral" in event) return;
      store.update((current) => {
        const existing = current.messagesByConversation[event.conversationId];
        if (existing === undefined) return current;
        return {
          ...current,
          messagesByConversation: {
            ...current.messagesByConversation,
            [event.conversationId]: applyDurableEvent(existing, event),
          },
        };
      });
    },
  };
}
