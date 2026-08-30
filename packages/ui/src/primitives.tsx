import type { ReactNode } from "react";
import type { ClientMessage, ClientReactionSummary } from "@chatpack/client";
import { cx } from "./utils";

/** Displays a user id or host-provided user representation. */
export function UserLabel({ userId, children }: { userId: string; children?: ReactNode }) {
  return <span>{children ?? userId}</span>;
}

/** Displays an unread count and hides itself when the count is zero. */
export function UnreadBadge({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <span className="chatpack-ui-unread-badge" aria-label={`${count} unread`}>
      {count > 99 ? "99+" : count}
    </span>
  );
}

/** Displays a compact presence dot. */
export function PresenceDot({ online, label = true }: { online: boolean; label?: boolean }) {
  return (
    <span
      aria-label={label ? (online ? "Online" : "Offline") : undefined}
      title={label ? undefined : online ? "Online" : "Offline"}
      className={cx("chatpack-ui-presence-dot", online && "chatpack-ui-presence-dot-online")}
    />
  );
}

/** Displays a message timestamp using the user's locale. */
export function Timestamp({ date }: { date: string }) {
  return <time dateTime={date}>{new Date(date).toLocaleString()}</time>;
}

/** Displays a reaction summary without owning reaction state. */
export function ReactionPill({
  reaction,
  pressed,
  onClick,
}: {
  reaction: ClientReactionSummary;
  pressed?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      className="chatpack-ui-reaction-pill"
      aria-pressed={pressed}
      onClick={onClick}
    >
      {reaction.emoji} {reaction.count}
    </button>
  );
}

/** Displays one message with deleted and edited states. */
export function MessageBubble({
  message,
  own,
  renderUser,
  footer,
  children,
}: {
  message: ClientMessage;
  own: boolean;
  renderUser?: (userId: string) => ReactNode;
  footer?: ReactNode;
  children?: ReactNode;
}) {
  const deleted = message.deletedAt !== null;
  return (
    <article
      className={cx(
        "chatpack-ui-bubble",
        own ? "chatpack-ui-bubble-own" : "chatpack-ui-bubble-other",
      )}
    >
      {!own && renderUser !== undefined && (
        <div className="chatpack-ui-message-author">{renderUser(message.senderId)}</div>
      )}
      <div>{deleted ? <em>Message deleted</em> : (children ?? message.body)}</div>
      {message.editedAt !== null && !deleted && <small>(edited)</small>}
      {footer}
    </article>
  );
}

/** Displays a quote preview for a reply, including deleted parents. */
export function ReplyQuoteBar({ replyTo }: { replyTo: ClientMessage["replyTo"] }) {
  if (replyTo === null) return null;
  return (
    <aside className="chatpack-ui-reply-quote">
      <strong>{replyTo.senderId}</strong>:{" "}
      {replyTo.deleted ? <em>Message deleted</em> : replyTo.excerpt}
    </aside>
  );
}

/** Displays a consistent loading message for a block. */
export function LoadingState({ label = "Loading" }: { label?: string }) {
  return (
    <p role="status" aria-live="polite">
      {label}…
    </p>
  );
}

/** Displays a retryable client error. */
export function ErrorNotice({
  error,
  onRetry,
}: {
  error: { code: string; message: string };
  onRetry?: () => void;
}) {
  return (
    <div role="alert">
      <strong>{error.code}</strong>: {error.message}
      {onRetry !== undefined && (
        <button type="button" onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  );
}

/** Displays an empty state. */
export function EmptyState({ children = "Nothing here yet" }: { children?: ReactNode }) {
  return <p>{children}</p>;
}
