/**
 * Presence - the `presence()` plugin.
 *
 * The SSE connection is the heartbeat. The default store is local and keeps
 * existing single-node behavior. A shared {@link PresenceStore} makes the
 * same plugin correct across multiple Chatpack processes.
 *
 * @module
 */

import { ChatpackError } from "../errors";
import type { ChatpackPlugin, PluginContext, PluginRequestContext } from "../plugin";

/** A user's current presence state. */
export interface PresenceState {
  /** Whether at least one live connection exists. */
  online: boolean;
  /** Last connection activity, or `null` when never observed. */
  lastSeenAt: Date | null;
}

/** Result of opening a presence connection. */
export interface PresenceOpenResult {
  /** State after the connection was opened. */
  state: PresenceState;
  /** Set only when this connection changed the user from offline to online. */
  transition: "online" | null;
}

/** Result of confirming a global offline transition. */
export interface PresenceFinalizeOfflineResult {
  /** State after all expired connections were removed. */
  state: PresenceState;
  /** Always `offline` when a pending transition is confirmed. */
  transition: "offline";
}

/** Result of closing a presence connection. */
export interface PresenceCloseResult {
  /** State after this connection was removed. */
  state: PresenceState;
  /** Token used to confirm delayed global offline. */
  offlineToken: string | null;
}

/** Input for {@link PresenceStore.open}. */
export interface PresenceOpenInput {
  userId: string;
  connectionId: string;
  now: Date;
  leaseTtlMs: number;
}

/** Input for {@link PresenceStore.heartbeat}. */
export interface PresenceHeartbeatInput {
  userId: string;
  connectionId: string;
  now: Date;
  leaseTtlMs: number;
}

/** Input for {@link PresenceStore.close}. */
export interface PresenceCloseInput {
  userId: string;
  connectionId: string;
  now: Date;
  offlineDelayMs: number;
}

/** Input for {@link PresenceStore.finalizeOffline}. */
export interface PresenceFinalizeOfflineInput {
  userId: string;
  token: string;
  now: Date;
}

/** Input for {@link PresenceStore.get}. */
export interface PresenceGetInput {
  userId: string;
  now: Date;
}

/**
 * Shared connection-state contract for multi-node presence implementations.
 *
 * Implementations must make open, heartbeat, close, and offline confirmation
 * atomic for one user. A heartbeat for an unknown connection must not recreate
 * it, and a delayed offline confirmation must not win after a new connection.
 */
export interface PresenceStore {
  /** Register or refresh one connection and report a global online transition. */
  open(input: PresenceOpenInput): Promise<PresenceOpenResult>;
  /** Renew one existing connection lease. */
  heartbeat(input: PresenceHeartbeatInput): Promise<void>;
  /** Remove one connection and return a token when delayed offline is needed. */
  close(input: PresenceCloseInput): Promise<PresenceCloseResult>;
  /** Confirm offline only when the token still owns the pending transition. */
  finalizeOffline(
    input: PresenceFinalizeOfflineInput,
  ): Promise<PresenceFinalizeOfflineResult | null>;
  /** Read one user's current state. */
  get(input: PresenceGetInput): Promise<PresenceState>;
}

/** Options for {@link presence}. */
export interface PresenceOptions {
  /**
   * Optional shared connection store. Omit for the default process-local store.
   */
  store?: PresenceStore;
  /**
   * How long to wait after a user's last stream closes before declaring them
   * offline, in milliseconds. Default: 5000.
   */
  offlineDelayMs?: number;
  /** Lease lifetime for shared stores. Default: 30000. */
  leaseTtlMs?: number;
}

interface LocalConnection {
  expiresAt: number;
}

interface LocalEntry {
  connections: Map<string, LocalConnection>;
  lastSeenAt: Date;
  pendingOfflineToken?: string;
}

/** Most conversation partners considered when fanning out a transition. */
const PARTNER_SCAN_LIMIT = 200;
/** Max user ids per GET /presence request. */
const MAX_SNAPSHOT_IDS = 50;

