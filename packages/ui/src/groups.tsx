import type { ClientConversation } from "@chatpack/client";
import { useChatpackUI } from "./context";
import { EmptyState, ErrorNotice, LoadingState, PresenceDot, UnreadBadge } from "./primitives";

/** Lists group participants and their roles. */
export function MembersList({ conversation }: { conversation: ClientConversation }) {
  const { client, renderUser } = useChatpackUI();
  const presence = client.usePresence({
    userIds: conversation.participants.map((participant) => participant.userId),
  });
  if (conversation.participants.length === 0) return <EmptyState>No members</EmptyState>;
  return (
    <ul className="chatpack-ui-members-list">
      {conversation.participants.map((participant) => (
        <li key={participant.userId}>
          <PresenceDot online={presence[participant.userId]?.online ?? false} />{" "}
          {renderUser(participant.userId)} <small>{participant.role}</small>
        </li>
      ))}
    </ul>
  );
}

/** Lists groups from the viewer's conversation page. */
export function GroupList({ onSelect }: { onSelect?: (conversation: ClientConversation) => void }) {
  const { client } = useChatpackUI();
  const conversations = client.useConversations();
  if (conversations.error !== null)
    return <ErrorNotice error={conversations.error} onRetry={() => void conversations.refetch()} />;
  if (conversations.isPending && conversations.data === null)
    return <LoadingState label="Loading groups" />;
  const groups =
    conversations.data?.conversations.filter((conversation) => conversation.type === "group") ?? [];
  if (groups.length === 0) return <EmptyState>No groups yet</EmptyState>;
  return (
    <nav aria-label="Groups">
      {groups.map((conversation) => (
        <button type="button" key={conversation.id} onClick={() => onSelect?.(conversation)}>
          {conversation.name ?? conversation.id}
          <UnreadBadge count={conversation.unreadCount} />
        </button>
      ))}
    </nav>
  );
}
