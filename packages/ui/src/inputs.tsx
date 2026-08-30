import { useState, type FormEvent } from "react";
import type { ClientMessage } from "@chatpack/client";
import { useChatpackUI } from "./context";
import { EmptyState, ErrorNotice, LoadingState, MessageBubble, Timestamp } from "./primitives";

/** Provides edit and delete actions for a message owned by the viewer. */
export function MessageActions({
  message,
  canEdit = true,
  onReply,
  onForward,
  onComplete,
}: {
  message: ClientMessage;
  canEdit?: boolean;
  /** Called when viewer chooses reply. */
  onReply?: (message: ClientMessage) => void;
  /** Called when viewer chooses forward. */
  onForward?: (message: ClientMessage) => void;
  onComplete?: () => void;
}) {
  const { client, userId } = useChatpackUI();
  const [pending, setPending] = useState(false);
  const [editing, setEditing] = useState(false);
  const [body, setBody] = useState(message.body);
  const [error, setError] = useState<{ code: string; message: string } | null>(null);
  async function remove(): Promise<void> {
    setPending(true);
    setError(null);
    const result = await client.messages.delete({ messageId: message.id });
    setPending(false);
    if (result.error === null) onComplete?.();
    else setError(result.error);
  }
  async function edit(): Promise<void> {
    if (body.trim() === "") return;
    setPending(true);
    setError(null);
    const result = await client.messages.edit({ messageId: message.id, body: body.trim() });
    setPending(false);
    if (result.error === null) {
      setEditing(false);
      onComplete?.();
    } else setError(result.error);
  }
  return (
    <span className="chatpack-ui-message-actions">
      {message.deletedAt !== null && (
        <p className="chatpack-ui-message-actions-deleted">Message deleted</p>
      )}
      {editing && (
        <>
          <textarea
            className="chatpack-ui-input"
            value={body}
            onChange={(event) => setBody(event.target.value)}
            aria-label="Edit message"
            rows={2}
          />
          <button type="button" disabled={pending} onClick={() => void edit()}>
            Save
          </button>
          <button type="button" disabled={pending} onClick={() => setEditing(false)}>
            Cancel
          </button>
        </>
      )}
      {!editing && (
        <>
          <button type="button" disabled={pending} onClick={() => onReply?.(message)}>
            Reply
          </button>
          <button type="button" disabled={pending} onClick={() => onForward?.(message)}>
            Forward
          </button>
          {message.deletedAt === null && canEdit && message.senderId === userId && (
            <button type="button" disabled={pending} onClick={() => setEditing(true)}>
              Edit
            </button>
          )}
          {message.deletedAt === null && message.senderId === userId && (
            <button type="button" disabled={pending} onClick={() => void remove()}>
              Delete
            </button>
          )}
        </>
      )}
      {error !== null && <small role="alert">{error.message}</small>}
    </span>
  );
}

/** Alias matching the published gallery name for message actions. */
export function MessageActionsMenu(props: Parameters<typeof MessageActions>[0]) {
  return <MessageActions {...props} />;
}

/** Adds one reaction to a message without mirroring reaction state locally. */
export function QuickReactions({
  message,
}: {
  /** Message whose reaction state controls each toggle. */
  message: ClientMessage;
}) {
  const { client, userId } = useChatpackUI();
  if (message.deletedAt !== null) return null;
  const emojis = ["👍", "❤️", "😂", "🎉", "👀", "🔥"] as const;
  return (
    <div className="chatpack-ui-quick-reactions" aria-label="Quick reactions">
      {emojis.map((emoji) => {
        const summary = message.reactions.find((reaction) => reaction.emoji === emoji);
        const mine = summary?.userIds.includes(userId) ?? false;
        return (
          <button
            type="button"
            key={emoji}
            aria-pressed={mine}
            onClick={() =>
              void (mine
                ? client.messages.unreact({ messageId: message.id, emoji })
                : client.messages.react({ messageId: message.id, emoji }))
            }
          >
            {emoji} {summary !== undefined && summary.count > 0 ? summary.count : ""}
          </button>
        );
      })}
    </div>
  );
}

/** Searches the viewer's participant-scoped message history. */
export function MessageSearch({ onSelect }: { onSelect?: (messageId: string) => void }) {
  const { client, renderUser } = useChatpackUI();
  const [query, setQuery] = useState("");
  const results = client.useMessageSearch({ query, limit: 20 });
  function submit(event: FormEvent): void {
    event.preventDefault();
  }
  return (
    <section className="chatpack-ui-message-search">
      <form onSubmit={submit}>
        <input
          className="chatpack-ui-input chatpack-ui-focus"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search messages"
          aria-label="Search messages"
        />
      </form>
      {results.error !== null && (
        <ErrorNotice error={results.error} onRetry={() => void results.refetch()} />
      )}
      {results.isPending && <LoadingState label="Searching" />}
      {!results.isPending && query.trim() !== "" && results.data?.messages.length === 0 && (
        <EmptyState>No matching messages</EmptyState>
      )}
      <div>
        {results.data?.messages.map((message) => (
          <button type="button" key={message.id} onClick={() => onSelect?.(message.id)}>
            <MessageBubble message={message} own={false} renderUser={renderUser} />
            <Timestamp date={message.createdAt} />
          </button>
        ))}
      </div>
    </section>
  );
}
