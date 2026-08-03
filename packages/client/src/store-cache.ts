/** Per-client cache contracts for REST results and durable stream updates. */
import type { ChatClientResult, ChatpackClientError } from "./errors";
import { isReactionChatEvent, type DurableChatEvent, type ChatpackEvent } from "./realtime";
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

/** Options controlling how the cache interprets incoming events. */
export interface ChatpackCacheOptions {
  /**
   * The signed-in user's id, used only so the viewer's own messages never
   * inflate `unreadCount`. Purely a cache hint - Chatpack never authenticates
   * with it. When omitted, the cache learns it from the first message this
   * client sends.
   */
  userId?: string;
}

/** How one durable event reached the cache. */
export interface ApplyEventOptions {
  /**
   * `true` when the event is the local echo of this client's own write, so it
   * must never count as unread. Remote stream events leave this unset.
   */
  local?: boolean;
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
  applyEvent(event: ChatpackEvent, options?: ApplyEventOptions): void;
  /**
   * Replace the reaction set of one cached message (ADR 0013).
   *
   * Takes a whole message because both sources - a `reaction.*` stream event
   * and the response to a react/unreact call - carry the complete post-change
   * snapshot. A no-op when the message is not in a loaded page.
   */
  applyReactions(conversationId: string, message: ClientMessage): void;
  /** Clears the viewer's unread count after a successful `markRead`. */
  applyRead(conversationId: string, messageId: string): void;
  /** Adds a conversation the list has not seen yet at the most-recent end. */
  prependConversation(conversation: ClientConversation): void;
  /** True when the conversation list is loaded but missing this id. */
  isMissingFromConversations(conversationId: string): boolean;
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

/**
 * Apply a reaction change to a cached thread (ADR 0013).
 *
 * Unlike a message event this never *inserts*: a reaction on a message outside
 * the loaded page is dropped rather than splicing a lone message into a
 * paginated list it does not belong in. The event carries the complete
 * reaction set, so overwriting is idempotent.
 */
function replaceReactions(
  messages: ClientMessage[],
  message: ClientMessage,
): ClientMessage[] | null {
  const index = messages.findIndex((item) => item.id === message.id);
  if (index === -1) return null;
  return messages.map((item, itemIndex) =>
    itemIndex === index ? { ...item, reactions: message.reactions } : item,
  );
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

function highestSeq(messages: readonly ClientMessage[]): number {
  let highest = 0;
  for (const message of messages) if (message.seq > highest) highest = message.seq;
  return highest;
}

/**
 * Move `conversationId` to the front of the list and apply `bumpUnread`, which
 * mirrors the server's most-recently-active ordering. Returns the same array
 * when the id is not in the loaded pages, so callers can detect a stale list.
 */
function touchConversations(
  conversations: readonly ClientConversation[],
  conversationId: string,
  bumpUnread: boolean,
): ClientConversation[] | null {
  const index = conversations.findIndex((item) => item.id === conversationId);
  if (index === -1) return null;
  const current = conversations[index]!;
  const next = bumpUnread ? { ...current, unreadCount: current.unreadCount + 1 } : current;
  if (index === 0 && next === current) return null;
  const rest = conversations.filter((_, itemIndex) => itemIndex !== index);
  return [next, ...rest];
}

/** Creates an empty isolated Chatpack cache. */
export function createChatpackCache(options: ChatpackCacheOptions = {}): ChatpackCache {
  const store: Store<ChatpackCacheSnapshot> = createStore({
    conversations: emptyQuery<ClientConversationPage>(),
    conversationsById: {},
    messagesByConversation: {},
  });
  /**
   * Highest message seq seen per conversation, from REST pages and stream
   * events alike. Delivery is at-least-once (ADR 0006 gap-fill re-sends
   * events the server already counted), so only a strictly higher seq may
   * bump `unreadCount`.
   */
  const seenSeq = new Map<string, number>();
  let viewerId = options.userId;

  /** Shared by the stream event and the local echo of a react/unreact call. */
  function applyReactions(conversationId: string, message: ClientMessage): void {
    store.update((current) => {
      const existing = current.messagesByConversation[conversationId];
      if (existing?.data == null) return current;
      const messages = replaceReactions(existing.data.messages, message);
      if (messages === null) return current;
      return {
        ...current,
        messagesByConversation: {
          ...current.messagesByConversation,
          [conversationId]: { ...existing, data: { ...existing.data, messages } },
        },
      };
    });
  }

  return {
    applyReactions,
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
            // `?.data` is undefined (not null) when this id has never loaded,
            // so compare loosely: a missing entry is still a first load.
            isPending: current.conversationsById[conversationId]?.data == null,
            isRefetching: current.conversationsById[conversationId]?.data != null,
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
            // Same loose comparison as setConversationLoading: undefined entry
            // means first load.
            isPending: current.messagesByConversation[conversationId]?.data == null,
            isRefetching: current.messagesByConversation[conversationId]?.data != null,
            error: null,
          },
        },
      }));
    },
    setMessages(conversationId, result, append) {
      if (result.error === null) {
        // Fetched history counts as "already seen": a stream event replaying a
        // message that is in this page must not bump `unreadCount` again.
        const newest = highestSeq(result.data.messages);
        if (newest > (seenSeq.get(conversationId) ?? 0)) seenSeq.set(conversationId, newest);
      }
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
    applyEvent(event, eventOptions = {}) {
      if ("ephemeral" in event) return;

      // A reaction is not a message (ADR 0013): it never reorders the list,
      // never bumps `unreadCount`, and never advances the seq baseline.
      if (isReactionChatEvent(event)) {
        applyReactions(event.conversationId, event.message);
        return;
      }
      // Re-bound as a const so the narrowing above survives into the closures
      // below - TypeScript discards narrowing of a parameter inside a callback.
      const durable: DurableChatEvent = event;

      // Only `message.created` bumps server-side activity (adapters touch
      // `lastActivityAt` in `addMessage` only), so edits and deletes must not
      // reorder the list or the client would disagree with the next refetch.
      const previousSeq = seenSeq.get(durable.conversationId) ?? 0;
      const isNew = durable.type === "message.created" && durable.message.seq > previousSeq;
      if (durable.message.seq > previousSeq) {
        seenSeq.set(durable.conversationId, durable.message.seq);
      }

      // The sender's own message reaches them twice - once as the local echo
      // of the write, once over their own stream - and neither is unread.
      if (eventOptions.local === true) viewerId ??= durable.message.senderId;
      const isOwn = eventOptions.local === true || durable.message.senderId === viewerId;
      const bumpUnread = isNew && !isOwn;

      store.update((current) => {
        let next = current;

        const existing = current.messagesByConversation[durable.conversationId];
        if (existing !== undefined) {
          next = {
            ...next,
            messagesByConversation: {
              ...next.messagesByConversation,
              [durable.conversationId]: applyDurableEvent(existing, durable),
            },
          };
        }

        if (!isNew) return next;

        const list = next.conversations.data;
        if (list !== null) {
          const reordered = touchConversations(
            list.conversations,
            durable.conversationId,
            bumpUnread,
          );
          if (reordered !== null) {
            next = {
              ...next,
              conversations: { ...next.conversations, data: { ...list, conversations: reordered } },
            };
          }
        }

        const one = next.conversationsById[durable.conversationId];
        if (bumpUnread && one?.data != null) {
          next = {
            ...next,
            conversationsById: {
              ...next.conversationsById,
              [durable.conversationId]: {
                ...one,
                data: { ...one.data, unreadCount: one.data.unreadCount + 1 },
              },
            },
          };
        }

        return next;
      });
    },
    applyRead(conversationId, messageId) {
      store.update((current) => {
        // Read-state is monotonic server-side, but the client cannot compare a
        // message id to a seq without a lookup, so only clear the count when
        // the marked message is the newest one this client knows about.
        const thread = current.messagesByConversation[conversationId]?.data;
        const marked = thread?.messages.find((message) => message.id === messageId);
        if (marked !== undefined && marked.seq < highestSeq(thread?.messages ?? [])) return current;

        let next = current;
        const list = next.conversations.data;
        const index = list?.conversations.findIndex((item) => item.id === conversationId) ?? -1;
        if (list !== null && list !== undefined && index !== -1) {
          const target = list.conversations[index]!;
          if (target.unreadCount !== 0) {
            next = {
              ...next,
              conversations: {
                ...next.conversations,
                data: {
                  ...list,
                  conversations: list.conversations.map((item, itemIndex) =>
                    itemIndex === index ? { ...item, unreadCount: 0 } : item,
                  ),
                },
              },
            };
          }
        }

        const one = next.conversationsById[conversationId];
        if (one?.data != null && one.data.unreadCount !== 0) {
          next = {
            ...next,
            conversationsById: {
              ...next.conversationsById,
              [conversationId]: { ...one, data: { ...one.data, unreadCount: 0 } },
            },
          };
        }
        return next;
      });
    },
    prependConversation(conversation) {
      store.update((current) => {
        const list = current.conversations.data;
        if (list === null) return current;
        if (list.conversations.some((item) => item.id === conversation.id)) return current;
        return {
          ...current,
          conversations: {
            ...current.conversations,
            data: { ...list, conversations: [conversation, ...list.conversations] },
          },
        };
      });
    },
    isMissingFromConversations(conversationId) {
      const list = store.getSnapshot().conversations.data;
      if (list === null) return false;
      return !list.conversations.some((item) => item.id === conversationId);
    },
  };
}
