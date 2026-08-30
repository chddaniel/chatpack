import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import type { ClientConversation, ClientMessage } from "@chatpack/client";
import { useChatpackUI } from "./context";
import {
  EmptyState,
  ErrorNotice,
  LoadingState,
  MessageBubble,
  PresenceDot,
  ReactionPill,
  ReplyQuoteBar,
  Timestamp,
  UnreadBadge,
} from "./primitives";
import { cx } from "./utils";
import { TypingIndicator } from "./realtime";

/** Props for {@link ConversationList}. */
export interface ConversationListProps {
  /** Currently selected conversation. */
  selectedId?: string | null;
  /** Called when a conversation is selected. */
  onSelect?: (conversation: ClientConversation) => void;
  /** Optional class name. */
  className?: string;
}

/** Lists conversations with selection and viewer-relative unread counts. */
export function ConversationList({
  selectedId = null,
  onSelect,
  className,
}: ConversationListProps) {
  const { client, userId, renderUser } = useChatpackUI();
  const conversations = client.useConversations();
  const presence = client.usePresence();
  if (conversations.error !== null)
    return <ErrorNotice error={conversations.error} onRetry={() => void conversations.refetch()} />;
  if (conversations.isPending && conversations.data === null)
    return <LoadingState label="Loading conversations" />;
  const rows = conversations.data?.conversations ?? [];
  if (rows.length === 0) return <EmptyState>No conversations yet</EmptyState>;
  return (
    <section className={cx("chatpack-ui-conversation-list-shell", className)}>
      <header className="chatpack-ui-list-header">Conversations</header>
      <nav className="chatpack-ui-conversation-list" aria-label="Conversations">
        {rows.map((conversation) => {
          const other = conversation.participants.find(
            (participant) => participant.userId !== userId,
          )?.userId;
          const online = other === undefined ? false : (presence[other]?.online ?? false);
          return (
            <button
              type="button"
              key={conversation.id}
              aria-current={selectedId === conversation.id ? "page" : undefined}
              className="chatpack-ui-conversation-row chatpack-ui-focus"
              onClick={() => onSelect?.(conversation)}
            >
              <span className="chatpack-ui-avatar" aria-hidden="true">
                {(other ?? conversation.id).slice(0, 2).toUpperCase()}
              </span>
              <PresenceDot online={online} />
              <span>
                {conversation.type === "group"
                  ? (conversation.name ?? conversation.id)
                  : other === undefined
                    ? conversation.id
                    : renderUser(other)}
              </span>
              <UnreadBadge count={conversation.unreadCount} />
            </button>
          );
        })}
      </nav>
    </section>
  );
}

/** Props for {@link MessageThread}. */
export interface MessageThreadProps {
  /** Conversation whose messages should be shown. */
  conversationId: string;
  /** Called when a message is selected for reply. */
  onReply?: (message: ClientMessage) => void;
  /** Optional class name. */
  className?: string;
  /** Whether to render the standalone block header. */
  showHeader?: boolean;
}

