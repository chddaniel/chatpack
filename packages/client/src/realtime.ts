/** EventSource-backed realtime transport and event contracts. */
import type { ChatRealtimeMode, ChatpackEventSource, EventSourceFactory } from "./config";
import { createClientError, type ChatpackClientError } from "./errors";
import { createPoller, DEFAULT_POLL_INTERVAL_MS } from "./polling";
import { createStore, type ReadonlyStore, type Store } from "./store";
import type { ClientConversationSnapshot, ClientMessage } from "./wire";

/** Durable message event delivered by the Chatpack stream. */
export interface DurableChatEvent {
  type: "message.created" | "message.updated" | "message.deleted";
  conversationId: string;
  message: ClientMessage;
}

/**
 * Durable reaction event delivered by the Chatpack stream (ADR 0013).
 *
 * Carries the message's **complete** reaction set, never a delta, so applying
 * the same event twice is harmless. Not gap-filled on reconnect: reactions have
 * no `seq`, so a client that was offline recovers them by refetching.
 */
export interface ReactionChatEvent {
  type: "reaction.added" | "reaction.removed";
  conversationId: string;
  /** Who added or removed the reaction. */
  actorId: string;
  /** The reaction key that changed. */
  emoji: string;
  message: ClientMessage;
}

/**
 * Durable membership or metadata event delivered by the Chatpack stream
 * (ADR 0017): someone was added, removed (or left), a role changed, or the
 * group was renamed.
 *
 * Carries the **full post-change conversation** (participants included), so
 * applying the same event twice is harmless. Like reactions it is not
 * gap-filled on reconnect: a membership change allocates no `seq`, so a client
 * that was offline recovers by refetching the conversation.
 *
 * `participant.removed` is also delivered to the removed user themselves - it
 * is the only signal telling their client to drop the conversation.
 */
export interface ConversationChatEvent {
  type: "participant.added" | "participant.removed" | "conversation.updated";
  conversationId: string;
  /** Who performed the change (an admin, or the leaver themselves). */
  actorId: string;
  /**
   * The users the change was about: those added, removed, or whose role
   * changed. Empty for a rename - that change is visible in
   * `conversation.name`.
   */
  affectedUserIds: string[];
  /** Full conversation snapshot after the change. No `unreadCount` - see {@link ClientConversationSnapshot}. */
  conversation: ClientConversationSnapshot;
}

/** Ephemeral plugin event delivered by the Chatpack stream. */
export interface EphemeralChatEvent {
  type: string;
  ephemeral: true;
  conversationId?: string;
  senderId: string;
  payload: Record<string, unknown>;
  at: string;
}

/** Union of durable core events, reaction events, conversation events, and ephemeral plugin events. */
export type ChatpackEvent =
  DurableChatEvent | ReactionChatEvent | ConversationChatEvent | EphemeralChatEvent;

/**
 * True for the two reaction events (ADR 0013), mirroring `isReactionEvent` on
 * the server. A predicate rather than an inline `type ===` check because each
 * member of `ChatpackEvent` has a *union* of literal types for `type`, which
 * TypeScript cannot use to eliminate a member from the union.
 */
export function isReactionChatEvent(event: ChatpackEvent): event is ReactionChatEvent {
  return event.type === "reaction.added" || event.type === "reaction.removed";
}

/**
 * True for the three membership/metadata events (ADR 0017), mirroring
 * `isConversationEvent` on the server. A predicate for the same reason
 * {@link isReactionChatEvent} is one.
 */
export function isConversationChatEvent(event: ChatpackEvent): event is ConversationChatEvent {
  return (
    event.type === "participant.added" ||
    event.type === "participant.removed" ||
    event.type === "conversation.updated"
  );
}
/**
 * Lifecycle states for the realtime connection.
 *
 * `polling` means durable data is being kept fresh by interval refetch instead
 * of a stream (`docs/decisions/0016`) - the data is live, but typing/presence/
 * receipts are unavailable, so it deserves a distinct state rather than being
 * reported as `open` or `closed`.
 */
export type ChatRealtimeStatus = "idle" | "connecting" | "open" | "closed" | "polling";

/** Observable realtime connection state. */
export interface ChatRealtimeSnapshot {
  status: ChatRealtimeStatus;
  error: ChatpackClientError | null;
}

