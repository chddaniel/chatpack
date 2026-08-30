import { useState, type ComponentProps, type ReactNode } from "react";
import type { ClientConversation, ClientMessage } from "@chatpack/client";
import { useChatpackUI } from "./context";
import { ChatWindow, ConversationList, MessageComposer, MessageThread } from "./blocks";
import {
  EmptyState,
  MessageBubble,
  ReactionPill,
  ReplyQuoteBar,
  Timestamp,
  UnreadBadge,
} from "./primitives";
import { QuickReactions } from "./inputs";
import { PresenceAvatarStack, TypingIndicator } from "./realtime";

/** Displays a conversation heading without assuming a profile schema. */
export function ConversationHeader({
  conversation,
  children,
}: {
  conversation: ClientConversation;
  children?: ReactNode;
}) {
  return (
    <header>
      <h2>{conversation.name ?? conversation.id}</h2>
      {children}
    </header>
  );
}

/** Displays a compact conversation list for narrow navigation rails. */
export function CompactChatList(props: ComponentProps<typeof ConversationList>) {
  return <ConversationList {...props} className="chatpack-ui-compact-list" />;
}

/** Displays one conversation row for a caller-owned conversation page. */
export function ConversationRow({
  conversation,
  selected,
  onSelect,
}: {
  conversation: ClientConversation;
  selected?: boolean;
  onSelect?: () => void;
}) {
  const { userId, renderUser } = useChatpackUI();
  const other = conversation.participants.find(
    (participant) => participant.userId !== userId,
  )?.userId;
  return (
    <button type="button" aria-current={selected ? "page" : undefined} onClick={onSelect}>
      {conversation.type === "group"
        ? (conversation.name ?? conversation.id)
        : other === undefined
          ? conversation.id
          : renderUser(other)}
      <UnreadBadge count={conversation.unreadCount} />
    </button>
  );
}

/** Displays one message row with reply, timestamp, and optional actions. */
export function MessageRow({
  message,
  onReply,
  children,
}: {
  message: ClientMessage;
  onReply?: () => void;
  children?: ReactNode;
}) {
  const { userId, renderUser } = useChatpackUI();
  return (
    <div>
      <ReplyQuoteBar replyTo={message.replyTo} />
      <MessageBubble message={message} own={message.senderId === userId} renderUser={renderUser} />
      {children}
      <Timestamp date={message.createdAt} />
      {onReply !== undefined && (
        <button type="button" onClick={onReply}>
          Reply
        </button>
      )}
    </div>
  );
}

/** Displays a message thread with flat row styling. */
export function FlatMessageThread(props: ComponentProps<typeof MessageThread>) {
  return <MessageThread {...props} className="chatpack-ui-flat-thread" />;
}

/** Displays a message thread grouped by the same API-backed message history. */
export function GroupedMessageThread(props: ComponentProps<typeof MessageThread>) {
  return <MessageThread {...props} className="chatpack-ui-grouped-thread" />;
}

/** Provides a sidebar and chat pane for an inbox-style layout. */
export function InboxLayout({
  conversationId,
  onSelect,
  children,
}: {
  conversationId: string;
  onSelect?: (conversation: ClientConversation) => void;
  children?: ReactNode;
}) {
  return (
    <div className="chatpack-ui-inbox-layout">
      <aside>
        <ConversationList {...(onSelect === undefined ? {} : { onSelect })} />
      </aside>
      <section>{children ?? <ChatWindow conversationId={conversationId} />}</section>
    </div>
  );
}

/** Provides a mobile-friendly chat sheet using native dialog semantics. */
export function MobileChatSheet({
  open,
  onClose,
  conversationId,
}: {
  open: boolean;
  onClose: () => void;
  conversationId: string;
}) {
  if (!open) return null;
  return (
    <dialog open>
      <button type="button" onClick={onClose}>
        Close
      </button>
      <ChatWindow conversationId={conversationId} />
    </dialog>
  );
}

/** Displays a floating chat window anchored to the caller's page. */
export function FloatingChatWidget({
  conversationId,
  label = "Open chat",
}: {
  conversationId: string;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="chatpack-ui-floating-widget">
      {open && <ChatWindow conversationId={conversationId} />}
      <button type="button" onClick={() => setOpen((value) => !value)}>
        {open ? "Close chat" : label}
      </button>
    </div>
  );
}

