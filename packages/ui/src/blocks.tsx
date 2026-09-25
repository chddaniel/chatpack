import {
  Fragment,
  useEffect,
  useMemo,
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

const MAX_MESSAGE_LENGTH = 2000;

/** Props for {@link ConversationList}. */
export interface ConversationListProps {
  /** Currently selected conversation. */
  selectedId?: string | null;
  /** Called when a conversation is selected. */
  onSelect?: (conversation: ClientConversation) => void;
  /** Optional class name. */
  className?: string;
  /** Optional profile renderer override. */
  renderUser?: (userId: string) => ReactNode;
}

/** Lists conversations with selection and viewer-relative unread counts. */
export function ConversationList({
  selectedId = null,
  onSelect,
  className,
  renderUser: renderUserOverride,
}: ConversationListProps) {
  const { client, userId, renderUser: defaultRenderUser } = useChatpackUI();
  const renderUser = renderUserOverride ?? defaultRenderUser;
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
  /** Called by the empty-state action, when provided. */
  onEmptyAction?: () => void;
  /** Optional profile renderer override. */
  renderUser?: (userId: string) => ReactNode;
}

/** Displays a live message history, gap-filled by the Chatpack client. */
export function MessageThread({
  conversationId,
  onReply,
  onEmptyAction,
  className,
  showHeader = true,
  renderUser: renderUserOverride,
}: MessageThreadProps) {
  const { client, userId, renderUser: defaultRenderUser } = useChatpackUI();
  const renderUser = renderUserOverride ?? defaultRenderUser;
  const messages = client.useMessages({ conversationId, limit: 50 });
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const page = messages.data?.messages ?? [];
  const newest = page[0];
  const displayMessages = useMemo(() => [...page].reverse(), [page]);
  useEffect(() => {
    if (newest !== undefined)
      void client.conversations.markRead({ conversationId, messageId: newest.id });
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [client, conversationId, newest]);
  if (messages.error !== null)
    return (
      <div className="chatpack-ui-message-thread-state">
        <ErrorNotice
          title="Couldn't load messages"
          description="The conversation is fine — we just could not reach it. Nothing has been lost."
          error={messages.error}
          onRetry={() => void messages.refetch()}
        />
      </div>
    );
  if (messages.isPending && page.length === 0)
    return (
      <div className="chatpack-ui-message-thread-state" role="status" aria-label="Loading messages">
        <div className="chatpack-ui-message-thread-loading">
          {[240, 180, 260, 210, 200].map((width, index) => (
            <div
              key={index}
              className={`chatpack-ui-message-thread-loading-row ${index === 2 || index === 4 ? "chatpack-ui-message-thread-loading-own" : ""}`}
            >
              <div
                className="chatpack-ui-message-thread-loading-bar"
                style={{ width, height: index % 2 === 0 ? 34 : 20 }}
              />
            </div>
          ))}
        </div>
      </div>
    );
  if (page.length === 0)
    return (
      <div className="chatpack-ui-message-thread-state">
        <EmptyState
          title="No messages yet"
          description="Send the first message and it appears here instantly — for everyone in the conversation, with no refresh."
          actionLabel="Say hello"
          onAction={onEmptyAction}
        />
      </div>
    );
  return (
    <section className={cx("chatpack-ui-message-thread-shell", className)}>
      {showHeader && <header className="chatpack-ui-list-header">Messages</header>}
      <div className="chatpack-ui-message-thread" aria-live="polite">
        {(messages.data?.nextCursor ?? null) !== null && (
          <button
            type="button"
            className="chatpack-ui-button chatpack-ui-button-ghost"
            onClick={() => void messages.loadMore()}
          >
            Load older messages
          </button>
        )}
        {displayMessages.map((message, index) => {
          const previous = displayMessages[index - 1];
          const showDay =
            previous === undefined ||
            messageDayKey(previous.createdAt) !== messageDayKey(message.createdAt);
          return (
            <Fragment key={message.id}>
              {showDay && (
                <div className="chatpack-ui-day-separator">
                  {messageDayLabel(message.createdAt)}
                </div>
              )}
              <MessageThreadRow
                message={message}
                own={message.senderId === userId}
                renderUser={renderUser}
                {...(onReply === undefined ? {} : { onReply })}
              />
            </Fragment>
          );
        })}
        <div ref={bottomRef} />
      </div>
    </section>
  );
}

function messageDayKey(value: string | Date): string {
  const date = new Date(value);
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

function messageDayLabel(value: string | Date): string {
  const date = new Date(value);
  const now = new Date();
  return messageDayKey(value) === messageDayKey(now)
    ? "TODAY"
    : date.toLocaleDateString(undefined, { month: "short", day: "numeric" }).toUpperCase();
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
      {message.forwardedFrom !== null && own && (
        <small className="chatpack-ui-forwarded">
          Forwarded from {renderUser(message.forwardedFrom.senderId)}
        </small>
      )}
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
      >
        {message.forwardedFrom !== null && !own && (
          <small className="chatpack-ui-forwarded">
            Forwarded from {renderUser(message.forwardedFrom.senderId)}
          </small>
        )}
        <ReplyQuoteBar replyTo={message.replyTo} />
        {message.body}
      </MessageBubble>
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
  /** Disables interaction while host switches conversations. */
  disabled?: boolean;
  /** Placeholder shown in composer. */
  placeholder?: string;
  /** Called after a successful send. */
  onSent?: () => void;
  /** Called when the reply target should be cleared. */
  onClearReply?: () => void;
}

/** Sends text messages and supports Enter-to-send and Shift+Enter newlines. */
export function MessageComposer({
  conversationId,
  replyTo = null,
  disabled = false,
  placeholder = "Write a message…",
  onSent,
  onClearReply,
}: MessageComposerProps) {
  const { client } = useChatpackUI();
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<{ code: string; message: string } | null>(null);
  const typingUntil = useRef(0);
  function signalTyping(): void {
    if (conversationId === "") return;
    const now = Date.now();
    if (now < typingUntil.current) return;
    typingUntil.current = now + 3000;
    void client.typing?.start({ conversationId });
  }
  function stopTyping(): void {
    typingUntil.current = 0;
    if (conversationId !== "") void client.typing?.stop({ conversationId });
  }
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
    stopTyping();
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
      {replyTo !== null && (
        <div className="chatpack-ui-composer-reply">
          <span className="chatpack-ui-composer-reply-label">
            Replying to <strong>{replyTo.senderId}</strong> · {replyTo.body}
          </span>
          <button
            type="button"
            className="chatpack-ui-button chatpack-ui-button-ghost"
            onClick={onClearReply}
            aria-label="Cancel reply"
          >
            ×
          </button>
        </div>
      )}
      <div
        className="chatpack-ui-composer-field"
        data-error={error !== null ? "true" : undefined}
        data-sending={sending ? "true" : undefined}
      >
        <textarea
          className="chatpack-ui-composer-textarea"
          value={body}
          onChange={(event) => {
            setBody(event.target.value);
            setError(null);
            signalTyping();
          }}
          onKeyDown={onKeyDown}
          onBlur={stopTyping}
          placeholder={placeholder}
          aria-label="Message"
          aria-invalid={error !== null}
          maxLength={MAX_MESSAGE_LENGTH}
          disabled={disabled || sending || conversationId === ""}
        />
        <button
          type="submit"
          className="chatpack-ui-composer-send"
          disabled={disabled || sending || body.trim() === "" || conversationId === ""}
          aria-label={sending ? "Sending" : "Send message"}
        >
          {sending ? "Sending…" : "Send"}
        </button>
      </div>
      <div className="chatpack-ui-composer-hint-row">
        <small
          className={error !== null ? "chatpack-ui-composer-error" : "chatpack-ui-composer-hint"}
        >
          {error !== null
            ? "Message didn't send. Tap Send to try again."
            : sending
              ? "Sending…"
              : "Enter to send · Shift+Enter for a new line"}
        </small>
        {error !== null ? (
          <code className="chatpack-ui-composer-error-code">{error.code}</code>
        ) : (
          <small className="chatpack-ui-composer-count" aria-live="polite">
            {body.length}/{MAX_MESSAGE_LENGTH}
          </small>
        )}
      </div>
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
        <strong>
          {conversation.data?.type === "direct"
            ? (conversation.data.participants.find((participant) => participant.userId !== userId)
                ?.userId ?? "Conversation")
            : (conversation.data?.name ?? conversation.data?.id ?? "Conversation")}
        </strong>
        {conversation.data !== null && (
          <span className="chatpack-ui-muted">
            {conversation.data.participants
              .filter((participant) => participant.userId !== userId)
              .map((participant) => (
                <span key={participant.userId}>{renderUser(participant.userId)}</span>
              ))}
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
