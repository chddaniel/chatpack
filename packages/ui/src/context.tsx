import { createContext, useContext, type ReactNode } from "react";
import type {
  ChatClient,
  ChatRealtimeSnapshot,
  ClientConversation,
  ClientConversationPage,
  ConversationListInput,
  MessageListInput,
  MessageSearchInput,
} from "@chatpack/client";
import type {
  ChatClientHookResult,
  MessageSearchHookResult,
  MessagesHookResult,
} from "@chatpack/client/react";
import type {
  PresenceSnapshot,
  ReceiptSnapshot,
  ReceiptState,
  TypingActions,
  TypingIndicator,
} from "@chatpack/client/plugins";
import { defaultRenderUser, type RenderUser } from "./utils";

type UIClient = ChatClient & {
  useConversations: (input?: ConversationListInput) => ChatClientHookResult<ClientConversationPage>;
  useConversation: (input: { conversationId: string }) => ChatClientHookResult<ClientConversation>;
  useMessages: (input: MessageListInput) => MessagesHookResult;
  useMessageSearch: (input: MessageSearchInput) => MessageSearchHookResult;
  useRealtimeStatus: () => ChatRealtimeSnapshot;
  useTyping: (input: { conversationId: string }) => TypingIndicator | null;
  usePresence: (input?: { userIds?: readonly string[] }) => PresenceSnapshot;
  useReceipts: (input?: { conversationId?: string }) => ReceiptSnapshot | ReceiptState | null;
  /** Present when host configured the first-party typing plugin. */
  typing?: TypingActions;
};

/** Values shared by connected Chatpack UI blocks. */
export interface ChatpackUIContextValue {
  /** The React-enabled Chatpack client used by connected blocks. */
  client: UIClient;
  /** The id of the authenticated viewer. */
  userId: string;
  /** Renders an opaque Chatpack user id for the host application's directory. */
  renderUser: RenderUser;
}

const ChatpackUIContext = createContext<ChatpackUIContextValue | null>(null);

/** Props for {@link ChatpackUIProvider}. */
export interface ChatpackUIProviderProps {
  /** A client created by `createChatClient` from `@chatpack/client/react`. */
  client: UIClient;
  /** The authenticated viewer's id. */
  userId: string;
  /** Optional host-owned user renderer. */
  renderUser?: RenderUser;
  /** Connected blocks. */
  children: ReactNode;
}

/** Provides client and host-owned identity rendering to connected blocks. */
export function ChatpackUIProvider({
  client,
  userId,
  renderUser = defaultRenderUser,
  children,
}: ChatpackUIProviderProps) {
  return (
    <ChatpackUIContext.Provider value={{ client, userId, renderUser }}>
      <div className="chatpack-ui-root">{children}</div>
    </ChatpackUIContext.Provider>
  );
}

/** Reads the nearest {@link ChatpackUIProvider} value. */
export function useChatpackUI(): ChatpackUIContextValue {
  const value = useContext(ChatpackUIContext);
  if (value === null) {
    throw new Error("useChatpackUI must be called inside <ChatpackUIProvider>.");
  }
  return value;
}