/** Displays a thread intended for assistant-role messages. */
export function AssistantThread(props: ComponentProps<typeof MessageThread>) {
  return <MessageThread {...props} className="chatpack-ui-assistant-thread" />;
}

/** Scrolls a caller-owned message viewport to its latest content. */
export function JumpToLatest({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" onClick={onClick}>
      Jump to latest
    </button>
  );
}

/** Composer specialized for replying to a selected message. */
export function ReplyComposer(props: ComponentProps<typeof MessageComposer>) {
  return <MessageComposer {...props} />;
}

/** Composer hook-up point for host-owned mention selection. */
export function MentionComposer({
  children,
  ...props
}: ComponentProps<typeof MessageComposer> & { children?: ReactNode }) {
  return (
    <>
      <MessageComposer {...props} />
      {children}
    </>
  );
}

/** Displays host-provided mention candidates. */
export function MentionAutocomplete({
  items,
  onSelect,
}: {
  items: readonly string[];
  onSelect: (userId: string) => void;
}) {
  return (
    <ul role="listbox">
      {items.map((item) => (
        <li key={item}>
          <button type="button" onClick={() => onSelect(item)}>
            {item}
          </button>
        </li>
      ))}
    </ul>
  );
}

/** Forwards a readable message to a host-selected conversation. */
export function ForwardDialog({
  messageId,
  toConversationId,
  onForward,
}: {
  messageId: string;
  toConversationId: string;
  onForward?: () => void;
}) {
  const { client } = useChatpackUI();
  return (
    <button
      type="button"
      onClick={async () => {
        const result = await client.messages.forward({ messageId, toConversationId });
        if (result.error === null) onForward?.();
      }}
    >
      Forward
    </button>
  );
}

/** Composes a message thread and message composer. */
export function ChatComposerBar({
  conversationId,
  replyTo,
}: ComponentProps<typeof MessageComposer>) {
  return (
    <MessageComposer
      conversationId={conversationId}
      {...(replyTo === undefined ? {} : { replyTo })}
    />
  );
}

/** Displays search results supplied by the Chatpack search hook. */
export function MessageSearchResults({
  messages,
  onSelect,
}: {
  messages: readonly ClientMessage[];
  onSelect?: (messageId: string) => void;
}) {
  const { userId, renderUser } = useChatpackUI();
  return (
    <div>
      {messages.map((message) => (
        <button type="button" key={message.id} onClick={() => onSelect?.(message.id)}>
          <MessageBubble
            message={message}
            own={message.senderId === userId}
            renderUser={renderUser}
          />
        </button>
      ))}
    </div>
  );
}

/** Provides a keyboard-accessible command list for host-owned actions. */
export function ChatCommandPalette({
  commands,
}: {
  commands: readonly { id: string; label: string; onSelect: () => void }[];
}) {
  return (
    <ul role="menu">
      {commands.map((command) => (
        <li key={command.id}>
          <button type="button" role="menuitem" onClick={command.onSelect}>
            {command.label}
          </button>
        </li>
      ))}
    </ul>
  );
}

/** Starts a direct conversation with a host-selected user. */
export function StartDirectMessage({
  otherUserId,
  onCreated,
}: {
  otherUserId: string;
  onCreated?: (conversation: ClientConversation) => void;
}) {
  const { client } = useChatpackUI();
  return (
    <button
      type="button"
      onClick={async () => {
        const result = await client.conversations.create({ otherUserId });
        if (result.data !== null) onCreated?.(result.data);
      }}
    >
      Message {otherUserId}
    </button>
  );
}

/** Creates a group using the public client action. */
export function NewGroupForm({
  onCreated,
}: {
  onCreated?: (conversation: ClientConversation) => void;
}) {
  const { client } = useChatpackUI();
  const [name, setName] = useState("");
  return (
    <form
      onSubmit={async (event) => {
        event.preventDefault();
        const result = await client.conversations.createGroup({ name });
        if (result.data !== null) onCreated?.(result.data);
      }}
    >
      <input
        aria-label="Group name"
        value={name}
        onChange={(event) => setName(event.target.value)}
      />
      <button type="submit">Create group</button>
    </form>
  );
}