/** Controls one lazy EventSource connection owned by a client. */
export interface ChatRealtime extends ReadonlyStore<ChatRealtimeSnapshot> {
  connect(): void;
  disconnect(): void;
  subscribe(listener: (event: ChatpackEvent) => void): () => void;
  subscribeStatus(listener: () => void): () => void;
  on(type: string, listener: (event: ChatpackEvent) => void): () => void;
  /**
   * Run one polling refresh now, regardless of mode or interval. Exposed for
   * tests and for hosts that want a manual "check for new messages" action;
   * a no-op when no `onPoll` was supplied.
   */
  pollNow(): Promise<void>;
}

const OPEN = 1;
const CLOSED = 2;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMessage(value: unknown): value is ClientMessage {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    typeof value.conversationId === "string" &&
    typeof value.senderId === "string" &&
    typeof value.body === "string" &&
    typeof value.role === "string" &&
    typeof value.seq === "number"
  );
}

function isConversationSnapshot(value: unknown): value is ClientConversationSnapshot {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    typeof value.type === "string" &&
    Array.isArray(value.participants) &&
    value.participants.every(
      (participant: unknown) =>
        isRecord(participant) &&
        typeof participant.userId === "string" &&
        typeof participant.role === "string",
    )
  );
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function parseEvent(event: Event): ChatpackEvent | null {
  if (!("data" in event) || typeof event.data !== "string") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(event.data) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(parsed) || typeof parsed.type !== "string") return null;

  if (parsed.ephemeral === true) {
    if (
      typeof parsed.senderId !== "string" ||
      typeof parsed.at !== "string" ||
      !isRecord(parsed.payload)
    ) {
      return null;
    }
    return {
      type: parsed.type,
      ephemeral: true,
      ...(typeof parsed.conversationId === "string"
        ? { conversationId: parsed.conversationId }
        : {}),
      senderId: parsed.senderId,
      payload: parsed.payload,
      at: parsed.at,
    };
  }

  if (
    parsed.type === "participant.added" ||
    parsed.type === "participant.removed" ||
    parsed.type === "conversation.updated"
  ) {
    if (
      typeof parsed.conversationId !== "string" ||
      typeof parsed.actorId !== "string" ||
      !isStringArray(parsed.affectedUserIds) ||
      !isConversationSnapshot(parsed.conversation)
    ) {
      return null;
    }
    return {
      type: parsed.type,
      conversationId: parsed.conversationId,
      actorId: parsed.actorId,
      affectedUserIds: parsed.affectedUserIds,
      conversation: parsed.conversation,
    };
  }

  if (parsed.type === "reaction.added" || parsed.type === "reaction.removed") {
    if (
      typeof parsed.conversationId !== "string" ||
      typeof parsed.actorId !== "string" ||
      typeof parsed.emoji !== "string" ||
      !isMessage(parsed.message)
    ) {
      return null;
    }
    return {
      type: parsed.type,
      conversationId: parsed.conversationId,
      actorId: parsed.actorId,
      emoji: parsed.emoji,
      message: parsed.message,
    };
  }

  if (
    parsed.type !== "message.created" &&
    parsed.type !== "message.updated" &&
    parsed.type !== "message.deleted"
  ) {
    return null;
  }
  if (typeof parsed.conversationId !== "string" || !isMessage(parsed.message)) return null;
  return {
    type: parsed.type,
    conversationId: parsed.conversationId,
    message: parsed.message,
  };
}

function streamStatus(source: ChatpackEventSource): ChatRealtimeStatus {
  if (source.readyState === OPEN) return "open";
  if (source.readyState === CLOSED) return "closed";
  return "connecting";
}

