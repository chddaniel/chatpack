/** React entry point for the Chatpack client and hooks. */
import type { ChatClientOptions } from "../config";
import { createChatClient as createCoreChatClient } from "../client";
import type { ChatClientPlugin } from "../plugin";
import {
  createReactChatClient,
  type ChatClientHookResult,
  type MessageSearchHookResult,
  type MessagesHookResult,
  type ReactChatClient,
  useConversation,
  useConversations,
  useMessages,
  useMessageSearch,
  usePresence,
  useReceipts,
  useRealtimeStatus,
  useTyping,
} from "./hooks";

/** Creates a Chatpack client with React hooks attached. */
export function createChatClient<
  Plugins extends readonly ChatClientPlugin[] = readonly ChatClientPlugin[],
>(options: ChatClientOptions<Plugins> = {}): ReactChatClient<Plugins> {
  return createReactChatClient(createCoreChatClient(options));
}

export {
  useConversation,
  useConversations,
  useMessages,
  useMessageSearch,
  usePresence,
  useReceipts,
  useRealtimeStatus,
  useTyping,
};
export type { ChatClientHookResult, MessageSearchHookResult, MessagesHookResult, ReactChatClient };