/** Displays reactions from a message and lets the viewer toggle them. */
export function MessageReactions({ message }: { message: ClientMessage }) {
  const { client, userId } = useChatpackUI();
  const [pickerOpen, setPickerOpen] = useState(false);
  return (
    <div>
      {message.reactions.map((reaction) => (
        <ReactionPill
          key={reaction.emoji}
          reaction={reaction}
          pressed={reaction.userIds.includes(userId)}
          onClick={() =>
            void (reaction.userIds.includes(userId)
              ? client.messages.unreact({ messageId: message.id, emoji: reaction.emoji })
              : client.messages.react({ messageId: message.id, emoji: reaction.emoji }))
          }
        />
      ))}
      <button
        type="button"
        className="chatpack-ui-add-reaction"
        aria-label="Add reaction"
        onClick={() => setPickerOpen((open) => !open)}
      >
        +
      </button>
      {pickerOpen && <QuickReactions messageId={message.id} />}
    </div>
  );
}

/** Marks a conversation read through the public client action. */
export function MarkReadButton({
  conversationId,
  messageId,
}: {
  conversationId: string;
  messageId: string;
}) {
  const { client } = useChatpackUI();
  return (
    <button
      type="button"
      onClick={() => void client.conversations.markRead({ conversationId, messageId })}
    >
      Mark read
    </button>
  );
}

/** Displays typing dots without exposing the sender implementation. */
export function TypingDots({ conversationId }: { conversationId: string }) {
  return <TypingIndicator conversationId={conversationId} />;
}

/** Displays presence for all supplied users. */
export function PresenceBar({ userIds }: { userIds: readonly string[] }) {
  return <PresenceAvatarStack userIds={userIds} />;
}

/** Adds or removes a group participant through caller-provided action. */
export function ParticipantManager({
  onAdd,
  onRemove,
}: {
  onAdd?: () => void;
  onRemove?: () => void;
}) {
  return (
    <div>
      <button type="button" onClick={onAdd}>
        Add participant
      </button>
      <button type="button" onClick={onRemove}>
        Remove participant
      </button>
    </div>
  );
}

/** Displays invite controls through caller-provided actions. */
export function InviteManager({
  onCreate,
  onRevoke,
}: {
  onCreate?: () => void;
  onRevoke?: () => void;
}) {
  return (
    <div>
      <button type="button" onClick={onCreate}>
        Create invite
      </button>
      <button type="button" onClick={onRevoke}>
        Revoke invite
      </button>
    </div>
  );
}

/** Accepts an invite with the public client action. */
export function InviteAccept({ code, onAccepted }: { code: string; onAccepted?: () => void }) {
  const { client } = useChatpackUI();
  return (
    <button
      type="button"
      onClick={async () => {
        const result = await client.invites.accept({ code });
        if (result.error === null) onAccepted?.();
      }}
    >
      Accept invite
    </button>
  );
}

/** Displays join-request controls through caller-provided actions. */
export function JoinRequests({ onResolve }: { onResolve?: () => void }) {
  return (
    <button type="button" onClick={onResolve}>
      Resolve request
    </button>
  );
}

/** Lists public channels from the caller-provided client page. */
export function ChannelDirectory({
  channels,
  onJoin,
}: {
  channels: readonly { id: string; name: string | null }[];
  onJoin?: (id: string) => void;
}) {
  return (
    <ul>
      {channels.map((channel) => (
        <li key={channel.id}>
          {channel.name ?? channel.id}
          <button type="button" onClick={() => onJoin?.(channel.id)}>
            Join
          </button>
        </li>
      ))}
    </ul>
  );
}

/** Displays caller-owned channel settings controls. */
export function ChannelSettings({ onSave }: { onSave?: () => void }) {
  return (
    <button type="button" onClick={onSave}>
      Save channel settings
    </button>
  );
}

/** Leaves a group through the public client action. */
export function LeaveGroup({
  conversationId,
  onLeft,
}: {
  conversationId: string;
  onLeft?: () => void;
}) {
  const { client, userId } = useChatpackUI();
  return (
    <button
      type="button"
      onClick={async () => {
        const result = await client.conversations.removeParticipant({ conversationId, userId });
        if (result.error === null) onLeft?.();
      }}
    >
      Leave group
    </button>
  );
}

