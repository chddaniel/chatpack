"use client";

import { useState, type ReactNode } from "react";
import type { ClientConversation, ClientMessage } from "@chatpack/client";
import {
  Check,
  CheckCheck,
  CornerUpLeft,
  Forward,
  MoreHorizontal,
  Pencil,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import { toast } from "sonner";

import { useChat } from "@/components/chat/chat-context";
import { ForwardDialog } from "@/components/chat/forward-dialog";
import { MessageAttachments, readAttachments } from "@/components/chat/message-attachments";
import { ReportDialog } from "@/components/chat/report-dialog";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Textarea } from "@/components/ui/textarea";
import { initialsOf } from "@/lib/profiles";

/** The emoji offered in the message menu. Core accepts any string up to 32 characters. */
const QUICK_REACTIONS = ["👍", "❤️", "😂", "🎉", "👀"];

export function MessageRow({
  message,
  conversation,
  onReply,
  readByOthers,
  delivered,
}: {
  message: ClientMessage;
  conversation: ClientConversation | null;
  onReply: (message: ClientMessage) => void;
  /** Whether anyone else has read up to this message (own messages only). */
  readByOthers: boolean;
  /** Whether a recipient's live stream has received it (own messages only). */
  delivered: boolean;
}) {
  const { client, viewer, directory } = useChat();
  const [draft, setDraft] = useState<string | null>(null);
  const [forwarding, setForwarding] = useState(false);
  const [reporting, setReporting] = useState(false);

  const isOwn = message.senderId === viewer.id;
  const isDeleted = message.deletedAt !== null;
  const attachments = readAttachments(message.metadata);
  const senderName = isOwn ? "You" : directory.nameOf(message.senderId);
  const senderImage = directory.profiles[message.senderId]?.image ?? undefined;
  const mentionsViewer = message.mentions.includes(viewer.id);
  // Core stores mentions as ids and never touches `body` (`docs/decisions/0022`),
  // so highlighting means matching the `@Name` the composer wrote for each id.
  const mentionNames = message.mentions.map((userId) => directory.nameOf(userId));

  async function toggleReaction(emoji: string): Promise<void> {
    const summary = message.reactions.find((reaction) => reaction.emoji === emoji);
    const reacted = summary?.userIds.includes(viewer.id) ?? false;
    const result = reacted
      ? await client.messages.unreact({ messageId: message.id, emoji })
      : await client.messages.react({ messageId: message.id, emoji });
    if (result.error) toast.error(result.error.message);
  }

  async function saveEdit(): Promise<void> {
    const body = (draft ?? "").trim();
    if (body.length === 0) return;
    // No `mentions` key: omitting it keeps the stored mention set, so fixing a
    // typo never silently un-mentions anyone (`docs/decisions/0023`).
    const result = await client.messages.edit({ messageId: message.id, body });
    if (result.error) {
      toast.error(result.error.message);
      return;
    }
    setDraft(null);
  }

  async function remove(): Promise<void> {
    // A soft delete: the message stays in history with an empty body so every
    // client can render a tombstone instead of a hole in the sequence.
    const result = await client.messages.delete({ messageId: message.id });
    if (result.error) toast.error(result.error.message);
  }

  return (
    <div
      className={`group flex w-full items-end gap-2 ${isOwn ? "justify-end" : "justify-start"}`}
      data-message-sender={isOwn ? "self" : "other"}
    >
      {!isOwn && (
        <Avatar className="size-8">
          <AvatarImage src={senderImage} />
          <AvatarFallback>{initialsOf(senderName)}</AvatarFallback>
        </Avatar>
      )}

      {isOwn && !isDeleted && (
        <MessageMenu
          message={message}
          isOwn={isOwn}
          onReact={toggleReaction}
          onReply={() => onReply(message)}
          onEdit={() => setDraft(message.body)}
          onDelete={remove}
          onForward={() => setForwarding(true)}
          onReport={() => setReporting(true)}
        />
      )}

      <div
        className={`max-w-[80%] min-w-0 rounded-2xl px-4 py-2 text-sm ${
          isOwn ? "bg-primary text-primary-foreground" : "bg-muted text-foreground"
        } ${mentionsViewer ? "ring-2 ring-amber-400/70" : ""}`}
      >
        <div className="mb-1 flex items-center gap-2 text-[10px] opacity-70">
          <span className="font-medium">{senderName}</span>
          <time dateTime={message.createdAt}>
            {new Date(message.createdAt).toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit",
            })}
          </time>
          {message.editedAt !== null && !isDeleted && <span>edited</span>}
          {/* ✓✓ read, ✓ delivered to a live stream, faint ✓ stored but nobody
              has it yet. The first two are ephemeral signals: they go quiet
              while the client is polling (`docs/decisions/0008`). */}
          {isOwn &&
            !isDeleted &&
            (readByOthers ? (
              <CheckCheck className="size-3" aria-label="Read" />
            ) : (
              <Check className={`size-3 ${delivered ? "" : "opacity-40"}`} aria-label="Sent" />
            ))}
        </div>

        {message.forwardedFrom !== null && (
          <p className="mb-1 flex items-center gap-1 text-[11px] opacity-70">
            <Forward className="size-3" />
            {/* Provenance is frozen at forward time: three ids and no excerpt, so
                a forward can never leak the source conversation's live content
                (`docs/decisions/0024`). */}
            Forwarded from {directory.nameOf(message.forwardedFrom.senderId)}
          </p>
        )}

        {message.replyTo !== null && (
          <div className="mb-1 border-l-2 border-current/40 pl-2 text-xs opacity-80">
            <span className="font-medium">{directory.nameOf(message.replyTo.senderId)}</span>
            <p className="truncate">
              {message.replyTo.deleted ? "Message deleted" : message.replyTo.excerpt}
            </p>
          </div>
        )}

        {isDeleted ? (
          <p className="italic opacity-70">Message deleted</p>
        ) : draft === null ? (
          <p className="break-words whitespace-pre-wrap">
            <MessageBody body={message.body} mentionNames={mentionNames} />
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            <Textarea
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              rows={3}
              className="bg-background text-foreground"
              aria-label="Edit message"
            />
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="ghost" onClick={() => setDraft(null)}>
                Cancel
              </Button>
              <Button size="sm" variant="secondary" onClick={() => void saveEdit()}>
                Save
              </Button>
            </div>
          </div>
        )}

        {!isDeleted && (
          <MessageAttachments conversationId={message.conversationId} attachments={attachments} />
        )}

        {message.reactions.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1">
            {message.reactions.map((reaction) => {
              const mine = reaction.userIds.includes(viewer.id);
              return (
                <button
                  key={reaction.emoji}
                  onClick={() => void toggleReaction(reaction.emoji)}
                  title={reaction.userIds.map((userId) => directory.nameOf(userId)).join(", ")}
                  className={`rounded-full border px-2 py-0.5 text-xs ${
                    mine ? "border-current" : "border-transparent bg-background/20"
                  }`}
                >
                  {reaction.emoji} {reaction.count}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {!isOwn && !isDeleted && (
        <MessageMenu
          message={message}
          isOwn={isOwn}
          onReact={toggleReaction}
          onReply={() => onReply(message)}
          onEdit={() => setDraft(message.body)}
          onDelete={remove}
          onForward={() => setForwarding(true)}
          onReport={() => setReporting(true)}
        />
      )}

      {isOwn && (
        <Avatar className="size-8">
          <AvatarImage src={viewer.image ?? undefined} />
          <AvatarFallback>{initialsOf(viewer.name)}</AvatarFallback>
        </Avatar>
      )}

      {forwarding && (
        <ForwardDialog
          message={message}
          fromConversation={conversation}
          onClose={() => setForwarding(false)}
        />
      )}
      {reporting && (
        <ReportDialog
          open
          onOpenChange={setReporting}
          targetType="message"
          targetId={message.id}
          description="A moderator sees the message as it is now, frozen with the report - editing or deleting it afterwards does not change what they read."
        />
      )}
    </div>
  );
}

function MessageMenu({
  message,
  isOwn,
  onReact,
  onReply,
  onEdit,
  onDelete,
  onForward,
  onReport,
}: {
  message: ClientMessage;
  isOwn: boolean;
  onReact: (emoji: string) => Promise<void>;
  onReply: () => void;
  onEdit: () => void;
  onDelete: () => Promise<void>;
  onForward: () => void;
  onReport: () => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          size="icon-sm"
          variant="ghost"
          className="opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100"
          aria-label="Message actions"
        >
          <MoreHorizontal />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align={isOwn ? "end" : "start"} className="w-48">
        <DropdownMenuLabel className="pb-1">React</DropdownMenuLabel>
        <div className="flex gap-1 px-2 pb-1">
          {QUICK_REACTIONS.map((emoji) => (
            <button
              key={emoji}
              onClick={() => void onReact(emoji)}
              className="rounded px-1 py-0.5 text-base hover:bg-accent"
              aria-label={`React with ${emoji}`}
            >
              {emoji}
            </button>
          ))}
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onReply}>
          <CornerUpLeft />
          Reply
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onForward}>
          <Forward />
          Forward
        </DropdownMenuItem>
        {isOwn ? (
          <>
            <DropdownMenuItem onSelect={onEdit}>
              <Pencil />
              Edit
            </DropdownMenuItem>
            <DropdownMenuItem variant="destructive" onSelect={() => void onDelete()}>
              <Trash2 />
              Delete
            </DropdownMenuItem>
          </>
        ) : (
          <DropdownMenuItem onSelect={onReport}>
            <TriangleAlert />
            Report
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-[10px] font-normal opacity-60">
          seq {message.seq}
        </DropdownMenuLabel>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Highlights the `@Name` tokens that correspond to this message's mentions.
 *
 * Chatpack never parses the body, so the ids and the text are two independent
 * facts and this match can legitimately come up empty - a name that changed
 * since the message was sent still mentions the same person, it just no longer
 * highlights. That is the tradeoff of an opaque body (`docs/decisions/0022`).
 */
function MessageBody({ body, mentionNames }: { body: string; mentionNames: readonly string[] }) {
  if (mentionNames.length === 0) return <>{body}</>;
  // Longest first, so "Ada Lovelace" wins over a colleague simply called "Ada".
  const names = [...new Set(mentionNames)]
    .filter((name) => name.length > 0)
    .sort((left, right) => right.length - left.length)
    .map(escapeRegExp);
  const pattern = new RegExp(`@(?:${names.join("|")})`, "gu");
  const parts: ReactNode[] = [];
  let cursor = 0;
  for (const match of body.matchAll(pattern)) {
    if (match.index > cursor) parts.push(body.slice(cursor, match.index));
    parts.push(
      <mark key={match.index} className="rounded bg-foreground/15 px-0.5 text-inherit">
        {match[0]}
      </mark>,
    );
    cursor = match.index + match[0].length;
  }
  parts.push(body.slice(cursor));
  return <>{parts}</>;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
