"use client";

import { createContext, useContext, type ReactNode } from "react";

import type { ProfileDirectory } from "@/hooks/use-profiles";
import type { ApplicationChatClient } from "@/lib/chatpack.client";
import type { ApplicationFileClient } from "@/lib/filepack.client";
import type { PublicProfile } from "@/lib/profiles";

/**
 * Everything the chat screen's parts need from its parent.
 *
 * One context instead of prop drilling: a message row four levels down needs the
 * same client, the same profile directory and the same viewer id as the sidebar,
 * and passing all three through every layer buries the interesting code.
 */
export interface ChatContextValue {
  /** The one Chatpack client for this screen. Created once in `ChatShell`. */
  client: ApplicationChatClient;
  /** Filepack upload client for message attachments. */
  files: ApplicationFileClient;
  /** The signed-in user, as your app knows them. */
  viewer: PublicProfile;
  /** Name and avatar lookup for the opaque user ids Chatpack returns. */
  directory: ProfileDirectory;
  /** Conversations the viewer has muted (`docs/decisions/0021`). */
  mutedConversationIds: ReadonlySet<string>;
  /** Mute or unmute one conversation, refreshing the set above. */
  toggleMute: (conversationId: string) => Promise<void>;
  /** Users the viewer has blocked (`docs/decisions/0021`). */
  blockedUserIds: ReadonlySet<string>;
  /** Block or unblock one user, refreshing the set above. */
  toggleBlock: (userId: string) => Promise<void>;
  /** Open a conversation in the message pane, or `null` to close it. */
  select: (conversationId: string | null) => void;
}

const ChatContext = createContext<ChatContextValue | null>(null);

export function ChatProvider({
  value,
  children,
}: {
  value: ChatContextValue;
  children: ReactNode;
}) {
  return <ChatContext.Provider value={value}>{children}</ChatContext.Provider>;
}

export function useChat(): ChatContextValue {
  const value = useContext(ChatContext);
  if (value === null) throw new Error("useChat must be called inside <ChatProvider>.");
  return value;
}
