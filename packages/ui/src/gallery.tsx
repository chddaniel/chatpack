import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";
import type {
  ClientChannelPreview,
  ClientConversation,
  ClientConversationInvite,
  ClientConversationMute,
  ClientJoinRequest,
  ClientMessage,
  ClientModerationReport,
  ClientUserBan,
  ClientUserBlock,
} from "@chatpack/client";
import {
  parseFileAttachmentMetadata,
  type FileAttachmentReference,
  type ResolvedFileAttachment,
} from "@chatpack/file";
import { useChatpackUI } from "./context";
import { ChatWindow, ConversationList, MessageComposer, MessageThread } from "./blocks";
import {
  EmptyState,
  MessageBubble,
  LoadingState,
  ReactionPill,
  ReplyQuoteBar,
  Timestamp,
  UnreadBadge,
} from "./primitives";
import { QuickReactions } from "./inputs";
import { PresenceAvatarStack, TypingIndicator } from "./realtime";

type ReportStatus = "open" | "triaged" | "resolved" | "dismissed";
type ReportTargetType = "user" | "message" | "conversation";

/** Displays a conversation heading without assuming a profile schema. */
export function ConversationHeader({
  conversationId,
  renderUser = (id) => id,
}: {
  conversationId: string;
  renderUser?: (userId: string) => ReactNode;
}) {
  const { client, userId } = useChatpackUI();
  const conversation = client.useConversation({ conversationId });
  const data = conversation.data;
  const title =
    data === null
      ? "Conversation"
      : data.type === "group"
        ? (data.name ?? data.id)
        : renderUser(
            data.participants.find((participant) => participant.userId !== userId)?.userId ??
              data.id,
          );
  return (
    <header className="chatpack-ui-conversation-header">
      <h2>{title}</h2>
      {data !== null && (
        <small>
          {data.type === "group" ? String(data.participants.length) + " members" : "Direct message"}
        </small>
      )}
    </header>
  );
}

/** Displays a compact conversation list for narrow navigation rails. */
export function CompactChatList({
  selectedId,
  onSelect,
  renderUser,
}: {
  selectedId: string | null;
  onSelect: (conversationId: string) => void;
  renderUser?: (userId: string) => ReactNode;
}) {
  const handleSelect = (conversation: ClientConversation): void => onSelect(conversation.id);
  return (
    <ConversationList
      selectedId={selectedId}
      onSelect={handleSelect}
      className="chatpack-ui-compact-list"
      {...(renderUser === undefined ? {} : { renderUser })}
    />
  );
}

