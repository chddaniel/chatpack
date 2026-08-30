import { createContext, useContext, type ReactNode } from "react";
import type { ReactChatClient } from "@chatpack/client/react";
import type { ChatClientPlugin } from "@chatpack/client";
import { defaultRenderUser, type RenderUser } from "./utils";

type UIClient = ReactChatClient<readonly ChatClientPlugin[]>;

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
