"use client";

import { useState } from "react";
import type { ClientConversation } from "@chatpack/client";
import {
  MAX_CONVERSATION_NAME_LENGTH,
  type ChannelJoinPolicy,
  type ChannelVisibility,
} from "@chatpack/core";
import {
  Ban,
  Bell,
  BellOff,
  Hash,
  LogOut,
  Menu,
  MoreVertical,
  Pencil,
  TriangleAlert,
  Users,
} from "lucide-react";
import { toast } from "sonner";

import { useChat } from "@/components/chat/chat-context";
import { MembersPanel } from "@/components/chat/members-panel";
import { ReportDialog } from "@/components/chat/report-dialog";
import { Avatar, AvatarBadge, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
  conversationKind,
  conversationTitle,
  otherParticipantId,
  viewerIsAdmin,
} from "@/lib/conversation";
import { initialsOf } from "@/lib/profiles";

/**
 * Title bar for the open conversation: who it is, and everything you can do to
 * the conversation itself.
 *
 * Per-message actions live in the row's menu; this is the conversation-level set
 * (rename, channel settings, membership, mute, leave, report, block).
 */
export function ConversationHeader({
  conversation,
  onOpenConversations,
}: {
  conversation: ClientConversation;
  onOpenConversations: () => void;
}) {
  const {
    client,
    viewer,
    directory,
    mutedConversationIds,
    toggleMute,
    blockedUserIds,
    toggleBlock,
    select,
  } = useChat();
  const presence = client.usePresence();
  const [membersOpen, setMembersOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);

  const kind = conversationKind(conversation);
  const title = conversationTitle(conversation, viewer.id, directory.nameOf);
  const otherId = otherParticipantId(conversation, viewer.id);
  const online = otherId === null ? false : (presence[otherId]?.online ?? false);
  const isAdmin = viewerIsAdmin(conversation, viewer.id);
  const muted = mutedConversationIds.has(conversation.id);
  const blocked = otherId !== null && blockedUserIds.has(otherId);

  async function update(input: {
    name?: string | null;
    visibility?: ChannelVisibility;
    joinPolicy?: ChannelJoinPolicy;
  }): Promise<void> {
    const result = await client.conversations.update({
      conversationId: conversation.id,
      ...input,
    });
    if (result.error) toast.error(result.error.message);
  }

  async function leave(): Promise<void> {
    // Leaving is `removeParticipant` with your own id - core has no separate
    // route for it, and an admin leaving must hand the role over first
    // (`docs/decisions/0017`).
    const result = await client.conversations.removeParticipant({
      conversationId: conversation.id,
      userId: viewer.id,
    });
    if (result.error) {
      toast.error(result.error.message);
      return;
    }
    select(null);
  }

  const subtitle =
    kind === "direct"
      ? online
        ? "online"
        : "offline"
      : `${conversation.participants.length} members${
          conversation.visibility === "public"
            ? conversation.joinPolicy === "open"
              ? " · anyone can join"
              : " · joining needs approval"
            : ""
        }`;

  return (
    <div className="flex items-center gap-3 border-b p-3">
      <Button
        size="icon"
        variant="ghost"
        className="md:hidden"
        onClick={onOpenConversations}
        aria-label="Show conversations"
      >
        <Menu />
      </Button>

      <Avatar>
        <AvatarImage
          src={otherId === null ? undefined : (directory.profiles[otherId]?.image ?? undefined)}
        />
        <AvatarFallback>
          {kind === "direct" ? initialsOf(title) : <Hash className="size-4" />}
        </AvatarFallback>
        {online && <AvatarBadge className="bg-emerald-500" aria-label="Online" />}
      </Avatar>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p className="truncate font-semibold">{title}</p>
          {kind !== "direct" && <Badge variant="muted">{kind}</Badge>}
          {blocked && <Badge variant="destructive">blocked</Badge>}
        </div>
        <p className="truncate text-xs text-muted-foreground">{subtitle}</p>
      </div>

      {kind !== "direct" && (
        <Button
          size="icon"
          variant="outline"
          onClick={() => setMembersOpen(true)}
          aria-label="People, invites and join requests"
        >
          <Users />
        </Button>
      )}

      {/* Muting is viewer-relative and stored: it suppresses this conversation's
          notifications for you, and changes nothing for anyone else
          (`docs/decisions/0021`). */}
      <Button
        size="icon"
        variant="outline"
        onClick={() => void toggleMute(conversation.id)}
        aria-label={muted ? "Unmute conversation" : "Mute conversation"}
      >
        {muted ? <BellOff /> : <Bell />}
      </Button>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="icon" variant="ghost" aria-label="Conversation options">
            <MoreVertical />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          {kind !== "direct" && isAdmin && (
            <>
              <DropdownMenuItem onSelect={() => setRenameOpen(true)}>
                <Pencil />
                Rename
              </DropdownMenuItem>
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>Visibility</DropdownMenuSubTrigger>
                <DropdownMenuSubContent>
                  <DropdownMenuRadioGroup
                    value={conversation.visibility}
                    onValueChange={(value) =>
                      void update({ visibility: value as ChannelVisibility })
                    }
                  >
                    <DropdownMenuRadioItem value="private">Private group</DropdownMenuRadioItem>
                    {/* A channel is not a third conversation type - it is this
                        group with `visibility: "public"` (`docs/decisions/0020`). */}
                    <DropdownMenuRadioItem value="public">Public channel</DropdownMenuRadioItem>
                  </DropdownMenuRadioGroup>
                </DropdownMenuSubContent>
              </DropdownMenuSub>
              {conversation.visibility === "public" && (
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger>Joining</DropdownMenuSubTrigger>
                  <DropdownMenuSubContent>
                    <DropdownMenuRadioGroup
                      value={conversation.joinPolicy}
                      onValueChange={(value) =>
                        void update({ joinPolicy: value as ChannelJoinPolicy })
                      }
                    >
                      <DropdownMenuRadioItem value="approval">Needs approval</DropdownMenuRadioItem>
                      <DropdownMenuRadioItem value="open">Anyone can join</DropdownMenuRadioItem>
                    </DropdownMenuRadioGroup>
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
              )}
              <DropdownMenuSeparator />
            </>
          )}

          <DropdownMenuItem onSelect={() => setReportOpen(true)}>
            <TriangleAlert />
            Report conversation
          </DropdownMenuItem>

          {otherId !== null && (
            <DropdownMenuItem onSelect={() => void toggleBlock(otherId)}>
              <Ban />
              {blocked ? "Unblock" : "Block"} this person
            </DropdownMenuItem>
          )}

          {kind !== "direct" && (
            <DropdownMenuItem variant="destructive" onSelect={() => void leave()}>
              <LogOut />
              Leave
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      {membersOpen && (
        <MembersPanel conversation={conversation} onClose={() => setMembersOpen(false)} />
      )}

      {renameOpen && (
        <RenameDialog
          initialName={conversation.name ?? ""}
          onClose={() => setRenameOpen(false)}
          onSubmit={update}
        />
      )}

      <ReportDialog
        open={reportOpen}
        onOpenChange={setReportOpen}
        targetType="conversation"
        targetId={conversation.id}
        description="Reports go to your moderators, who see the conversation id and your reason."
      />
    </div>
  );
}

function RenameDialog({
  initialName,
  onClose,
  onSubmit,
}: {
  initialName: string;
  onClose: () => void;
  onSubmit: (input: { name: string | null }) => Promise<void>;
}) {
  const [name, setName] = useState(initialName);

  async function save(): Promise<void> {
    const trimmed = name.trim();
    // `null` clears the title rather than setting an empty one - a group with no
    // name falls back to its member list in the UI.
    await onSubmit({ name: trimmed.length === 0 ? null : trimmed });
    onClose();
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Rename</DialogTitle>
          <DialogDescription>
            Leave it empty to clear the name and fall back to the member list.
          </DialogDescription>
        </DialogHeader>
        <Input
          value={name}
          onChange={(event) => setName(event.target.value)}
          maxLength={MAX_CONVERSATION_NAME_LENGTH}
          aria-label="Conversation name"
          autoFocus
        />
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => void save()}>Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