/** Lists users blocked by the viewer using caller-provided records. */
export function BlockedUsers({
  userIds,
  onUnblock,
}: {
  userIds: readonly string[];
  onUnblock?: (userId: string) => void;
}) {
  const { renderUser } = useChatpackUI();
  return (
    <ul>
      {userIds.map((userId) => (
        <li key={userId}>
          {renderUser(userId)}
          <button type="button" onClick={() => onUnblock?.(userId)}>
            Unblock
          </button>
        </li>
      ))}
    </ul>
  );
}

/** Toggles a conversation mute through caller-provided actions. */
export function MuteToggle({ muted, onToggle }: { muted: boolean; onToggle: () => void }) {
  return (
    <button type="button" aria-pressed={muted} onClick={onToggle}>
      {muted ? "Unmute" : "Mute"}
    </button>
  );
}

/** Lists muted conversations. */
export function MutedList({
  conversationIds,
  onSelect,
}: {
  conversationIds: readonly string[];
  onSelect?: (id: string) => void;
}) {
  return (
    <ul>
      {conversationIds.map((id) => (
        <li key={id}>
          <button type="button" onClick={() => onSelect?.(id)}>
            {id}
          </button>
        </li>
      ))}
    </ul>
  );
}

/** Presents a moderation report form through a host-owned submit action. */
export function ReportDialog({ onSubmit }: { onSubmit?: (reason: string) => void }) {
  const [reason, setReason] = useState("");
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit?.(reason);
      }}
    >
      <textarea
        aria-label="Report reason"
        value={reason}
        onChange={(event) => setReason(event.target.value)}
      />
      <button type="submit">Report</button>
    </form>
  );
}

/** Displays moderation reports supplied by the host. */
export function ModerationQueue({
  reports,
  onSelect,
}: {
  reports: readonly { id: string; status: string }[];
  onSelect?: (id: string) => void;
}) {
  return (
    <ul>
      {reports.map((report) => (
        <li key={report.id}>
          <button type="button" onClick={() => onSelect?.(report.id)}>
            {report.id} · {report.status}
          </button>
        </li>
      ))}
    </ul>
  );
}

/** Displays ban-management controls through host-owned actions. */
export function BanManager({ onBan, onRevoke }: { onBan?: () => void; onRevoke?: () => void }) {
  return (
    <div>
      <button type="button" onClick={onBan}>
        Ban
      </button>
      <button type="button" onClick={onRevoke}>
        Revoke ban
      </button>
    </div>
  );
}

/** A generic attachment shape accepted by media blocks. */
export interface ChatAttachment {
  id: string;
  name: string;
  url?: string;
  mimeType?: string;
  size?: number;
}

/** Displays a file picker and passes selected files to the host. */
export function AttachmentComposer({ onFiles }: { onFiles: (files: readonly File[]) => void }) {
  return (
    <label className="chatpack-ui-attachment-composer">
      <span className="chatpack-ui-button chatpack-ui-button-ghost">Attach files</span>
      <input
        type="file"
        hidden
        multiple
        onChange={(event) => onFiles([...(event.target.files ?? [])])}
      />
    </label>
  );
}

/** Accepts dropped files and passes them to the host. */
export function AttachmentDropzone({
  onFiles,
  children = "Drop files here",
}: {
  onFiles: (files: readonly File[]) => void;
  children?: ReactNode;
}) {
  return (
    <label
      className="chatpack-ui-attachment-dropzone"
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        event.preventDefault();
        onFiles([...event.dataTransfer.files]);
      }}
    >
      {children}
      <input
        type="file"
        hidden
        multiple
        onChange={(event) => onFiles([...(event.target.files ?? [])])}
      />
    </label>
  );
}

/** Lists message attachments as accessible links. */
export function MessageAttachments({ attachments }: { attachments: readonly ChatAttachment[] }) {
  return (
    <ul>
      {attachments.map((attachment) => (
        <li key={attachment.id}>
          {attachment.url === undefined ? (
            <UnavailableAttachment />
          ) : (
            <a href={attachment.url}>{attachment.name}</a>
          )}
        </li>
      ))}
    </ul>
  );
}