/** Creates a realtime controller for a Chatpack stream URL. */
export function createRealtime(options: {
  url: string;
  credentials: RequestCredentials;
  eventSource: EventSourceFactory;
  eventTypes: readonly string[];
  onEvent: (event: ChatpackEvent) => void;
  /**
   * Mode from `ChatClientOptions.realtime` (`docs/decisions/0016`). `sse` is
   * the default here so a directly-constructed controller keeps its old
   * behaviour; `createChatClient` passes the user's choice through.
   */
  mode?: ChatRealtimeMode;
  /**
   * Refetches everything the stream would have delivered. Supplied by
   * `createChatClient`; when omitted this controller is stream-only whatever
   * the mode says, because there is nothing to poll.
   *
   * Must never reject - the poller has no way to report an error, and a
   * rejection would take the timer down with it.
   */
  onPoll?: () => Promise<void>;
  /** Poll interval in ms. Clamped to `MIN_POLL_INTERVAL_MS`. */
  pollIntervalMs?: number;
}): ChatRealtime {
  const mode = options.mode ?? "sse";
  const snapshot: Store<ChatRealtimeSnapshot> = createStore({ status: "idle", error: null });
  const listeners = new Set<(event: ChatpackEvent) => void>();
  const typedListeners = new Map<string, Set<(event: ChatpackEvent) => void>>();
  let source: ChatpackEventSource | null = null;
  /** `false` until `disconnect()`, so a late poll tick cannot revive a closed client. */
  let wanted = false;

  const emit = (event: ChatpackEvent): void => {
    options.onEvent(event);
    for (const listener of listeners) listener(event);
    for (const listener of typedListeners.get(event.type) ?? []) listener(event);
  };
  const handleEvent = (rawEvent: Event): void => {
    const event = parseEvent(rawEvent);
    if (event !== null) emit(event);
  };

  const onPoll = options.onPoll;
  const canPoll = onPoll !== undefined && mode !== "sse";
  const poller =
    onPoll === undefined
      ? null
      : createPoller({
          intervalMs: options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
          onTick: onPoll,
        });

  /**
   * Take over from the stream. Polling reports its own status so a host can
   * tell the user typing indicators are unavailable rather than broken - but it
   * keeps whatever error put us here, because that error is why.
   */
  const startPolling = (error: ChatpackClientError | null): void => {
    if (!canPoll || !wanted) return;
    poller?.start();
    snapshot.set({ status: "polling", error });
  };
  const stopPolling = (): void => {
    poller?.stop();
  };

  const connect = (): void => {
    wanted = true;
    // `poll` mode never opens a stream, so the failed attempt - and the seconds
    // of staleness it costs on a platform that cannot hold one - is skipped.
    if (mode === "poll") {
      startPolling(null);
      return;
    }
    if (source !== null && source.readyState !== CLOSED) return;
    snapshot.set({ status: "connecting", error: null });
    try {
      source = options.eventSource(options.url, {
        withCredentials: options.credentials === "include",
      });
    } catch (cause) {
      // Runtimes without a global `EventSource` (SSR, older test renderers,
      // React Native) must not crash the component that mounted a hook -
      // report it as a stream error and, where allowed, poll instead.
      source = null;
      const error = createClientError(
        "NETWORK_ERROR",
        "Chatpack could not open a realtime connection: EventSource is unavailable in this runtime.",
        null,
        cause,
      );
      snapshot.set({ status: "closed", error });
      startPolling(error);
      return;
    }
    const currentSource = source;
    source.onopen = () => {
      if (source !== currentSource) return;
      // The stream is authoritative again: stop paying for polls, and drop the
      // error that caused the fallback so a host's "reconnecting" hint clears.
      stopPolling();
      snapshot.set({ status: "open", error: null });
    };
    source.onerror = () => {
      if (source !== currentSource) return;
      const error = createClientError(
        "NETWORK_ERROR",
        "Chatpack realtime connection failed.",
        null,
      );
      snapshot.set({ status: streamStatus(currentSource), error });
      // `EventSource` retries a dropped connection itself, so this is not
      // necessarily terminal - but the gap in delivery is real either way, and
      // `onopen` stands the poller back down the moment the retry lands.
      startPolling(error);
    };
    for (const type of options.eventTypes) source.addEventListener(type, handleEvent);
  };

  return {
    getSnapshot: snapshot.getSnapshot,
    subscribe(listener) {
      listeners.add(listener);
      connect();
      return () => listeners.delete(listener);
    },
    subscribeStatus(listener) {
      return snapshot.subscribe(listener);
    },
    on(type, listener) {
      const typeListeners = typedListeners.get(type) ?? new Set();
      typeListeners.add(listener);
      typedListeners.set(type, typeListeners);
      return () => {
        typeListeners.delete(listener);
        if (typeListeners.size === 0) typedListeners.delete(type);
      };
    },
    connect,
    disconnect() {
      wanted = false;
      stopPolling();
      source?.close();
      source = null;
      snapshot.set({ status: "closed", error: null });
    },
    async pollNow() {
      await onPoll?.();
    },
  };
}
