"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { ClientMessage } from "@chatpack/client";
import { MessagesSquare, X } from "lucide-react";
import Link from "next/link";
import { toast } from "sonner";

import { ChatProvider, type ChatContextValue } from "@/components/chat/chat-context";
import { ConversationHeader } from "@/components/chat/conversation-header";
import { ConversationSidebar } from "@/components/chat/conversation-sidebar";
import { MessageComposer } from "@/components/chat/message-composer";
import { MessageList } from "@/components/chat/message-list";
import { ProfileSearch } from "@/components/profile-search";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Sheet, SheetClose, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { useProfileDirectory } from "@/hooks/use-profiles";
import { createApplicationChatClient } from "@/lib/chatpack.client";
import { createApplicationFileClient } from "@/lib/filepack.client";
import type { PublicProfile } from "@/lib/profiles";

/**
 * The whole chat screen, and the only place that owns state.
 *
 * Everything below it reads the client, the viewer and the profile directory out
 * of `ChatProvider` instead of taking them as props - see
 * `components/chat/chat-context.tsx` for why.
 *
 * One client per screen: `createApplicationChatClient` opens a realtime
 * connection, so creating it inside a `useMemo` (rather than on every render)
 * is what keeps that to one SSE stream per tab.
 */
export function ChatShell({
  user,
  initialConversationId,
}: {
  user: PublicProfile;
  initialConversationId: string | null;
}) {
  const client = useMemo(() => createApplicationChatClient(user.id), [user.id]);
  const files = useMemo(() => createApplicationFileClient(), []);
  const directory = useProfileDirectory(user);
  const conversations = client.useConversations({ limit: 50 });
  const [selectedId, setSelectedId] = useState<string | null>(initialConversationId);
  const [replyTo, setReplyTo] = useState<ClientMessage | null>(null);
  const [conversationsOpen, setConversationsOpen] = useState(false);
  const [mutedConversationIds, setMutedConversationIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [blockedUserIds, setBlockedUserIds] = useState<ReadonlySet<string>>(() => new Set());

  const rows = conversations.data?.conversations ?? [];
  const selected = rows.find((conversation) => conversation.id === selectedId) ?? null;

  /**
   * Every user id the sidebar can name, as a stable string.
   *
   * Keyed on the *set* rather than the conversation list: a new message rewrites
   * `conversations.data`, and re-resolving fifty profiles because somebody typed
   * "ok" would be silly.
   */
  const participantKey = useMemo(
    () =>
      [
        ...new Set(
          rows.flatMap((conversation) =>
            conversation.participants.map((participant) => participant.userId),
          ),
        ),
      ]
        .sort()
        .join(","),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `rows` is derived from this
    [conversations.data],
  );
  const participantIds = useMemo(
    () => (participantKey === "" ? [] : participantKey.split(",")),
    [participantKey],
  );

  useEffect(() => {
    directory.ensure(participantIds);
  }, [directory, participantIds]);

  useEffect(() => {
    if (participantIds.length === 0) return;
    // Presence is ephemeral and in-memory, so a fresh tab knows nothing until
    // somebody comes or goes. This one request seeds the current state; the
    // `presence.online` / `presence.offline` events keep it current afterwards
    // (`docs/decisions/0008`).
    void client.presence.get({ userIds: participantIds });
  }, [client, participantIds]);

  const refreshMutes = useCallback(async () => {
    const result = await client.moderation.listMutedConversations({ limit: 100 });
    if (result.data) {
      setMutedConversationIds(new Set(result.data.mutes.map((mute) => mute.conversationId)));
    }
  }, [client]);

  const refreshBlocks = useCallback(async () => {
    const result = await client.moderation.listBlockedUsers({ limit: 100 });
    if (result.data) {
      setBlockedUserIds(new Set(result.data.blocks.map((block) => block.blockedUserId)));
    }
  }, [client]);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      client.moderation.listMutedConversations({ limit: 100 }),
      client.moderation.listBlockedUsers({ limit: 100 }),
    ]).then(([mutes, blocks]) => {
      if (cancelled) return;
      if (mutes.data) {
        setMutedConversationIds(new Set(mutes.data.mutes.map((mute) => mute.conversationId)));
      }
      if (blocks.data) {
        setBlockedUserIds(new Set(blocks.data.blocks.map((block) => block.blockedUserId)));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [client]);

  const toggleMute = useCallback(
    async (conversationId: string) => {
      const result = mutedConversationIds.has(conversationId)
        ? await client.moderation.unmuteConversation({ conversationId })
        : await client.moderation.muteConversation({ conversationId });
      if (result.error) {
        toast.error(result.error.message);
        return;
      }
      await refreshMutes();
    },
    [client, mutedConversationIds, refreshMutes],
  );

  const toggleBlock = useCallback(
    async (userId: string) => {
      const blocked = blockedUserIds.has(userId);
      const result = blocked
        ? await client.moderation.unblockUser({ targetUserId: userId })
        : await client.moderation.blockUser({ targetUserId: userId });
      if (result.error) {
        toast.error(result.error.message);
        return;
      }
      // Blocking is one-sided and forward-looking: existing conversations stay
      // readable, new directs between you two are refused
      // (`docs/decisions/0021`).
      toast.success(blocked ? "Unblocked." : "Blocked.");
      await refreshBlocks();
    },
    [blockedUserIds, client, refreshBlocks],
  );

  const select = useCallback((conversationId: string | null) => {
    setSelectedId(conversationId);
    setReplyTo(null);
    setConversationsOpen(false);
  }, []);

  const context = useMemo<ChatContextValue>(
    () => ({
      client,
      files,
      viewer: user,
      directory,
      mutedConversationIds,
      toggleMute,
      blockedUserIds,
      toggleBlock,
      select,
    }),
    [
      blockedUserIds,
      client,
      directory,
      files,
      mutedConversationIds,
      select,
      toggleBlock,
      toggleMute,
      user,
    ],
  );

  const sidebar = <ConversationSidebar conversations={conversations} selectedId={selectedId} />;

  return (
    <ChatProvider value={context}>
      <main className="grid h-dvh bg-background md:grid-cols-[320px_1fr]">
        <aside className="hidden md:block">{sidebar}</aside>

        <Sheet open={conversationsOpen} onOpenChange={setConversationsOpen}>
          <SheetContent side="left" className="w-80 p-0" showCloseButton={false}>
            <SheetTitle className="sr-only">Conversations</SheetTitle>
            <SheetClose asChild>
              <Button
                className="absolute top-3 right-3 z-10"
                size="icon-sm"
                variant="ghost"
                aria-label="Close conversations"
              >
                <X />
              </Button>
            </SheetClose>
            {sidebar}
          </SheetContent>
        </Sheet>

        <section className="flex min-w-0 flex-col">
          {conversations.error !== null && (
            <div className="p-6">
              <Alert variant="destructive">
                <AlertTitle>Could not load conversations</AlertTitle>
                <AlertDescription>{conversations.error.message}</AlertDescription>
              </Alert>
            </div>
          )}

          {selected === null ? (
            <Empty className="flex-1">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <MessagesSquare />
                </EmptyMedia>
                <EmptyTitle>
                  {conversations.isPending
                    ? "Loading your conversations"
                    : rows.length === 0
                      ? "No conversations yet"
                      : "Pick a chat"}
                </EmptyTitle>
                <EmptyDescription>
                  {rows.length === 0
                    ? "Search for someone to start a direct message, make a group, or join a public channel."
                    : "Choose a conversation on the left to start reading."}
                </EmptyDescription>
              </EmptyHeader>
              <div className="flex items-center gap-2">
                <ProfileSearch
                  onSelect={async (profile) => {
                    directory.put(profile);
                    const result = await client.conversations.create({ otherUserId: profile.id });
                    if (result.error) {
                      toast.error(result.error.message);
                      return;
                    }
                    select(result.data.id);
                  }}
                />
                <Button asChild variant="outline">
                  <Link href="/channels">Browse channels</Link>
                </Button>
                <Button
                  className="md:hidden"
                  variant="outline"
                  onClick={() => setConversationsOpen(true)}
                >
                  Conversations
                </Button>
              </div>
            </Empty>
          ) : (
            <>
              <ConversationHeader
                conversation={selected}
                onOpenConversations={() => setConversationsOpen(true)}
              />
              <MessageList
                conversationId={selected.id}
                conversation={selected}
                onReply={setReplyTo}
              />
              <MessageComposer
                conversationId={selected.id}
                conversation={selected}
                replyTo={replyTo}
                onClearReply={() => setReplyTo(null)}
              />
            </>
          )}
        </section>
      </main>
    </ChatProvider>
  );
}
