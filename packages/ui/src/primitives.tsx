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
  return (
    <time dateTime={date}>
      {new Date(date).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
    </time>
  );
}

/** Displays a reaction summary without owning reaction state. */
export type ReactionPillProps =
  | {
      /** Client reaction summary. */
      reaction: ClientReactionSummary;
      /** Viewer has reacted. */
      pressed?: boolean;
      /** Called when viewer toggles reaction. */
      onClick?: () => void;
      emoji?: never;
      count?: never;
      mine?: never;
    }
  | {
      /** Reaction identifier. */
      emoji: string;
      /** Reaction count. */
      count: number;
      /** Viewer has reacted. */
      mine?: boolean;
      /** Called when viewer toggles reaction. */
      onClick?: () => void;
      reaction?: never;
      pressed?: never;
    };

export function ReactionPill({
  reaction,
  emoji,
  count,
  mine,
  pressed,
  onClick,
}: ReactionPillProps) {
  const resolvedEmoji = reaction?.emoji ?? emoji;
  const resolvedCount = reaction?.count ?? count;
  const resolvedPressed = reaction === undefined ? mine : pressed;
  return (
    <button
      type="button"
      className="chatpack-ui-reaction-pill"
      aria-pressed={resolvedPressed}
      onClick={onClick}
    >
      {resolvedEmoji} {resolvedCount}
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
    <div className={cx("chatpack-ui-bubble-wrap", own && "chatpack-ui-bubble-wrap-own")}>
      {!own && renderUser !== undefined && (
        <div className="chatpack-ui-message-author">{renderUser(message.senderId)}</div>
      )}
      <article
        className={cx(
          "chatpack-ui-bubble",
          deleted && "chatpack-ui-bubble-deleted",
          own ? "chatpack-ui-bubble-own" : "chatpack-ui-bubble-other",
        )}
      >
        <div>{deleted ? <em>Message deleted</em> : (children ?? message.body)}</div>
        {message.editedAt !== null && !deleted && <small>(edited)</small>}
      </article>
      {footer !== undefined && <div className="chatpack-ui-bubble-footer">{footer}</div>}
    </div>
  );
}

/** Displays a quote preview for a reply, including deleted parents. */
export type ReplyQuoteBarProps =
  | { replyTo: ClientMessage["replyTo"]; sender?: never; excerpt?: never; deleted?: never }
  | { sender: ReactNode; excerpt: string; deleted?: boolean; replyTo?: never };

export function ReplyQuoteBar({ replyTo, sender, excerpt, deleted = false }: ReplyQuoteBarProps) {
  if (replyTo === null || replyTo === undefined) {
    if (sender === undefined || excerpt === undefined) return null;
    return (
      <aside className="chatpack-ui-reply-quote">
        <strong>{sender}</strong>: {deleted ? <em>Message deleted</em> : excerpt}
      </aside>
    );
  }
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
    <div className="chatpack-ui-empty" role="status" aria-live="polite">
      <div className="chatpack-ui-loading-skeleton" />
      {label}…
    </div>
  );
}

/** Displays a retryable client error. */
export function ErrorNotice({
  error,
  onRetry,
  title,
  description,
}: {
  error: { code: string; message: string };
  onRetry?: () => void;
  title?: string;
  description?: string;
}) {
  if (title !== undefined || description !== undefined) {
    return (
      <div className="chatpack-ui-state-content" role="alert">
        <strong>{title ?? "Something went wrong"}</strong>
        <span>{description ?? error.message}</span>
        <code>{error.code}</code>
        {onRetry !== undefined && (
          <button
            type="button"
            className="chatpack-ui-button chatpack-ui-button-primary"
            onClick={onRetry}
          >
            Try again
          </button>
        )}
      </div>
    );
  }
  return (
    <div className="chatpack-ui-error" role="alert">
      <strong>{error.code}</strong>: {error.message}
      {onRetry !== undefined && (
        <button
          type="button"
          className="chatpack-ui-button chatpack-ui-button-ghost"
          onClick={onRetry}
        >
          Retry
        </button>
      )}
    </div>
  );
}

/** Displays an empty state. */
export function EmptyState({
  children = "Nothing here yet",
  title,
  description,
  actionLabel,
  onAction,
}: {
  children?: ReactNode;
  title?: string;
  description?: string;
  actionLabel?: string;
  onAction?: (() => void) | undefined;
}) {
  if (title === undefined && description === undefined && actionLabel === undefined) {
    return <p className="chatpack-ui-empty">{children}</p>;
  }
  return (
    <div className="chatpack-ui-state-content">
      <strong>{title ?? children}</strong>
      {description !== undefined && <span>{description}</span>}
      {actionLabel !== undefined && onAction !== undefined && (
        <button
          type="button"
          className="chatpack-ui-button chatpack-ui-button-primary"
          onClick={onAction}
        >
          {actionLabel}
        </button>
      )}
    </div>
  );
}
