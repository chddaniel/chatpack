/** React hooks that bind Chatpack cache and realtime state to a client. */
import { useCallback, useEffect, useMemo } from "react";
import type {
  ChatClient,
  ChatClientWithPlugins,
  ConversationListInput,
  MessageListInput,
  MessageSearchInput,
} from "../client";
import type { ChatClientResult, ChatpackClientError } from "../errors";
import type { ChatClientPlugin } from "../plugin";
import type { ChatRealtimeSnapshot } from "../realtime";
import { messageSearchKey, type QueryState } from "../store-cache";
import type { ClientConversation, ClientConversationPage, ClientMessagePage } from "../wire";
import type { PresenceSnapshot } from "../plugins/presence";
import type { ReceiptSnapshot } from "../plugins/receipts";
import type { TypingIndicator, TypingSnapshot } from "../plugins/typing";
import { useExternalStore, useOptionalExternalStore } from "./store";

/** Common result shape returned by Chatpack data hooks. */
export interface ChatClientHookResult<T> {
  data: T | null;
  error: ChatpackClientError | null;
  isPending: boolean;
  isRefetching: boolean;
  refetch(): Promise<ChatClientResult<T>>;
}

/** Result shape for message history, including cursor pagination. */
export interface MessagesHookResult extends ChatClientHookResult<ClientMessagePage> {
  loadMore(): Promise<ChatClientResult<ClientMessagePage>>;
}

/** Result shape for participant-scoped message search and ranked pagination. */
export type MessageSearchHookResult = MessagesHookResult;

const emptyConversationPage: ClientConversationPage = { conversations: [], nextCursor: null };
const emptyMessagePage: ClientMessagePage = { messages: [], nextCursor: null };
const emptyTyping: TypingSnapshot = {};
const emptyPresence: PresenceSnapshot = {};
const emptyReceipts: ReceiptSnapshot = {};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTypingSnapshot(value: unknown): value is TypingSnapshot {
  return isRecord(value);
}

function isPresenceSnapshot(value: unknown): value is PresenceSnapshot {
  return isRecord(value);
}

function isReceiptSnapshot(value: unknown): value is ReceiptSnapshot {
  return isRecord(value);
}

function useRealtimeEffect(client: ChatClient): void {
  useEffect(() => {
    client.realtime.connect();
  }, [client]);
}

function useQuery<T>(
  query: QueryState<T>,
  refetch: () => Promise<ChatClientResult<T>>,
  fallback: T | null,
): ChatClientHookResult<T> {
  const run = useCallback(() => refetch(), [refetch]);
  return {
    data: query.data ?? fallback,
    error: query.error,
    isPending: query.isPending,
    isRefetching: query.isRefetching,
    refetch: run,
  };
}

/** Loads and subscribes to the authenticated user's conversations. */
export function useConversations(
  client: ChatClient,
  input: ConversationListInput = {},
): ChatClientHookResult<ClientConversationPage> {
  const requestInput = useMemo(
    () => ({
      ...(input.limit === undefined ? {} : { limit: input.limit }),
      ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
    }),
    [input.cursor, input.limit],
  );
  const query = useExternalStore(client.$store).conversations;
  const refetch = useCallback(
    () => client.conversations.list(requestInput),
    [client, requestInput],
  );
  useEffect(() => {
    void refetch();
  }, [refetch]);
  // The list reorders and updates unread counts from stream events, so it needs
  // the connection open even when no thread is mounted.
  useRealtimeEffect(client);
  return useQuery(query, refetch, emptyConversationPage);
}

/** Loads and subscribes to one conversation. */
export function useConversation(
  client: ChatClient,
  input: { conversationId: string },
): ChatClientHookResult<ClientConversation> {
  const conversationId = input.conversationId;
  const query = useExternalStore(client.$store).conversationsById[conversationId] ?? {
    data: null,
    error: null,
    isPending: true,
    isRefetching: false,
  };
  const refetch = useCallback(
    () => client.conversations.get({ conversationId }),
    [client, conversationId],
  );
  useEffect(() => {
    void refetch();
  }, [refetch]);
  return useQuery(query, refetch, null);
}

/** Loads and subscribes to one conversation's message history. */
export function useMessages(client: ChatClient, input: MessageListInput): MessagesHookResult {
  const requestInput = useMemo(
    () => ({
      conversationId: input.conversationId,
      ...(input.limit === undefined ? {} : { limit: input.limit }),
      ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
    }),
    [input.conversationId, input.cursor, input.limit],
  );
  const query =
    useExternalStore(client.$store).messagesByConversation[requestInput.conversationId] ??
    (requestInput.conversationId === ""
      ? { data: emptyMessagePage, error: null, isPending: false, isRefetching: false }
      : { data: null, error: null, isPending: true, isRefetching: false });
  const refetch = useCallback(
    () =>
      requestInput.conversationId === ""
        ? Promise.resolve({ data: emptyMessagePage, error: null })
        : client.messages.list(requestInput),
    [client, requestInput],
  );
  useEffect(() => {
    void refetch();
  }, [refetch]);
  useRealtimeEffect(client);
  const loadMore = useCallback(async () => {
    const current = client.$store.getSnapshot().messagesByConversation[requestInput.conversationId];
    if (current?.data === undefined || current.data === null) return refetch();
    const nextCursor = current.data.nextCursor;
    if (nextCursor === null) {
      return { data: current.data, error: null };
    }
    if (nextCursor === undefined) return refetch();
    return client.messages.list({ ...requestInput, cursor: nextCursor });
  }, [client, refetch, requestInput]);
  return { ...useQuery(query, refetch, emptyMessagePage), loadMore };
}

