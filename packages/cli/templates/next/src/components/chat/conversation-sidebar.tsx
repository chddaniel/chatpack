"use client";

import { useState } from "react";
import type { ChatClientHookResult } from "@chatpack/client/react";
import type { ChatRealtimeStatus, ClientConversationPage } from "@chatpack/client";
import { BellOff, Compass, Hash, ShieldAlert, Users } from "lucide-react";
import Link from "next/link";
import { toast } from "sonner";

import { useChat } from "@/components/chat/chat-context";
import { NewGroupDialog } from "@/components/chat/new-group-dialog";
import { SearchDialog } from "@/components/chat/search-dialog";
import { AuthButton } from "@/components/auth-button";
import { ProfileSearch } from "@/components/profile-search";
import { Avatar, AvatarBadge, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { conversationKind, conversationTitle, otherParticipantId } from "@/lib/conversation";
import { initialsOf, type PublicProfile } from "@/lib/profiles";

/** What the connection chip says, per realtime status (`docs/decisions/0016`). */
const CONNECTION_LABELS: Record<ChatRealtimeStatus, string> = {
  idle: "offline",
  connecting: "connecting",
  open: "live",
  closed: "reconnecting",
  polling: "polling",
};

export function ConversationSidebar({
  conversations,
  selectedId,
}: {
  conversations: ChatClientHookResult<ClientConversationPage>;
  selectedId: string | null;
}) {
  const { client, viewer, directory, mutedConversationIds, select } = useChat();
  const presence = client.usePresence();
  const realtime = client.useRealtimeStatus();
  const [newGroupOpen, setNewGroupOpen] = useState(false);

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

  return (
    <div className="flex h-full flex-col border-r bg-sidebar">
      <div className="flex items-center justify-between gap-2 border-b p-4">
        <div className="min-w-0">
          <p className="font-semibold">Messages</p>
          <p className="truncate text-xs text-muted-foreground">{viewer.name}</p>
        </div>
        <div className="flex items-center gap-1">
          <SearchDialog />
          <Button
            size="icon"
            variant="outline"
            onClick={() => setNewGroupOpen(true)}
            aria-label="New group"
          >
            <Users />
          </Button>
          <ProfileSearch onSelect={openDirect} />
        </div>
      </div>

      <div className="flex items-center gap-2 border-b px-4 py-2 text-xs text-muted-foreground">
        <span
          className={`size-2 rounded-full ${
            realtime.status === "open"
              ? "bg-emerald-500"
              : realtime.status === "polling"
                ? "bg-amber-500"
                : "bg-muted-foreground/50"
          }`}
        />
        {/* "polling" is not a failure: with `mode: "auto"` the client falls back
            to periodic refetches wherever SSE cannot survive - a proxy that
            buffers, or a serverless host that caps a response
            (`docs/decisions/0016`). */}
        <span>{CONNECTION_LABELS[realtime.status]}</span>
      </div>

      <ScrollArea className="flex-1">
        <div className="space-y-1 p-2">
          {conversations.isPending &&
            [1, 2, 3].map((item) => <Skeleton key={item} className="h-14 w-full" />)}
          {conversations.data?.conversations.map((conversation) => {
            const title = conversationTitle(conversation, viewer.id, directory.nameOf);
            const kind = conversationKind(conversation);
            const otherId = otherParticipantId(conversation, viewer.id);
            const online = otherId === null ? false : (presence[otherId]?.online ?? false);
            const muted = mutedConversationIds.has(conversation.id);
            return (
              <button
                key={conversation.id}
                onClick={() => select(conversation.id)}
                className={`flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left hover:bg-accent ${
                  selectedId === conversation.id ? "bg-accent" : ""
                }`}
              >
                <Avatar>
                  <AvatarImage
                    src={
                      otherId === null
                        ? undefined
                        : (directory.profiles[otherId]?.image ?? undefined)
                    }
                  />
                  <AvatarFallback>
                    {kind === "direct" ? initialsOf(title) : <Hash className="size-4" />}
                  </AvatarFallback>
                  {online && <AvatarBadge className="bg-emerald-500" aria-label="Online" />}
                </Avatar>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    <span className="min-w-0 flex-1 truncate text-sm font-medium">{title}</span>
                    {muted && <BellOff className="size-3 shrink-0 text-muted-foreground" />}
                  </span>
                  {kind !== "direct" && (
                    <span className="text-xs text-muted-foreground">
                      {kind} · {conversation.participants.length} members
                    </span>
                  )}
                </span>
                {/* Viewer-relative and never stored: core counts it per request
                    from your read-state (`docs/decisions/0009`). */}
                {conversation.unreadCount > 0 && <Badge>{conversation.unreadCount}</Badge>}
              </button>
            );
          })}
        </div>
      </ScrollArea>

      <div className="flex flex-col gap-2 border-t p-3">
        <div className="grid grid-cols-2 gap-2">
          <Button asChild variant="outline" size="sm">
            <Link href="/channels">
              <Compass />
              Channels
            </Link>
          </Button>
          <Button asChild variant="outline" size="sm">
            <Link href="/moderation">
              <ShieldAlert />
              Moderation
            </Link>
          </Button>
        </div>
        <AuthButton user={viewer} />
      </div>

      {newGroupOpen && <NewGroupDialog onClose={() => setNewGroupOpen(false)} />}
    </div>
  );
}