/** Displays an image attachment when its URL is available. */
export function ImageBubble({ attachment }: { attachment: ChatAttachment }) {
  return attachment.url === undefined ? (
    <UnavailableAttachment />
  ) : (
    <img src={attachment.url} alt={attachment.name} />
  );
}

/** Displays a downloadable file attachment. */
export function FileBubble({ attachment }: { attachment: ChatAttachment }) {
  return attachment.url === undefined ? (
    <UnavailableAttachment />
  ) : (
    <a href={attachment.url} download>
      {attachment.name}
    </a>
  );
}

/** Displays upload progress. */
export function UploadProgress({ value }: { value: number }) {
  return (
    <progress max={100} value={value}>
      {value}%
    </progress>
  );
}

/** Displays a responsive attachment collection. */
export function AttachmentGallery({ attachments }: { attachments: readonly ChatAttachment[] }) {
  return (
    <div>
      {attachments.map((attachment) => (
        <ImageBubble key={attachment.id} attachment={attachment} />
      ))}
    </div>
  );
}

/** Displays an attachment whose URL is unavailable. */
export function UnavailableAttachment() {
  return <span role="status">Attachment unavailable</span>;
}

/** Displays a user avatar fallback and unread count. */
export function UserAvatarUnreadBadge({ userId, unread = 0 }: { userId: string; unread?: number }) {
  return (
    <span className="chatpack-ui-avatar-with-badge" aria-label={userId}>
      <span className="chatpack-ui-avatar" aria-hidden="true">
        {userId.slice(0, 2).toUpperCase()}
      </span>
      <UnreadBadge count={unread} />
    </span>
  );
}

/** Displays an initials avatar at the requested gallery size. */
export function UserAvatar({ userId, size = "md" }: { userId: string; size?: "sm" | "md" | "lg" }) {
  return (
    <span className={`chatpack-ui-avatar chatpack-ui-avatar-${size}`} aria-label={userId}>
      {userId.slice(0, 2).toUpperCase()}
    </span>
  );
}

/** Displays common divider, empty, and loading primitives. */
export function ChatPrimitives({ children }: { children?: ReactNode }) {
  return <div>{children ?? <EmptyState />}</div>;
}

/** Displays read receipt ticks without a client dependency. */
export function ReadReceiptTicks({
  read = false,
  delivered = false,
}: {
  read?: boolean;
  delivered?: boolean;
}) {
  return (
    <span aria-label={read ? "Read" : delivered ? "Delivered" : "Sent"}>
      {read ? "✓✓" : delivered ? "✓✓" : "✓"}
    </span>
  );
}

/** Displays a forwarded-message label. */
export function ForwardedLabel() {
  return <small>Forwarded</small>;
}

/** Displays a mention chip for an opaque user id. */
export function MentionChip({ userId }: { userId: string }) {
  const { renderUser } = useChatpackUI();
  return <span>@{renderUser(userId)}</span>;
}

/** Displays a participant role. */
export function RoleTag({ role }: { role: string }) {
  return <small>{role}</small>;
}

/** Displays a system message. */
export function SystemMessage({ children }: { children: ReactNode }) {
  return <p role="status">{children}</p>;
}

/** Displays a deleted-message tombstone. */
export function SoftDeletedTombstone({ sender, at }: { sender?: ReactNode; at?: string }) {
  return (
    <span className="chatpack-ui-tombstone">
      <em>Message deleted</em>
      {sender !== undefined && <small>{sender}</small>}
      {at !== undefined && <Timestamp date={at} />}
    </span>
  );
}

/** Displays an empty conversation inbox. */
export function EmptyInbox() {
  return <EmptyState>No conversations yet</EmptyState>;
}

/** Presents a small fixed emoji set for reaction pickers. */
export function EmojiPicker({
  onSelect,
  emojis = ["👍", "❤️", "🎉", "😂", "😮", "😢"],
}: {
  onSelect: (emoji: string) => void;
  emojis?: readonly string[];
}) {
  return (
    <div role="listbox" aria-label="Emoji picker">
      {emojis.map((emoji) => (
        <button type="button" key={emoji} onClick={() => onSelect(emoji)}>
          {emoji}
        </button>
      ))}
    </div>
  );
}
