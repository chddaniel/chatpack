import { useState, type FormEvent } from "react";
import type { ClientMessage } from "@chatpack/client";
import { useChatpackUI } from "./context";
import { EmptyState, ErrorNotice, LoadingState, MessageBubble, Timestamp } from "./primitives";

/** Provides edit and delete actions for a message owned by the viewer. */
export function MessageActions({
  message,
  canEdit = true,
  onComplete,
}: {
  message: ClientMessage;
  canEdit?: boolean;
  onComplete?: () => void;
}) {
  const { client } = useChatpackUI();
  const [pending, setPending] = useState(false);
  const [editing, setEditing] = useState(false);
  const [body, setBody] = useState(message.body);
  async function remove(): Promise<void> {
    setPending(true);
    const result = await client.messages.delete({ messageId: message.id });
    setPending(false);
    if (result.error === null) onComplete?.();
  }
  async function edit(): Promise<void> {
    if (body.trim() === "") return;
    setPending(true);
    const result = await client.messages.edit({ messageId: message.id, body: body.trim() });
    setPending(false);
    if (result.error === null) {
      setEditing(false);
      onComplete?.();
    }
  }
  return (
    <span className="chatpack-ui-message-actions">
      {editing && (
        <>
          <input
            className="chatpack-ui-input"
            value={body}
            onChange={(event) => setBody(event.target.value)}
            aria-label="Edit message"
          />
          <button type="button" disabled={pending} onClick={() => void edit()}>
            Save
          </button>
          <button type="button" disabled={pending} onClick={() => setEditing(false)}>
            Cancel
          </button>
        </>
      )}
      {!editing && canEdit && !message.deletedAt && (
        <button type="button" disabled={pending} onClick={() => setEditing(true)}>
          Edit
        </button>
      )}
      <button
        type="button"
        disabled={pending || message.deletedAt !== null}
        onClick={() => void remove()}
      >
        Delete
      </button>
    </span>
  );
}

/** Adds one reaction to a message without mirroring reaction state locally. */
export function QuickReactions({
  messageId,
  emojis = ["👍", "❤️", "🎉", "😂"],
}: {
  messageId: string;
  emojis?: readonly string[];
}) {
  const { client } = useChatpackUI();
  return (
    <div className="chatpack-ui-quick-reactions" aria-label="Quick reactions">
      {emojis.map((emoji) => (
        <button
          type="button"
          key={emoji}
          onClick={() => void client.messages.react({ messageId, emoji })}
        >
          {emoji}
        </button>
      ))}
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
