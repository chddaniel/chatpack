/** Per-client cache contracts for REST results and durable stream updates. */
import type { ChatClientResult, ChatpackClientError } from "./errors";
import {
  isConversationChatEvent,
  isReactionChatEvent,
  type ConversationChatEvent,
  type DurableChatEvent,
  type ChatpackEvent,
} from "./realtime";
import { createStore, type ReadonlyStore, type Store } from "./store";
import type {
  ClientConversation,
  ClientConversationPage,
  ClientConversationSnapshot,
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
   * Fold a polled conversations page into the loaded list (`docs/decisions/0016`).
   *
   * Not `setConversations`: a poll refetches only the newest page, so replacing
   * would drop older pages the host had loaded and rewind `nextCursor` to the
   * end of page one. Instead the polled page takes the front (the server orders
   * by activity and its `unreadCount` is authoritative) and anything the host
   * knows about but the page did not mention keeps its place behind it.
   *
   * A no-op until the list has loaded once, and when the result is unchanged -
   * an interval that notified subscribers every tick would re-render every
   * mounted component on a timer.
   */
  applyPolledConversations(page: ClientConversationPage): void;
  /**
   * Fold a polled message page into one loaded thread (`docs/decisions/0016`).
   *
   * Merges by id, so edits, tombstones and reaction changes all land, and keeps
   * the loaded `nextCursor` so a thread the host had paged backwards through is
   * not rewound. A no-op when the thread has never loaded or nothing changed.
   */
  applyPolledMessages(conversationId: string, page: ClientMessagePage): void;
  /**
   * Replace the reaction set of one cached message (ADR 0013).
   *
   * Takes a whole message because both sources - a `reaction.*` stream event
   * and the response to a react/unreact call - carry the complete post-change
   * snapshot. A no-op when the message is not in a loaded page.
   */
  applyReactions(conversationId: string, message: ClientMessage): void;
  /**
   * Merge a conversation snapshot from a `participant.*` /
   * `conversation.updated` event or a group mutation's response into every
   * cached copy (ADR 0017).
   *
   * Only the mutable fields land (`name`, `metadata`, `participants`);
   * `unreadCount` is deliberately kept from the cache, because the event's
   * snapshot has none - it fans out to every recipient while unread counts are
   * viewer-relative (ADR 0009). A no-op for conversations the cache has never
   * loaded: splicing an unranked conversation into a paginated list is the
   * backfill path's job, which fetches the viewer's real `unreadCount` too.
   */
  applyConversationSnapshot(conversation: ClientConversationSnapshot): void;
  /**
   * Apply a `participant.removed` event or the local echo of a
   * remove/leave call (ADR 0017).
   *
   * When the removed user is the viewer, the conversation is dropped from
   * every cache surface - the event is the only signal their client gets, and
   * any later request for it would be `FORBIDDEN_READ`. Requires the cache to
   * know the viewer (the `userId` option, or inferred from a sent message);
   * without it the snapshot still merges, and the stale entry lasts until the
   * next refetch fails. When the removed user is someone else this is just
   * {@link applyConversationSnapshot}.
   */
  applyParticipantRemoved(
    removedUserIds: readonly string[],
    conversation: ClientConversationSnapshot,
  ): void;
  /**
   * Drop one conversation from every cache surface. Used when the viewer was
   * removed from it (ADR 0017) - directly when a poll or refetch comes back
   * `FORBIDDEN_READ`, and via {@link applyParticipantRemoved} for the stream
   * event and the local echo of leaving.
   */
  dropConversation(conversationId: string): void;
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

function sameReactions(
  left: readonly ClientMessage["reactions"][number][],
  right: readonly ClientMessage["reactions"][number][],
): boolean {
  if (left.length !== right.length) return false;
  return left.every((entry, index) => {
    const other = right[index]!;
    return (
      entry.emoji === other.emoji &&
      entry.count === other.count &&
      entry.userIds.length === other.userIds.length &&
      entry.userIds.every((userId, position) => userId === other.userIds[position])
    );
  });
}

/**
 * True when two renderings of the same message would look identical.
 *
 * Only the fields a poll can actually observe changing: an edit (`body`,
 * `editedAt`), a delete (`deletedAt`, and `body` emptied), a reaction, and the
 * parent of a reply being deleted. `metadata`, `senderId`, `role` and
 * `replyToMessageId` are immutable after send, so they are not compared.
 *
 * Both adapters return reactions in a deterministic order (earliest-first), so
 * comparing the summaries positionally is stable rather than flapping.
 */
function sameMessage(left: ClientMessage, right: ClientMessage): boolean {
  return (
    left.seq === right.seq &&
    left.body === right.body &&
    left.editedAt === right.editedAt &&
    left.deletedAt === right.deletedAt &&
    (left.replyTo?.excerpt ?? null) === (right.replyTo?.excerpt ?? null) &&
    (left.replyTo?.deleted ?? null) === (right.replyTo?.deleted ?? null) &&
    sameReactions(left.reactions, right.reactions)
  );
}

/**
 * True when two renderings of the same conversation would look identical.
 *
 * `unreadCount` and `lastReadMessageId` are the read-state fields; `name` and
 * the participant set (membership and roles) are mutable too now that groups
 * ship (`docs/decisions/0017`), so a rename or a promotion must count as a
 * change or a polling client would never re-render it. `type`, `pairKey` and
 * `createdAt` are immutable after creation.
 *
 * Participant order is stable across reads (an adapter contract), so comparing
 * positionally is safe rather than flapping.
 */
function sameParticipants(
  left: readonly ClientConversation["participants"][number][],
  right: readonly ClientConversation["participants"][number][],
): boolean {
  if (left.length !== right.length) return false;
  return left.every((participant, index) => {
    const other = right[index]!;
    return (
      participant.userId === other.userId &&
      participant.role === other.role &&
      participant.lastReadMessageId === other.lastReadMessageId
    );
  });
}

function sameConversation(left: ClientConversation, right: ClientConversation): boolean {
  if (left.unreadCount !== right.unreadCount) return false;
  if (left.name !== right.name) return false;
  return sameParticipants(left.participants, right.participants);
}

/**
 * Fold an event's conversation snapshot into a cached conversation, or return
 * the cached object untouched when nothing visible changed (ADR 0017).
 *
 * Only the fields a membership or rename event can move are taken from the
 * snapshot (`name`, `participants`); `unreadCount` stays the cache's, because
 * the snapshot has none - it fans out identically to every recipient while
 * unread counts are viewer-relative (ADR 0009). Returning the same object on
 * no change is load-bearing: events are at-least-once, so a redelivered
 * snapshot must not re-render every mounted component.
 */
function mergeConversationSnapshot(
  cached: ClientConversation,
  snapshot: ClientConversationSnapshot,
): ClientConversation {
  if (
    cached.name === snapshot.name &&
    sameParticipants(cached.participants, snapshot.participants)
  ) {
    return cached;
  }
  return { ...cached, name: snapshot.name, participants: snapshot.participants };
}

/**
 * Fold a freshly polled page into a loaded thread, or return `null` when
 * nothing a renderer can see has changed (`docs/decisions/0016`).
 *
 * Cannot reuse `mergeMessages`: it re-sorts on every call, so the result is
 * always a fresh array and an identity check would report a change on every
 * tick - re-rendering every mounted thread on a timer.
 *
 * Polled messages are only *replaced* into place, never inserted mid-page: an
 * older message the poll happens to include is already in the loaded page if
 * the host paged back to it, and splicing it in otherwise would produce a
 * thread with a hole in it.
 */
function mergePolledMessages(
  current: readonly ClientMessage[],
  incoming: readonly ClientMessage[],
): ClientMessage[] | null {
  const byId = new Map(current.map((message) => [message.id, message]));
  let changed = false;
  for (const message of incoming) {
    const existing = byId.get(message.id);
    if (existing === undefined) {
      // A message newer than everything loaded - the whole point of the poll.
      if (message.seq > highestSeq(current)) {
        byId.set(message.id, message);
        changed = true;
      }
      continue;
    }
    if (sameMessage(existing, message)) continue;
    byId.set(message.id, message);
    changed = true;
  }
  if (!changed) return null;
  return [...byId.values()].sort((left, right) => right.seq - left.seq);
}

/**
 * Fold a freshly polled page into a loaded conversation list, or return `null`
 * when the result would be identical (`docs/decisions/0016`).
 *
 * The polled page wins on both order and content, because the server orders by
 * activity and owns `unreadCount`. Conversations the host had paged in but the
 * page did not mention keep their relative order behind it - a poll fetches
 * page one, and must not truncate history the host already loaded.
 */
function mergeConversations(
  current: readonly ClientConversation[],
  incoming: readonly ClientConversation[],
): ClientConversation[] | null {
  const polled = new Set(incoming.map((item) => item.id));
  const next = [...incoming, ...current.filter((item) => !polled.has(item.id))];
  const unchanged =
    next.length === current.length &&
    next.every((item, index) => {
      const previous = current[index]!;
      return item.id === previous.id && sameConversation(item, previous);
    });
  return unchanged ? null : next;
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

  /** Shared by conversation stream events and group mutations' local echoes. */
  function applyConversationSnapshot(conversation: ClientConversationSnapshot): void {
    store.update((current) => {
      let next = current;

      const list = current.conversations.data;
      const index = list?.conversations.findIndex((item) => item.id === conversation.id) ?? -1;
      if (list != null && index !== -1) {
        const merged = mergeConversationSnapshot(list.conversations[index]!, conversation);
        if (merged !== list.conversations[index]) {
          next = {
            ...next,
            conversations: {
              ...next.conversations,
              data: {
                ...list,
                conversations: list.conversations.map((item, itemIndex) =>
                  itemIndex === index ? merged : item,
                ),
              },
            },
          };
        }
      }

      const one = next.conversationsById[conversation.id];
      if (one?.data != null) {
        const merged = mergeConversationSnapshot(one.data, conversation);
        if (merged !== one.data) {
          next = {
            ...next,
            conversationsById: {
              ...next.conversationsById,
              [conversation.id]: { ...one, data: merged },
            },
          };
        }
      }

      return next;
    });
  }

  /**
   * Drop one conversation from every cache surface - the viewer was removed
   * from it (ADR 0017), so every copy is now unreadable.
   */
  function dropConversation(conversationId: string): void {
    seenSeq.delete(conversationId);
    store.update((current) => {
      let next = current;

      const list = current.conversations.data;
      if (list != null && list.conversations.some((item) => item.id === conversationId)) {
        next = {
          ...next,
          conversations: {
            ...next.conversations,
            data: {
              ...list,
              conversations: list.conversations.filter((item) => item.id !== conversationId),
            },
          },
        };
      }

      if (conversationId in next.conversationsById) {
        const { [conversationId]: _dropped, ...conversationsById } = next.conversationsById;
        next = { ...next, conversationsById };
      }
      if (conversationId in next.messagesByConversation) {
        const { [conversationId]: _dropped, ...messagesByConversation } =
          next.messagesByConversation;
        next = { ...next, messagesByConversation };
      }

      return next;
    });
  }

  function applyParticipantRemoved(
    removedUserIds: readonly string[],
    conversation: ClientConversationSnapshot,
  ): void {
    if (viewerId !== undefined && removedUserIds.includes(viewerId)) {
      dropConversation(conversation.id);
      return;
    }
    applyConversationSnapshot(conversation);
  }

  return {
    applyReactions,
    applyConversationSnapshot,
    applyParticipantRemoved,
    dropConversation,
    getSnapshot: store.getSnapshot,
    subscribe: store.subscribe,
    applyPolledConversations(page) {
      store.update((current) => {
        const list = current.conversations.data;
        if (list === null) return current;
        const merged = mergeConversations(list.conversations, page.conversations);
        if (merged === null) return current;
        return {
          ...current,
          conversations: { ...current.conversations, data: { ...list, conversations: merged } },
        };
      });
    },
    applyPolledMessages(conversationId, page) {
      // Same baseline advance as a fetched page: a stream event (or a later
      // poll) replaying a message in this page must not bump `unreadCount`.
      const newest = highestSeq(page.messages);
      if (newest > (seenSeq.get(conversationId) ?? 0)) seenSeq.set(conversationId, newest);
      store.update((current) => {
        const existing = current.messagesByConversation[conversationId];
        if (existing?.data == null) return current;
        const messages = mergePolledMessages(existing.data.messages, page.messages);
        if (messages === null) return current;
        return {
          ...current,
          messagesByConversation: {
            ...current.messagesByConversation,
            [conversationId]: { ...existing, data: { ...existing.data, messages } },
          },
        };
      });
    },
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

      // Same for membership and renames (ADR 0017): the snapshot merges in
      // place, and a removal of the viewer drops the conversation entirely.
      if (isConversationChatEvent(event)) {
        const conversationEvent: ConversationChatEvent = event;
        if (conversationEvent.type === "participant.removed") {
          applyParticipantRemoved(
            conversationEvent.affectedUserIds,
            conversationEvent.conversation,
          );
        } else {
          applyConversationSnapshot(conversationEvent.conversation);
        }
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