function json(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function token(): string {
  return `${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
}

function stateOf(entry: LocalEntry | undefined): PresenceState {
  return {
    online: entry !== undefined && entry.connections.size > 0,
    lastSeenAt: entry?.lastSeenAt ?? null,
  };
}

/** Reference store used when no shared store is configured. */
function localPresenceStore(): PresenceStore {
  const entries = new Map<string, LocalEntry>();

  function entryFor(userId: string, now: Date): LocalEntry {
    const entry = entries.get(userId) ?? { connections: new Map(), lastSeenAt: now };
    for (const [connectionId, connection] of entry.connections) {
      if (connection.expiresAt <= now.getTime()) entry.connections.delete(connectionId);
    }
    entries.set(userId, entry);
    return entry;
  }

  function existingEntry(userId: string, now: Date): LocalEntry | undefined {
    const entry = entries.get(userId);
    if (!entry) return undefined;
    for (const [connectionId, connection] of entry.connections) {
      if (connection.expiresAt <= now.getTime()) entry.connections.delete(connectionId);
    }
    return entry;
  }

  return {
    async open(input) {
      const entry = entryFor(input.userId, input.now);
      const wasOnline = entry.connections.size > 0;
      const wasPending = entry.pendingOfflineToken !== undefined;
      delete entry.pendingOfflineToken;
      entry.connections.set(input.connectionId, {
        expiresAt: input.now.getTime() + input.leaseTtlMs,
      });
      entry.lastSeenAt = input.now;
      return {
        state: stateOf(entry),
        transition: !wasOnline && !wasPending ? "online" : null,
      };
    },

    async heartbeat(input) {
      const entry = existingEntry(input.userId, input.now);
      if (!entry) return;
      const connection = entry.connections.get(input.connectionId);
      if (!connection) return;
      connection.expiresAt = input.now.getTime() + input.leaseTtlMs;
      entry.lastSeenAt = input.now;
    },

    async close(input) {
      const entry = existingEntry(input.userId, input.now);
      if (!entry) return { state: stateOf(undefined), offlineToken: null };
      if (!entry.connections.delete(input.connectionId)) {
        return { state: stateOf(entry), offlineToken: null };
      }
      entry.lastSeenAt = input.now;
      if (entry.connections.size > 0) {
        return { state: stateOf(entry), offlineToken: null };
      }
      const offlineToken = token();
      entry.pendingOfflineToken = offlineToken;
      return { state: stateOf(entry), offlineToken };
    },

    async finalizeOffline(input) {
      const entry = existingEntry(input.userId, input.now);
      if (!entry) return null;
      if (entry.pendingOfflineToken !== input.token || entry.connections.size > 0) return null;
      delete entry.pendingOfflineToken;
      return { state: stateOf(entry), transition: "offline" };
    },

    async get(input) {
      return stateOf(existingEntry(input.userId, input.now));
    },
  };
}

/** Create the presence plugin. */
export function presence(options: PresenceOptions = {}): ChatpackPlugin {
  const offlineDelayMs = options.offlineDelayMs ?? 5000;
  const leaseTtlMs = options.leaseTtlMs ?? 30_000;
  if (!Number.isFinite(offlineDelayMs) || offlineDelayMs < 0) {
    throw new Error("chatpack: presence offlineDelayMs must be a non-negative number.");
  }
  if (!Number.isFinite(leaseTtlMs) || leaseTtlMs <= 0) {
    throw new Error("chatpack: presence leaseTtlMs must be a positive number.");
  }

  const store = options.store ?? localPresenceStore();
  const heartbeatIntervalMs = Math.max(1000, Math.floor(leaseTtlMs / 3));
  const heartbeatTimers = new Map<string, ReturnType<typeof setInterval>>();
  const offlineTimers = new Map<string, ReturnType<typeof setTimeout>>();

  /** The user ids sharing a conversation with `userId` (first page, MVP-sized). */
  async function partnerIdsOf(ctx: PluginContext, userId: string): Promise<string[]> {
    const { conversations } = await ctx.api.listConversations({
      userId,
      limit: PARTNER_SCAN_LIMIT,
    });
    const partners = new Set<string>();
    for (const conversation of conversations) {
      for (const participant of conversation.participants) {
        if (participant.userId !== userId) partners.add(participant.userId);
      }
    }
    return [...partners];
  }

  function publishTransition(
    ctx: PluginContext,
    userId: string,
    transition: "online" | "offline",
    state: PresenceState,
  ): void {
    const lastSeenAt = state.lastSeenAt ?? new Date();
    void partnerIdsOf(ctx, userId)
      .then((recipientIds) => {
        if (recipientIds.length === 0) return;
        ctx.publishEphemeral({
          type: `presence.${transition}`,
          senderId: userId,
          recipientIds,
          payload: { online: transition === "online", lastSeenAt: lastSeenAt.toISOString() },
        });
      })
      .catch((err) => console.error("chatpack: presence transition failed", err));
  }

  function clearOfflineTimer(userId: string): void {
    const timer = offlineTimers.get(userId);
    if (timer === undefined) return;
    clearTimeout(timer);
    offlineTimers.delete(userId);
  }

  function scheduleOffline(ctx: PluginContext, userId: string, offlineToken: string): void {
    const finalize = (): void => {
      offlineTimers.delete(userId);
      void store
        .finalizeOffline({ userId, token: offlineToken, now: new Date() })
        .then((result) => {
          if (result?.transition === "offline") {
            publishTransition(ctx, userId, "offline", result.state);
          }
        })
        .catch((err) => console.error("chatpack: presence offline confirmation failed", err));
    };
    if (offlineDelayMs <= 0) {
      finalize();
      return;
    }
    const timer = setTimeout(finalize, offlineDelayMs);
    offlineTimers.set(userId, timer);
    if (typeof timer === "object" && "unref" in timer) timer.unref();
  }

  async function handleSnapshot(ctx: PluginRequestContext): Promise<Response> {
    const raw = ctx.url.searchParams.get("userIds");
    if (!raw || raw.trim() === "") {
      throw new ChatpackError("INVALID_INPUT", `"userIds" query parameter is required.`);
    }
    const requested = [...new Set(raw.split(",").map((id) => id.trim()))].filter((id) => id !== "");
    if (requested.length === 0 || requested.length > MAX_SNAPSHOT_IDS) {
      throw new ChatpackError(
        "INVALID_INPUT",
        `"userIds" must contain between 1 and ${MAX_SNAPSHOT_IDS} ids.`,
      );
    }

    const allowed = new Set(await partnerIdsOf(ctx, ctx.userId));
    allowed.add(ctx.userId);
    const result: Record<string, { online: boolean; lastSeenAt: string | null }> = {};
    for (const id of requested) {
      if (!allowed.has(id)) continue;
      const state = await store.get({ userId: id, now: new Date() });
      result[id] = {
        online: state.online,
        lastSeenAt: state.lastSeenAt?.toISOString() ?? null,
      };
    }
    return json(200, { presence: result });
  }

  return {
    name: "presence",

    async onStreamOpen(ctx) {
      clearOfflineTimer(ctx.userId);
      try {
        const result = await store.open({
          userId: ctx.userId,
          connectionId: ctx.connectionId,
          now: new Date(),
          leaseTtlMs,
        });
        const timer = setInterval(() => {
          void store
            .heartbeat({
              userId: ctx.userId,
              connectionId: ctx.connectionId,
              now: new Date(),
              leaseTtlMs,
            })
            .catch((err) => console.error("chatpack: presence heartbeat failed", err));
        }, heartbeatIntervalMs);
        heartbeatTimers.set(ctx.connectionId, timer);
        if (typeof timer === "object" && "unref" in timer) timer.unref();
        if (result.transition === "online") {
          publishTransition(ctx, ctx.userId, "online", result.state);
        }
      } catch (err) {
        console.error("chatpack: presence connection open failed", err);
      }
    },

    async onStreamClose(ctx) {
      const heartbeat = heartbeatTimers.get(ctx.connectionId);
      if (heartbeat !== undefined) clearInterval(heartbeat);
      heartbeatTimers.delete(ctx.connectionId);
      try {
        const result = await store.close({
          userId: ctx.userId,
          connectionId: ctx.connectionId,
          now: new Date(),
          offlineDelayMs,
        });
        if (result.offlineToken !== null) {
          clearOfflineTimer(ctx.userId);
          scheduleOffline(ctx, ctx.userId, result.offlineToken);
        }
      } catch (err) {
        console.error("chatpack: presence connection close failed", err);
      }
    },

    handleRequest(ctx) {
      if (ctx.method === "GET" && ctx.segments.length === 1 && ctx.segments[0] === "presence") {
        return handleSnapshot(ctx);
      }
      return null;
    },
  };
}