/** Searches the authenticated participant's conversations and keeps each query isolated. */
export function useMessageSearch(
  client: ChatClient,
  input: MessageSearchInput,
): MessageSearchHookResult {
  const requestInput = useMemo(
    () => ({
      query: input.query,
      ...(input.limit === undefined ? {} : { limit: input.limit }),
      ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
    }),
    [input.cursor, input.limit, input.query],
  );
  const key = messageSearchKey(requestInput.query);
  const searches = useExternalStore(client.$store).messageSearches;
  const query =
    key === ""
      ? { data: emptyMessagePage, error: null, isPending: false, isRefetching: false }
      : (searches[key] ?? { data: null, error: null, isPending: true, isRefetching: false });
  const refetch = useCallback(
    () =>
      key === ""
        ? Promise.resolve({ data: emptyMessagePage, error: null })
        : client.messages.search(requestInput),
    [client, key, requestInput],
  );
  useEffect(() => {
    void refetch();
  }, [refetch]);
  const loadMore = useCallback(async () => {
    const current = client.$store.getSnapshot().messageSearches[key];
    if (current?.data == null) return refetch();
    const nextCursor = current.data.nextCursor;
    if (nextCursor === null) return { data: current.data, error: null };
    return client.messages.search({ ...requestInput, cursor: nextCursor });
  }, [client, key, refetch, requestInput]);
  return { ...useQuery(query, refetch, emptyMessagePage), loadMore };
}

/** Subscribes to realtime connection status and starts the stream. */
export function useRealtimeStatus(client: ChatClient): ChatRealtimeSnapshot {
  const snapshot = useExternalStore({
    getSnapshot: client.realtime.getSnapshot,
    subscribe: client.realtime.subscribeStatus,
  });
  useRealtimeEffect(client);
  return snapshot;
}

/** Reads the current typing indicator for one conversation. */
export function useTyping(
  client: ChatClient,
  input: { conversationId: string },
): TypingIndicator | null {
  useRealtimeEffect(client);
  const value = useOptionalExternalStore(client.$getPluginState("typing"), emptyTyping);
  if (!isTypingSnapshot(value)) return null;
  return value[input.conversationId] ?? null;
}

/** Reads presence state, optionally limited to selected user ids. */
export function usePresence(
  client: ChatClient,
  input: { userIds?: readonly string[] } = {},
): PresenceSnapshot {
  useRealtimeEffect(client);
  const value = useOptionalExternalStore(client.$getPluginState("presence"), emptyPresence);
  const snapshot = isPresenceSnapshot(value) ? value : emptyPresence;
  return useMemo(() => {
    if (input.userIds === undefined) return snapshot;
    const selected: PresenceSnapshot = {};
    for (const userId of input.userIds) {
      const presence = snapshot[userId];
      if (presence !== undefined) selected[userId] = presence;
    }
    return selected;
  }, [input.userIds, snapshot]);
}

/** Reads receipt state, optionally limited to one conversation. */
export function useReceipts(
  client: ChatClient,
  input: { conversationId?: string } = {},
): ReceiptSnapshot | ReceiptSnapshot[string] | null {
  useRealtimeEffect(client);
  const value = useOptionalExternalStore(client.$getPluginState("receipts"), emptyReceipts);
  const snapshot = isReceiptSnapshot(value) ? value : emptyReceipts;
  if (input.conversationId === undefined) return snapshot;
  return snapshot[input.conversationId] ?? null;
}

/** Chatpack client surface with React hooks attached. */
export type ReactChatClient<Plugins extends readonly ChatClientPlugin[]> = ChatClient & {
  useConversations(input?: ConversationListInput): ChatClientHookResult<ClientConversationPage>;
  useConversation(input: { conversationId: string }): ChatClientHookResult<ClientConversation>;
  useMessages(input: MessageListInput): MessagesHookResult;
  useMessageSearch(input: MessageSearchInput): MessageSearchHookResult;
  useRealtimeStatus(): ChatRealtimeSnapshot;
  useTyping(input: { conversationId: string }): TypingIndicator | null;
  usePresence(input?: { userIds?: readonly string[] }): PresenceSnapshot;
  useReceipts(input?: {
    conversationId?: string;
  }): ReceiptSnapshot | ReceiptSnapshot[string] | null;
} & ChatClientWithPlugins<Plugins>;

/** Attaches Chatpack React hooks to an existing client instance. */
export function createReactChatClient<Plugins extends readonly ChatClientPlugin[]>(
  client: ChatClientWithPlugins<Plugins>,
): ReactChatClient<Plugins> {
  return Object.assign(client, {
    useConversations: (input?: ConversationListInput) => useConversations(client, input),
    useConversation: (input: { conversationId: string }) => useConversation(client, input),
    useMessages: (input: MessageListInput) => useMessages(client, input),
    useMessageSearch: (input: MessageSearchInput) => useMessageSearch(client, input),
    useRealtimeStatus: () => useRealtimeStatus(client),
    useTyping: (input: { conversationId: string }) => useTyping(client, input),
    usePresence: (input?: { userIds?: readonly string[] }) => usePresence(client, input),
    useReceipts: (input?: { conversationId?: string }) => useReceipts(client, input),
  }) as ReactChatClient<Plugins>;
}