/** Displays a live message history, gap-filled by the Chatpack client. */
export function MessageThread({
  conversationId,
  onReply,
  className,
  showHeader = true,
}: MessageThreadProps) {
  const { client, userId, renderUser } = useChatpackUI();
  const messages = client.useMessages({ conversationId, limit: 50 });
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const page = messages.data?.messages ?? [];
  const newest = page[0];
  useEffect(() => {
    if (newest !== undefined)
      void client.conversations.markRead({ conversationId, messageId: newest.id });
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [client, conversationId, newest]);
  if (messages.error !== null)
    return <ErrorNotice error={messages.error} onRetry={() => void messages.refetch()} />;
  if (messages.isPending && messages.data === null)
    return <LoadingState label="Loading messages" />;
  if (page.length === 0) return <EmptyState>No messages yet</EmptyState>;
  return (
    <section className={cx("chatpack-ui-message-thread-shell", className)}>
      {showHeader && <header className="chatpack-ui-list-header">Messages</header>}
      <div className="chatpack-ui-message-thread" aria-live="polite">
        {messages.data?.nextCursor !== null && (
          <button
            type="button"
            className="chatpack-ui-button chatpack-ui-button-ghost"
            onClick={() => void messages.loadMore()}
          >
            Load older messages
          </button>
        )}
        {[...page].reverse().map((message) => (
          <MessageThreadRow
            key={message.id}
            message={message}
            own={message.senderId === userId}
            renderUser={renderUser}
            {...(onReply === undefined ? {} : { onReply })}
          />
        ))}
        <div ref={bottomRef} />
      </div>
    </section>
  );
}

function MessageThreadRow({
  message,
  own,
  renderUser,
  onReply,
}: {
  message: ClientMessage;
  own: boolean;
  renderUser: (userId: string) => ReactNode;
  onReply?: (message: ClientMessage) => void;
}) {
  return (
    <div className="chatpack-ui-message-row">
      <ReplyQuoteBar replyTo={message.replyTo} />
      <MessageBubble
        message={message}
        own={own}
        renderUser={renderUser}
        footer={
          message.deletedAt === null ? (
            <div className="chatpack-ui-message-meta">
              <Timestamp date={message.createdAt} />
              {onReply !== undefined && (
                <button
                  type="button"
                  className="chatpack-ui-button chatpack-ui-button-ghost"
                  onClick={() => onReply(message)}
                >
                  Reply
                </button>
              )}
            </div>
          ) : undefined
        }
      />
      {message.forwardedFrom !== null && (
        <small className="chatpack-ui-forwarded">
          Forwarded from {renderUser(message.forwardedFrom.senderId)}
        </small>
      )}
      {message.reactions.length > 0 && <MessageRowReactions message={message} />}
    </div>
  );
}

function MessageRowReactions({ message }: { message: ClientMessage }) {
  const { client, userId } = useChatpackUI();
  return (
    <div className="chatpack-ui-reactions">
      {message.reactions.map((reaction) => {
        const mine = reaction.userIds.includes(userId);
        return (
          <ReactionPill
            key={reaction.emoji}
            reaction={reaction}
            pressed={mine}
            onClick={() =>
              void (mine
                ? client.messages.unreact({ messageId: message.id, emoji: reaction.emoji })
                : client.messages.react({ messageId: message.id, emoji: reaction.emoji }))
            }
          />
        );
      })}
    </div>
  );
}

/** Props for {@link MessageComposer}. */
export interface MessageComposerProps {
  /** Conversation receiving the message. */
  conversationId: string;
  /** Reply target, if any. */
  replyTo?: ClientMessage | null;
  /** Called after a successful send. */
  onSent?: () => void;
  /** Called when the reply target should be cleared. */
  onClearReply?: () => void;
}

/** Sends text messages and supports Enter-to-send and Shift+Enter newlines. */
export function MessageComposer({
  conversationId,
  replyTo = null,
  onSent,
  onClearReply,
}: MessageComposerProps) {
  const { client } = useChatpackUI();
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<{ code: string; message: string } | null>(null);
  async function send(event?: FormEvent): Promise<void> {
    event?.preventDefault();
    const text = body.trim();
    if (text === "" || sending) return;
    setError(null);
    setSending(true);
    const result = await client.messages.send({
      conversationId,
      body: text,
      ...(replyTo === null ? {} : { replyToMessageId: replyTo.id }),
    });
    setSending(false);
    if (result.error !== null) {
      setError(result.error);
      return;
    }
    setBody("");
    onClearReply?.();
    onSent?.();
  }
  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void send();
    }
  }
  return (
    <form className="chatpack-ui-composer" onSubmit={(event) => void send(event)}>
      {error !== null && (
        <div className="chatpack-ui-composer-error">
          <strong>{error.code}</strong>: {error.message}
        </div>
      )}
      {replyTo !== null && (
        <div>
          Replying to <strong>{replyTo.senderId}</strong>
          <button
            type="button"
            className="chatpack-ui-button chatpack-ui-button-ghost"
            onClick={onClearReply}
          >
            Cancel
          </button>
        </div>
      )}
      <textarea
        className="chatpack-ui-input chatpack-ui-focus"
        value={body}
        onChange={(event) => setBody(event.target.value)}
        onKeyDown={onKeyDown}
        placeholder="Write a message…"
        aria-label="Message"
        disabled={sending}
      />
      <button
        type="submit"
        className="chatpack-ui-button chatpack-ui-button-primary chatpack-ui-send"
        disabled={sending || body.trim() === ""}
        aria-label={sending ? "Sending" : "Send message"}
      >
        {sending ? "…" : "↑"}
      </button>
      <small className="chatpack-ui-composer-hint">
        Enter to send · Shift+Enter for a new line
      </small>
    </form>
  );
}

/** Displays realtime connection health without adding reconnection logic. */
export function ConnectionStatus() {
  const { client } = useChatpackUI();
  const realtime = client.useRealtimeStatus();
  return (
    <p role="status" className="chatpack-ui-muted">
      {realtime.status === "open"
        ? "Live"
        : realtime.status === "polling"
          ? "Using polling"
          : "Reconnecting…"}
    </p>
  );
}

/** A responsive conversation list, thread, composer, and connection indicator. */
export function ChatWindow({
  conversationId,
  className,
}: {
  conversationId: string;
  className?: string;
}) {
  const { client, userId, renderUser } = useChatpackUI();
  const conversation = client.useConversation({ conversationId });
  const [replyTo, setReplyTo] = useState<ClientMessage | null>(null);
  return (
    <main className={cx("chatpack-ui-window chatpack-ui-surface", className)}>
      <header className="chatpack-ui-window-header">
        <strong>{conversation.data?.name ?? conversation.data?.id ?? "Conversation"}</strong>
        {conversation.data !== null && (
          <span className="chatpack-ui-muted">
            {conversation.data.participants
              .filter((participant) => participant.userId !== userId)
              .map((participant) => renderUser(participant.userId))}
          </span>
        )}
      </header>
      <ConnectionStatus />
      <MessageThread conversationId={conversationId} onReply={setReplyTo} showHeader={false} />
      <TypingIndicator conversationId={conversationId} />
      <MessageComposer
        conversationId={conversationId}
        replyTo={replyTo}
        onClearReply={() => setReplyTo(null)}
      />
    </main>
  );
}
