"use client";

import { useMemo, useState } from "react";
import type { ChatClientHookResult } from "@chatpack/client/react";
import type { ClientConversationPage } from "@chatpack/client";
import { ChatpackUIProvider, ConnectionStatus, UnreadBadge } from "@chatpack/ui";
import { BellOff, Compass, Hash, Search, ShieldAlert, Users } from "lucide-react";
import Link from "next/link";
import Image, { type ImageProps } from "next/image";
import { toast } from "sonner";

import { useChat } from "@/components/chat/chat-context";
import { NewGroupDialog } from "@/components/chat/new-group-dialog";
import { SearchDialog } from "@/components/chat/search-dialog";
import { AuthButton } from "@/components/auth-button";
import { ProfileSearch } from "@/components/profile-search";
import { ThemeSelector } from "@/components/theme-selector";
import { Avatar, AvatarBadge, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { conversationKind, conversationTitle, otherParticipantId } from "@/lib/conversation";
import { initialsOf, type PublicProfile } from "@/lib/profiles";

export function ConversationSidebar({
  conversations,
  selectedId,
  isModerator,
}: {
  conversations: ChatClientHookResult<ClientConversationPage>;
  selectedId: string | null;
  isModerator: boolean;
}) {
  const { client, viewer, directory, mutedConversationIds, select } = useChat();
  const presence = client.usePresence();
  const [searchQuery, setSearchQuery] = useState("");
  const [newGroupOpen, setNewGroupOpen] = useState(false);
  const [newMenuOpen, setNewMenuOpen] = useState(false);
  const [directOpen, setDirectOpen] = useState(false);
  const [messageSearchOpen, setMessageSearchOpen] = useState(false);

  async function openDirect(profile: PublicProfile): Promise<void> {
    directory.put(profile);
    // Find-or-create: core derives a `pairKey` from the two ids, so calling this
    // twice for the same person returns the same conversation, never a second one
    // (`docs/decisions/0002`).
    const result = await client.conversations.create({ otherUserId: profile.id });
    if (result.error) {
      toast.error(result.error.message);
      return;
    }
    select(result.data.id);
  }

  const rows = useMemo(() => conversations.data?.conversations ?? [], [conversations.data]);
  const filteredRows = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (query.length === 0) return rows;
    return rows.filter((conversation) =>
      conversationTitle(conversation, viewer.id, directory.nameOf).toLowerCase().includes(query),
    );
  }, [directory, rows, searchQuery, viewer.id]);
  const initialLoading = conversations.isPending && rows.length === 0;
  const empty = !initialLoading && conversations.error === null && rows.length === 0;

  return (
    <div className="flex h-full min-h-0 flex-col border-r border-transparent bg-sidebar text-sidebar-foreground">
      <div className="flex h-[54px] items-center justify-between gap-2 px-4 pt-4 pb-3">
        <p className="min-w-0 flex-1 text-base font-semibold leading-[19px]">Messages</p>
        <DropdownMenu open={newMenuOpen} onOpenChange={setNewMenuOpen}>
          <DropdownMenuTrigger asChild>
            <Button size="sm" className="app-control-shadow h-[26px] rounded-lg px-2.5 text-xs">
              New
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            <DropdownMenuItem onSelect={() => setDirectOpen(true)}>Direct message</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setNewGroupOpen(true)}>
              <Users />
              New group
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setMessageSearchOpen(true)}>
              <Search />
              Search messages
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild>
              <Link href="/channels">
                <Compass />
                Browse channels
              </Link>
            </DropdownMenuItem>
            {isModerator && (
              <DropdownMenuItem asChild>
                <Link href="/moderation">
                  <ShieldAlert />
                  Moderation
                </Link>
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {conversations.error === null && !empty && (
        <div className="px-4 pb-2">
          <div className="relative">
            <Input
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder="Search conversations"
              aria-label="Search conversations"
              className="h-8 rounded-[10px] border-input bg-transparent px-2.5 text-[13px] placeholder:text-muted-foreground focus-visible:ring-2"
            />
          </div>
        </div>
      )}

      {conversations.error !== null ? (
        <SidebarState
          image="/chatpack/error-3d.png"
          title="Couldn't load conversations"
          description="Something went wrong on our side. Your messages are safe."
          detail={conversations.error.code}
          actionLabel="Try again"
          onAction={() => void conversations.refetch()}
        />
      ) : initialLoading ? (
        <ScrollArea className="flex-1">
          <div className="space-y-1 px-2 pt-1">
            <div className="h-9 rounded-[10px] bg-sidebar-accent" />
            {[120, 96, 140, 108, 84].map((width, index) => (
              <div key={index} className="flex h-[52px] items-center gap-2.5 px-2">
                <Skeleton className="size-9 rounded-full bg-sidebar-accent" />
                <Skeleton className="h-3 rounded-full bg-sidebar-accent" style={{ width }} />
              </div>
            ))}
          </div>
        </ScrollArea>
      ) : empty ? (
        <SidebarState
          image="/chatpack/msg-3d.png"
          title="No conversations yet"
          description="Start one and it will appear here. Conversations sync across every device in real time."
          actionLabel="New conversation"
          onAction={() => setDirectOpen(true)}
          imageSize={52}
        />
      ) : (
        <ScrollArea className="flex-1">
          <nav aria-label="Conversations" className="flex flex-col gap-0.5 px-4 pt-1">
            {filteredRows.length === 0 ? (
              <p className="px-2 py-6 text-center text-[13px] text-muted-foreground">
                No conversations match.
              </p>
            ) : (
              filteredRows.map((conversation) => {
                const title = conversationTitle(conversation, viewer.id, directory.nameOf);
                const kind = conversationKind(conversation);
                const otherId = otherParticipantId(conversation, viewer.id);
                const online = otherId === null ? false : (presence[otherId]?.online ?? false);
                const muted = mutedConversationIds.has(conversation.id);
                return (
                  <button
                    type="button"
                    key={conversation.id}
                    onClick={() => select(conversation.id)}
                    aria-current={selectedId === conversation.id ? "page" : undefined}
                    className={`flex h-[50px] w-full items-center gap-2.5 rounded-[12px] px-2 text-left transition-colors hover:bg-sidebar-accent ${
                      selectedId === conversation.id ? "bg-sidebar-accent" : ""
                    }`}
                  >
                    <Avatar className="size-9 after:hidden">
                      <AvatarImage
                        src={
                          otherId === null
                            ? undefined
                            : (directory.profiles[otherId]?.image ?? undefined)
                        }
                      />
                      <AvatarFallback className="bg-sidebar-accent text-xs text-muted-foreground">
                        {kind === "direct" ? initialsOf(title) : <Hash className="size-4" />}
                      </AvatarFallback>
                      {online && <AvatarBadge className="bg-online" aria-label="Online" />}
                    </Avatar>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5">
                        <span
                          className={`min-w-0 flex-1 truncate text-sm leading-[17px] ${
                            conversation.unreadCount > 0 ? "font-semibold" : "font-normal"
                          }`}
                        >
                          {title}
                        </span>
                        {muted && <BellOff className="size-3 shrink-0 text-muted-foreground" />}
                      </span>
                    </span>
                    {/* Viewer-relative and never stored: core counts it per request
                    from your read-state (`docs/decisions/0009`). */}
                    <UnreadBadge count={conversation.unreadCount} />
                  </button>
                );
              })
            )}
          </nav>
        </ScrollArea>
      )}

      <div className="hidden items-center gap-2 border-t border-sidebar-border px-3 py-2 text-xs text-muted-foreground">
        <ChatpackUIProvider
          client={client}
          userId={viewer.id}
          renderUser={(userId) => directory.nameOf(userId)}
        >
          <ConnectionStatus />
        </ChatpackUIProvider>
      </div>

      <div className="app-sidebar-footer flex flex-col gap-2 p-3">
        <div className={isModerator ? "grid grid-cols-2 gap-2" : "grid gap-2"}>
          <Button asChild variant="outline" size="sm">
            <Link href="/channels">
              <Compass />
              Channels
            </Link>
          </Button>
          {isModerator && (
            <Button asChild variant="outline" size="sm">
              <Link href="/moderation">
                <ShieldAlert />
                Moderation
              </Link>
            </Button>
          )}
        </div>
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1">
            <AuthButton user={viewer} />
          </div>
          <ThemeSelector />
        </div>
      </div>

      {newGroupOpen && <NewGroupDialog onClose={() => setNewGroupOpen(false)} />}
      <ProfileSearch
        open={directOpen}
        onOpenChange={setDirectOpen}
        hideTrigger
        onSelect={openDirect}
      />
      <SearchDialog open={messageSearchOpen} onOpenChange={setMessageSearchOpen} hideTrigger />
    </div>
  );
}

function SidebarState({
  image,
  title,
  description,
  detail,
  actionLabel,
  onAction,
  imageSize,
}: {
  image: ImageProps["src"];
  title: string;
  description: string;
  detail?: string;
  actionLabel: string;
  onAction: () => void;
  imageSize?: number;
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-[18px] px-8 text-center">
      <div className="flex w-full max-w-[240px] flex-col items-center gap-3">
        <Image src={image} alt="" width={imageSize ?? 46} height={imageSize ?? 46} />
        <div className="flex w-full flex-col items-center gap-2">
          <p className="text-[15px] font-semibold leading-[18px]">{title}</p>
          <p className="max-w-[240px] text-[13px] leading-4 text-muted-foreground">{description}</p>
          {detail && (
            <p className="font-mono text-[11px] leading-[14px] text-muted-foreground">{detail}</p>
          )}
        </div>
      </div>
      <Button
        type="button"
        size="sm"
        onClick={onAction}
        className="app-control-shadow h-[34px] rounded-[10px] px-3.5 text-[13px]"
      >
        {actionLabel}
      </Button>
    </div>
  );
}