/** Displays one conversation row for a caller-owned conversation page. */
export function ConversationRow({
  conversation,
  selected,
  onSelect,
  renderUser = (id) => id,
}: {
  conversation: ClientConversation;
  selected?: boolean;
  onSelect?: (conversationId: string) => void;
  renderUser?: (userId: string) => ReactNode;
}) {
  const { userId, renderUser: contextRenderUser } = useChatpackUI();
  const profile = renderUser ?? contextRenderUser;
  const other = conversation.participants.find(
    (participant) => participant.userId !== userId,
  )?.userId;
  return (
    <button
      type="button"
      aria-current={selected ? "page" : undefined}
      onClick={() => onSelect?.(conversation.id)}
    >
      {conversation.type === "group"
        ? (conversation.name ?? conversation.id)
        : other === undefined
          ? conversation.id
          : profile(other)}
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
  renderUser = (id) => id,
  className = "chatpack-ui-inbox-layout",
}: {
  renderUser?: (userId: string) => ReactNode;
  className?: string;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  return (
    <div className={className}>
      <aside>
        <ConversationList
          selectedId={selectedId}
          onSelect={(conversation) => setSelectedId(conversation.id)}
          renderUser={renderUser}
        />
      </aside>
      <section>
        {selectedId === null ? (
          <EmptyState>Select a conversation</EmptyState>
        ) : (
          <ChatWindow conversationId={selectedId} />
        )}
      </section>
    </div>
  );
}

/** Provides a mobile-friendly one-pane chat sheet with back navigation. */
export function MobileChatSheet({
  renderUser,
  className = "chatpack-ui-mobile-sheet",
}: {
  renderUser?: (userId: string) => ReactNode;
  className?: string;
}) {
  const [conversationId, setConversationId] = useState<string | null>(null);
  return (
    <div className={className}>
      {conversationId === null ? (
        <ConversationList
          selectedId={null}
          onSelect={(conversation) => setConversationId(conversation.id)}
          {...(renderUser === undefined ? {} : { renderUser })}
        />
      ) : (
        <>
          <button type="button" onClick={() => setConversationId(null)}>
            Back
          </button>
          <ChatWindow conversationId={conversationId} />
        </>
      )}
    </div>
  );
}

/** Displays a floating chat window anchored to the caller's page. */
export function FloatingChatWidget({
  renderUser,
  embedded = false,
}: {
  renderUser?: (userId: string) => ReactNode;
  embedded?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [conversationId, setConversationId] = useState<string | null>(null);
  return (
    <div
      className={embedded ? "chatpack-ui-floating-widget embedded" : "chatpack-ui-floating-widget"}
    >
      {open && (
        <div className="chatpack-ui-floating-panel">
          <CompactChatList
            selectedId={conversationId}
            onSelect={setConversationId}
            {...(renderUser === undefined ? {} : { renderUser })}
          />
          {conversationId === null ? (
            <EmptyState>Select a conversation</EmptyState>
          ) : (
            <ChatWindow conversationId={conversationId} />
          )}
        </div>
      )}
      <button type="button" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        {open ? "Close chat" : "Open chat"}
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

/** Renders a message composer with mention ids selected from conversation members. */
export function MentionComposer({
  conversationId,
  renderUser = (userId) => userId,
}: {
  conversationId: string;
  renderUser?: (userId: string) => ReactNode;
}) {
  const { client } = useChatpackUI();
  const conversation = client.useConversation({ conversationId });
  const [body, setBody] = useState("");
  const [mentions, setMentions] = useState<string[]>([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const members = useMemo(
    () => (conversation.data?.participants ?? []).map((participant) => participant.userId),
    [conversation.data?.participants],
  );
  async function send(): Promise<void> {
    const text = body.trim();
    if (conversationId === "" || text === "" || sending) return;
    setSending(true);
    setError(null);
    const result = await client.messages.send({
      conversationId,
      body: text,
      ...(mentions.length === 0 ? {} : { mentions }),
    });
    setSending(false);
    if (result.error !== null) {
      setError(result.error.message);
      return;
    }
    setBody("");
    setMentions([]);
  }
  return (
    <form
      className="chatpack-ui-mention-composer"
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
    >
      <MentionAutocomplete
        conversationId={conversationId}
        value={mentions}
        onChange={setMentions}
        renderUser={renderUser}
      />
      <textarea
        value={body}
        onChange={(event) => setBody(event.target.value)}
        aria-label="Message with mentions"
        placeholder="Mention someone…"
        disabled={sending}
      />
      {error !== null && <p role="alert">{error}</p>}
      <button type="submit" disabled={sending || body.trim() === ""}>
        Send
      </button>
      <span>{members.length} mentionable members</span>
    </form>
  );
}

/** Selects supplied participant ids without parsing display names or message text. */
export function MentionAutocomplete({
  conversationId,
  value,
  onChange,
  renderUser = (userId) => userId,
}: {
  conversationId: string;
  value: readonly string[];
  onChange: (mentions: string[]) => void;
  renderUser?: (userId: string) => ReactNode;
}) {
  const { client, userId } = useChatpackUI();
  const conversation = client.useConversation({ conversationId });
  const [query, setQuery] = useState("");
  const members = useMemo(
    () =>
      (conversation.data?.participants ?? [])
        .map((participant) => participant.userId)
        .filter((id) => id !== userId),
    [conversation.data?.participants, userId],
  );
  const filtered = members.filter((id) => {
    const needle = query.trim().toLowerCase();
    return needle === "" || id.toLowerCase().includes(needle);
  });
  function toggle(id: string): void {
    onChange(value.includes(id) ? value.filter((item) => item !== id) : [...value, id]);
  }
  return (
    <div className="chatpack-ui-mention-autocomplete">
      <input
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        aria-label="Filter members to mention"
        placeholder="Filter members…"
      />
      <ul role="listbox" aria-label="Mentionable members">
        {filtered.map((id) => (
          <li key={id}>
            <button
              type="button"
              role="option"
              aria-selected={value.includes(id)}
              onClick={() => toggle(id)}
            >
              {renderUser(id)}
            </button>
          </li>
        ))}
      </ul>
    </div>
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
      {pickerOpen && <QuickReactions message={message} />}
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

/** Adds, removes, promotes, or demotes group participants through Chatpack actions. */
export function ParticipantManager({
  conversationId,
  renderUser = (id) => id,
}: {
  conversationId: string;
  renderUser?: (userId: string) => ReactNode;
}) {
  const { client, userId } = useChatpackUI();
  const conversation = client.useConversation({ conversationId });
  const [newUserId, setNewUserId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function run(action: () => Promise<{ error: { message: string } | null }>): Promise<void> {
    setBusy(true);
    setError(null);
    const result = await action();
    setBusy(false);
    if (result.error !== null) setError(result.error.message);
    else await conversation.refetch();
  }
  if (conversationId === "") return <EmptyState>Select a group conversation.</EmptyState>;
  return (
    <div className="chatpack-ui-management-card">
      <h3>Members</h3>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const id = newUserId.trim();
          if (id !== "")
            void run(async () => {
              const result = await client.conversations.addParticipants({
                conversationId,
                userIds: [id],
              });
              if (result.error === null) setNewUserId("");
              return result;
            });
        }}
      >
        <input
          value={newUserId}
          onChange={(event) => setNewUserId(event.target.value)}
          aria-label="User id to add"
          placeholder="User id"
        />
        <button type="submit" disabled={busy || newUserId.trim() === ""}>
          Add
        </button>
      </form>
      {error !== null && <p role="alert">{error}</p>}
      <ul>
        {(conversation.data?.participants ?? []).map((participant) => (
          <li key={participant.userId}>
            <span>
              {renderUser(participant.userId)}
              {participant.userId === userId ? " (you)" : ""}
            </span>
            <small>{participant.role}</small>
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                void run(() =>
                  client.conversations.setParticipantRole({
                    conversationId,
                    userId: participant.userId,
                    role: participant.role === "admin" ? "member" : "admin",
                  }),
                )
              }
            >
              {participant.role === "admin" ? "Demote" : "Promote"}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                void run(() =>
                  client.conversations.removeParticipant({
                    conversationId,
                    userId: participant.userId,
                  }),
                )
              }
            >
              {participant.userId === userId ? "Leave" : "Remove"}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Creates, lists, copies, and revokes group invite links. */
export function InviteManager({ conversationId }: { conversationId: string }) {
  const { client } = useChatpackUI();
  const [invites, setInvites] = useState<ClientConversationInvite[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    if (conversationId === "") return;
    const result = await client.invites.list({ conversationId });
    if (result.error !== null) setError(result.error.message);
    else setInvites(result.data.invites);
  }, [client, conversationId]);
  useEffect(() => {
    void load();
  }, [load]);
  async function create(): Promise<void> {
    setBusy(true);
    setError(null);
    const result = await client.invites.create({ conversationId, expiresInSeconds: 604800 });
    setBusy(false);
    if (result.error !== null) setError(result.error.message);
    else await load();
  }
  async function revoke(code: string): Promise<void> {
    setBusy(true);
    const result = await client.invites.revoke({ conversationId, code });
    setBusy(false);
    if (result.error !== null) setError(result.error.message);
    else await load();
  }
  return (
    <div className="chatpack-ui-management-card">
      <h3>Invite links</h3>
      <button type="button" disabled={busy || conversationId === ""} onClick={() => void create()}>
        New link
      </button>
      {error !== null && <p role="alert">{error}</p>}
      <ul>
        {invites.map((invite) => (
          <li key={invite.code}>
            <code>{invite.code}</code>
            <button
              type="button"
              disabled={busy}
              onClick={() => void navigator.clipboard?.writeText(invite.code)}
            >
              Copy
            </button>
            <button type="button" disabled={busy} onClick={() => void revoke(invite.code)}>
              Revoke
            </button>
          </li>
        ))}
      </ul>
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

/** Lists pending join requests and resolves them through Chatpack actions. */
export function JoinRequests({
  conversationId,
  renderUser = (id) => id,
}: {
  conversationId: string;
  renderUser?: (userId: string) => ReactNode;
}) {
  const { client } = useChatpackUI();
  const [requests, setRequests] = useState<ClientJoinRequest[]>([]);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    if (conversationId === "") return;
    const result = await client.joinRequests.list({ conversationId, status: "pending" });
    if (result.error !== null) setError(result.error.message);
    else setRequests(result.data.joinRequests);
  }, [client, conversationId]);
  useEffect(() => {
    void load();
  }, [load]);
  return (
    <div className="chatpack-ui-management-card">
      <h3>Join requests</h3>
      {error !== null && <p role="alert">{error}</p>}
      <ul>
        {requests.map((request) => (
          <li key={request.id}>
            <span>{renderUser(request.userId)}</span>
            {request.message !== null && <small>{request.message}</small>}
            <button
              type="button"
              onClick={() =>
                void client.joinRequests
                  .resolve({ conversationId, userId: request.userId, decision: "approve" })
                  .then(load)
              }
            >
              Approve
            </button>
            <button
              type="button"
              onClick={() =>
                void client.joinRequests
                  .resolve({ conversationId, userId: request.userId, decision: "deny" })
                  .then(load)
              }
            >
              Deny
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Lists public channels and joins them through Chatpack actions. */
export function ChannelDirectory({ onJoined }: { onJoined?: (conversationId: string) => void }) {
  const { client } = useChatpackUI();
  const [channels, setChannels] = useState<ClientChannelPreview[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [joining, setJoining] = useState<string | null>(null);
  const load = useCallback(async () => {
    const result = await client.channels.list();
    if (result.error !== null) setError(result.error.message);
    else setChannels(result.data.channels);
  }, [client]);
  useEffect(() => {
    void load();
  }, [load]);
  async function join(conversationId: string): Promise<void> {
    setJoining(conversationId);
    const result = await client.channels.join({ conversationId });
    setJoining(null);
    if (result.error !== null) setError(result.error.message);
    else if (result.data.status === "joined") onJoined?.(conversationId);
  }
  return (
    <section className="chatpack-ui-management-card">
      <h3>Public channels</h3>
      {error !== null && <p role="alert">{error}</p>}
      <ul>
        {channels.map((channel) => (
          <li key={channel.conversationId}>
            <span>{channel.name ?? "Unnamed channel"}</span>
            <small>{channel.participantCount} members</small>
            <button
              type="button"
              disabled={joining === channel.conversationId}
              onClick={() => void join(channel.conversationId)}
            >
              {joining === channel.conversationId ? "Joining…" : "Join"}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Reads and saves public-channel settings through Chatpack actions. */
export function ChannelSettings({ conversationId }: { conversationId: string }) {
  const { client } = useChatpackUI();
  const conversation = client.useConversation({ conversationId });
  const [name, setName] = useState("");
  const [visibility, setVisibility] = useState<"private" | "public">("private");
  const [joinPolicy, setJoinPolicy] = useState<"open" | "approval">("approval");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (conversation.data !== null) {
      setName(conversation.data.name ?? "");
      setVisibility(conversation.data.visibility);
      setJoinPolicy(conversation.data.joinPolicy);
    }
  }, [conversation.data]);
  async function save(): Promise<void> {
    const result = await client.conversations.update({
      conversationId,
      name: name.trim() === "" ? null : name.trim(),
      visibility,
      joinPolicy,
    });
    if (result.error !== null) setError(result.error.message);
    else await conversation.refetch();
  }
  return (
    <form
      className="chatpack-ui-management-card"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <h3>Channel settings</h3>
      <input
        value={name}
        onChange={(event) => setName(event.target.value)}
        aria-label="Channel name"
        placeholder="Channel name"
      />
      <select
        value={visibility}
        onChange={(event) => setVisibility(event.target.value as "private" | "public")}
        aria-label="Visibility"
      >
        <option value="private">Private</option>
        <option value="public">Public</option>
      </select>
      <select
        value={joinPolicy}
        onChange={(event) => setJoinPolicy(event.target.value as "open" | "approval")}
        aria-label="Join policy"
      >
        <option value="open">Open join</option>
        <option value="approval">Admin approval</option>
      </select>
      {error !== null && <p role="alert">{error}</p>}
      <button type="submit" disabled={conversationId === ""}>
        Save settings
      </button>
    </form>
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

/** Lists and manages viewer-scoped blocked users through Chatpack actions. */
export function BlockedUsers({
  renderUser = (id) => id,
}: {
  renderUser?: (userId: string) => ReactNode;
}) {
  const { client } = useChatpackUI();
  const [blocks, setBlocks] = useState<ClientUserBlock[]>([]);
  const [target, setTarget] = useState("");
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    const result = await client.moderation.listBlockedUsers();
    if (result.error !== null) setError(result.error.message);
    else setBlocks(result.data.blocks);
  }, [client]);
  useEffect(() => {
    void load();
  }, [load]);
  async function block(): Promise<void> {
    const id = target.trim();
    if (id === "") return;
    const result = await client.moderation.blockUser({ targetUserId: id });
    if (result.error !== null) setError(result.error.message);
    else {
      setTarget("");
      await load();
    }
  }
  async function unblock(id: string): Promise<void> {
    const result = await client.moderation.unblockUser({ targetUserId: id });
    if (result.error !== null) setError(result.error.message);
    else await load();
  }
  return (
    <section className="chatpack-ui-management-card">
      <h3>Blocked users</h3>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void block();
        }}
      >
        <input
          value={target}
          onChange={(event) => setTarget(event.target.value)}
          aria-label="User id to block"
          placeholder="User id"
        />
        <button type="submit" disabled={target.trim() === ""}>
          Block
        </button>
      </form>
      {error !== null && <p role="alert">{error}</p>}
      <ul>
        {blocks.map((entry) => (
          <li key={entry.blockedUserId}>
            <span>{renderUser(entry.blockedUserId)}</span>
            <button type="button" onClick={() => void unblock(entry.blockedUserId)}>
              Unblock
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Loads and toggles viewer-scoped mute state through Chatpack actions. */
export function MuteToggle({ conversationId }: { conversationId: string }) {
  const { client } = useChatpackUI();
  const [muted, setMuted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void client.moderation.listMutedConversations().then((result) => {
      if (result.error !== null) setError(result.error.message);
      else setMuted(result.data.mutes.some((mute) => mute.conversationId === conversationId));
    });
  }, [client, conversationId]);
  async function toggle(): Promise<void> {
    const result = muted
      ? await client.moderation.unmuteConversation({ conversationId })
      : await client.moderation.muteConversation({ conversationId });
    if (result.error !== null) setError(result.error.message);
    else setMuted(!muted);
  }
  return (
    <span className="chatpack-ui-mute-toggle">
      <button type="button" aria-pressed={muted} onClick={() => void toggle()}>
        {muted ? "Unmute" : "Mute"}
      </button>
      {error !== null && <small role="alert">{error}</small>}
    </span>
  );
}

/** Lists and un-mutes viewer-scoped muted conversations. */
export function MutedList({
  renderUser = (id) => id,
}: {
  renderUser?: (userId: string) => ReactNode;
}) {
  const { client, userId } = useChatpackUI();
  const conversations = client.useConversations();
  const [mutes, setMutes] = useState<ClientConversationMute[]>([]);
  const load = useCallback(async () => {
    const result = await client.moderation.listMutedConversations();
    if (result.error === null) setMutes(result.data.mutes);
  }, [client]);
  useEffect(() => {
    void load();
  }, [load]);
  return (
    <ul className="chatpack-ui-management-list">
      {mutes.map((mute) => {
        const conversation = conversations.data?.conversations.find(
          (item) => item.id === mute.conversationId,
        );
        const title =
          conversation?.type === "group"
            ? (conversation.name ?? conversation.id)
            : renderUser(
                conversation?.participants.find((item) => item.userId !== userId)?.userId ??
                  mute.conversationId,
              );
        return (
          <li key={mute.conversationId}>
            <span>{title}</span>
            <button
              type="button"
              onClick={() =>
                void client.moderation
                  .unmuteConversation({ conversationId: mute.conversationId })
                  .then(load)
              }
            >
              Unmute
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/** Submits a report through the Chatpack moderation action. */
export function ReportDialog({
  targetType,
  targetId,
  onDone,
}: {
  targetType: ReportTargetType;
  targetId: string;
  onDone?: () => void;
}) {
  const { client } = useChatpackUI();
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void client.moderation
          .report({ targetType, targetId, reason: reason.trim() })
          .then((result) => {
            if (result.error !== null) setError(result.error.message);
            else {
              setReason("");
              onDone?.();
            }
          });
      }}
    >
      <textarea
        aria-label="Report reason"
        value={reason}
        onChange={(event) => setReason(event.target.value)}
        required
      />
      {error !== null && <p role="alert">{error}</p>}
      <button type="submit" disabled={reason.trim() === ""}>
        Report
      </button>
    </form>
  );
}

/** Lists and updates moderator report lifecycle state through Chatpack actions. */
export function ModerationQueue() {
  const { client } = useChatpackUI();
  const [status, setStatus] = useState<ReportStatus>("open");
  const [reports, setReports] = useState<ClientModerationReport[]>([]);
  const load = useCallback(async () => {
    const result = await client.moderation.listReports({ status });
    if (result.error === null) setReports(result.data.reports);
  }, [client, status]);
  useEffect(() => {
    void load();
  }, [load]);
  return (
    <section className="chatpack-ui-management-card">
      <h3>Report queue</h3>
      <select
        value={status}
        onChange={(event) => setStatus(event.target.value as ReportStatus)}
        aria-label="Report status"
      >
        <option value="open">Open</option>
        <option value="triaged">Triaged</option>
        <option value="resolved">Resolved</option>
        <option value="dismissed">Dismissed</option>
      </select>
      <ul>
        {reports.map((report) => (
          <li key={report.id}>
            <span>
              {report.reason} · {report.targetType}
            </span>
            {(["open", "triaged", "resolved", "dismissed"] as const)
              .filter((next) => next !== report.status)
              .map((next) => (
                <button
                  key={next}
                  type="button"
                  onClick={() =>
                    void client.moderation
                      .updateReport({ reportId: report.id, status: next })
                      .then(load)
                  }
                >
                  Mark {next}
                </button>
              ))}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Lists, creates, and revokes moderator bans through Chatpack actions. */
export function BanManager() {
  const { client } = useChatpackUI();
  const [bans, setBans] = useState<ClientUserBan[]>([]);
  const [target, setTarget] = useState("");
  const load = useCallback(async () => {
    const result = await client.moderation.listBans({ activeOnly: true });
    if (result.error === null) setBans(result.data.bans);
  }, [client]);
  useEffect(() => {
    void load();
  }, [load]);
  return (
    <section className="chatpack-ui-management-card">
      <h3>Bans</h3>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const id = target.trim();
          if (id !== "")
            void client.moderation.banUser({ targetUserId: id }).then((result) => {
              if (result.error === null) {
                setTarget("");
                return load();
              }
            });
        }}
      >
        <input
          value={target}
          onChange={(event) => setTarget(event.target.value)}
          aria-label="User id to ban"
          placeholder="User id"
        />
        <button type="submit" disabled={target.trim() === ""}>
          Ban
        </button>
      </form>
      <ul>
        {bans.map((ban) => (
          <li key={ban.id}>
            <span>{ban.userId}</span>
            <button
              type="button"
              onClick={() => void client.moderation.unbanUser({ banId: ban.id }).then(load)}
            >
              Revoke
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Filepack-backed attachment reference stored in message metadata. */
export type ChatAttachment = FileAttachmentReference;

/** Reads only validated Filepack attachment references from message metadata. */
export function readAttachments(metadata: Record<string, unknown>): readonly ChatAttachment[] {
  try {
    return parseFileAttachmentMetadata(metadata)?.filepack.attachments ?? [];
  } catch {
    return [];
  }
}

/** Filepack resolver supplied by the host's configured {@link @chatpack/file} client. */
export interface ChatpackAttachmentResolver {
  /** Resolves an authorized, short-lived rendering target. */
  resolveTarget(input: { conversationId: string; fileId: string }): Promise<ResolvedFileAttachment>;
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
export function MessageAttachments({
  conversationId,
  attachments,
  resolver,
}: {
  conversationId: string;
  attachments: readonly ChatAttachment[];
  resolver: ChatpackAttachmentResolver;
}) {
  return (
    <ul className="chatpack-ui-attachments">
      {attachments.map((attachment) => (
        <li key={attachment.id}>
          {attachment.contentType.startsWith("image/") ? (
            <ImageBubble
              conversationId={conversationId}
              attachment={attachment}
              resolver={resolver}
            />
          ) : (
            <FileBubble
              conversationId={conversationId}
              attachment={attachment}
              resolver={resolver}
            />
          )}
        </li>
      ))}
    </ul>
  );
}

/** Resolves and displays an authorized image attachment. */
export function ImageBubble({
  conversationId,
  attachment,
  resolver,
}: {
  conversationId: string;
  attachment: ChatAttachment;
  resolver: ChatpackAttachmentResolver;
}) {
  const [resolved, setResolved] = useState<ResolvedFileAttachment | null>(null);
  useEffect(() => {
    let cancelled = false;
    void resolver
      .resolveTarget({ conversationId, fileId: attachment.id })
      .then((result) => {
        if (!cancelled) setResolved(result);
      })
      .catch(() => {
        if (!cancelled) setResolved({ status: "unavailable", fileId: attachment.id });
      });
    return () => {
      cancelled = true;
    };
  }, [attachment.id, conversationId, resolver]);
  if (resolved === null) return <LoadingState label={attachment.name} />;
  if (resolved.status === "unavailable") return <UnavailableAttachment name={attachment.name} />;
  return <img src={resolved.url} alt={attachment.name} />;
}

/** Resolves and displays an authorized downloadable file attachment. */
export function FileBubble({
  conversationId,
  attachment,
  resolver,
}: {
  conversationId: string;
  attachment: ChatAttachment;
  resolver: ChatpackAttachmentResolver;
}) {
  const [resolved, setResolved] = useState<ResolvedFileAttachment | null>(null);
  useEffect(() => {
    let cancelled = false;
    void resolver
      .resolveTarget({ conversationId, fileId: attachment.id })
      .then((result) => {
        if (!cancelled) setResolved(result);
      })
      .catch(() => {
        if (!cancelled) setResolved({ status: "unavailable", fileId: attachment.id });
      });
    return () => {
      cancelled = true;
    };
  }, [attachment.id, conversationId, resolver]);
  if (resolved === null) return <LoadingState label={attachment.name} />;
  if (resolved.status === "unavailable") return <UnavailableAttachment name={attachment.name} />;
  return (
    <a href={resolved.url} download={attachment.name}>
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
export function AttachmentGallery({
  conversationId,
  attachments,
  resolver,
}: {
  conversationId: string;
  attachments: readonly ChatAttachment[];
  resolver: ChatpackAttachmentResolver;
}) {
  return (
    <div>
      {attachments.map((attachment) => (
        <ImageBubble
          key={attachment.id}
          conversationId={conversationId}
          attachment={attachment}
          resolver={resolver}
        />
      ))}
    </div>
  );
}

/** Displays an attachment whose URL is unavailable. */
export function UnavailableAttachment({ name = "Attachment" }: { name?: string }) {
  return <span role="status">{name} unavailable</span>;
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
export function UserAvatar({
  userId,
  label,
  online = false,
  size = "md",
}: {
  userId: string;
  label?: ReactNode;
  online?: boolean;
  size?: "sm" | "md" | "lg";
}) {
  const text = label ?? userId;
  const initials = String(text).slice(0, 2).toUpperCase();
  return (
    <span className={`chatpack-ui-avatar chatpack-ui-avatar-${size}`} aria-label={userId}>
      {initials}
      {online && <span className="chatpack-ui-avatar-online" aria-label="Online" />}
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
export function MentionChip({
  userId,
  label,
  highlighted = false,
}: {
  userId: string;
  label?: ReactNode;
  highlighted?: boolean;
}) {
  const { renderUser } = useChatpackUI();
  return (
    <span className={highlighted ? "chatpack-ui-mention-highlight" : "chatpack-ui-mention-chip"}>
      @{label ?? renderUser(userId)}
    </span>
  );
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
export function EmptyInbox({
  title = "No conversations yet",
  description = "Start a DM or create a group — your inbox will fill in here.",
  action,
}: {
  title?: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="chatpack-ui-empty-inbox">
      <EmptyState>{title}</EmptyState>
      <p>{description}</p>
      {action}
    </div>
  );
}

/** Presents a small fixed emoji set for reaction pickers. */
export function EmojiPicker({
  onPick,
  emojis = ["👍", "❤️", "🎉", "😂", "😮", "😢"],
}: {
  onPick: (emoji: string) => void;
  emojis?: readonly string[];
}) {
  return (
    <div role="listbox" aria-label="Emoji picker">
      {emojis.map((emoji) => (
        <button type="button" key={emoji} onClick={() => onPick(emoji)}>
          {emoji}
        </button>
      ))}
    </div>
  );
}
