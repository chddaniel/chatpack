import type { ReactNode } from "react";
import { useChatpackUI } from "./context";
import { EmptyState, PresenceDot, Timestamp, UnreadBadge } from "./primitives";
import type { ReceiptState } from "@chatpack/client/plugins";

/** Displays the current typing indicator for a conversation. */
export function TypingIndicator({ conversationId }: { conversationId: string }) {
  const { client, userId, renderUser } = useChatpackUI();
  const typing = client.useTyping({ conversationId });
  if (typing === null || typing.senderId === userId) return null;
  return (
    <p role="status" aria-live="polite">
      {renderUser(typing.senderId)} is typing…
    </p>
  );
}

/** Displays presence for one opaque user id. */
export function PresenceIndicator({ userId }: { userId: string }) {
  const { client, renderUser } = useChatpackUI();
  const presence = client.usePresence({ userIds: [userId] })[userId];
  return (
    <span className="chatpack-ui-presence-indicator">
      <PresenceDot online={presence?.online ?? false} /> {renderUser(userId)}
    </span>
  );
}

/** Displays delivery and read state for the newest message in a conversation. */
export function ReadReceipts({
  conversationId,
  messageSeq,
  messageId,
}: {
  conversationId: string;
  messageSeq: number;
  messageId?: string;
}) {
  const { client } = useChatpackUI();
  const receipts = client.useReceipts({ conversationId }) as ReceiptState | null;
  const read = messageId !== undefined && receipts?.readMessageId === messageId;
  const delivered = (receipts?.deliveredSeq ?? 0) >= messageSeq;
  return (
    <span aria-label={read ? "Read" : delivered ? "Delivered" : "Sent"}>
      {read ? "✓✓" : delivered ? "✓✓" : "✓"}
    </span>
  );
}

/** Displays an unread count for a conversation. */
export function UnreadInbox({
  conversationId,
  onSelect,
}: {
  conversationId: string;
  onSelect?: () => void;
}) {
  const { client } = useChatpackUI();
  const conversations = client.useConversations();
  const conversation = conversations.data?.conversations.find((item) => item.id === conversationId);
  if (conversation === undefined) return null;
  return (
    <button
      type="button"
      className="chatpack-ui-button chatpack-ui-button-ghost"
      onClick={onSelect}
    >
      <UnreadBadge count={conversation.unreadCount} />
    </button>
  );
}

/** Displays the last-seen timestamp for a user when available. */
export function OnlineStatusChip({ userId }: { userId: string }) {
  const { client, renderUser } = useChatpackUI();
  const presence = client.usePresence({ userIds: [userId] })[userId];
  if (presence?.online === true) return <span>{renderUser(userId)} · Online</span>;
  return (
    <span>
      {renderUser(userId)} ·{" "}
      {presence?.lastSeenAt === null || presence === undefined ? (
        "Offline"
      ) : (
        <>
          <span>Last seen </span>
          <Timestamp date={presence.lastSeenAt} />
        </>
      )}
    </span>
  );
}

/** Displays a list of user ids with their current presence state. */
export function PresenceAvatarStack({
  userIds,
  renderFallback,
}: {
  userIds: readonly string[];
  renderFallback?: (userId: string) => ReactNode;
}) {
  const { client, renderUser } = useChatpackUI();
  const presence = client.usePresence({ userIds });
  if (userIds.length === 0) return <EmptyState>No participants</EmptyState>;
  return (
    <div className="chatpack-ui-presence-stack" aria-label="Participants">
      {userIds.map((userId) => (
        <span className="chatpack-ui-avatar-stack-item" key={userId}>
          <span className="chatpack-ui-avatar" aria-hidden="true">
            {userId.slice(0, 2).toUpperCase()}
          </span>
          <PresenceDot online={presence[userId]?.online ?? false} />
          <span className="chatpack-ui-presence-name">
            {renderFallback?.(userId) ?? renderUser(userId)}
          </span>
        </span>
      ))}
    </div>
  );
}
