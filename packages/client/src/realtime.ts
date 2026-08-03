/** EventSource-backed realtime transport and event contracts. */
import type { ChatpackEventSource, EventSourceFactory } from "./config";
import { createClientError, type ChatpackClientError } from "./errors";
import { createStore, type ReadonlyStore, type Store } from "./store";
import type { ClientMessage } from "./wire";

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

/** Ephemeral plugin event delivered by the Chatpack stream. */
export interface EphemeralChatEvent {
  type: string;
  ephemeral: true;
  conversationId?: string;
  senderId: string;
  payload: Record<string, unknown>;
  at: string;
}

/** Union of durable core events, reaction events, and ephemeral plugin events. */
export type ChatpackEvent = DurableChatEvent | ReactionChatEvent | EphemeralChatEvent;

/**
 * True for the two reaction events (ADR 0013), mirroring `isReactionEvent` on
 * the server. A predicate rather than an inline `type ===` check because each
 * member of `ChatpackEvent` has a *union* of literal types for `type`, which
 * TypeScript cannot use to eliminate a member from the union.
 */
export function isReactionChatEvent(event: ChatpackEvent): event is ReactionChatEvent {
  return event.type === "reaction.added" || event.type === "reaction.removed";
}
/** Lifecycle states for the realtime stream. */
export type ChatRealtimeStatus = "idle" | "connecting" | "open" | "closed";

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
}): ChatRealtime {
  const snapshot: Store<ChatRealtimeSnapshot> = createStore({ status: "idle", error: null });
  const listeners = new Set<(event: ChatpackEvent) => void>();
  const typedListeners = new Map<string, Set<(event: ChatpackEvent) => void>>();
  let source: ChatpackEventSource | null = null;

  const emit = (event: ChatpackEvent): void => {
    options.onEvent(event);
    for (const listener of listeners) listener(event);
    for (const listener of typedListeners.get(event.type) ?? []) listener(event);
  };
  const handleEvent = (rawEvent: Event): void => {
    const event = parseEvent(rawEvent);
    if (event !== null) emit(event);
  };
  const connect = (): void => {
    if (source !== null && source.readyState !== CLOSED) return;
    snapshot.set({ status: "connecting", error: null });
    try {
      source = options.eventSource(options.url, {
        withCredentials: options.credentials === "include",
      });
    } catch (cause) {
      // Runtimes without a global `EventSource` (SSR, older test renderers,
      // React Native) must not crash the component that mounted a hook -
      // report it as a stream error and stay closed.
      source = null;
      snapshot.set({
        status: "closed",
        error: createClientError(
          "NETWORK_ERROR",
          "Chatpack could not open a realtime connection: EventSource is unavailable in this runtime.",
          null,
          cause,
        ),
      });
      return;
    }
    const currentSource = source;
    source.onopen = () => {
      if (source !== currentSource) return;
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
      source?.close();
      source = null;
      snapshot.set({ status: "closed", error: null });
    },
  };
}
