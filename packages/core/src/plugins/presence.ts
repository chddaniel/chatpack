/**
 * Presence — the `presence()` plugin.
 *
 * The SSE connection **is** the heartbeat: no extra ping endpoint. The plugin
 * counts open streams per user (multi-tab safe) and, on 0↔1 transitions,
 * publishes ephemeral `presence.online` / `presence.offline` events to that
 * user's conversation partners.
 *
 * Adds one route:
 *
 * | Method | Path                        | Returns                                        |
 * | ------ | --------------------------- | ---------------------------------------------- |
 * | GET    | `/presence?userIds=a,b`     | `{ presence: { [id]: { online, lastSeenAt } } }` |
 *
 * Snapshots are restricted to users the caller shares a conversation with —
 * you can't probe the presence of strangers.
 *
 * State is in-memory and **single-node**, exactly like the default SSE
 * transport (MVP §5): every server process sees only its own connections.
 *
 * @module
 */

import { ChatpackError } from "../errors";
import type { ChatpackPlugin, PluginContext, PluginRequestContext } from "../plugin";

/** Options for {@link presence}. */
export interface PresenceOptions {
  /**
   * How long to wait after a user's last stream closes before declaring them
   * offline, in milliseconds. Absorbs the flap of `EventSource` auto-reconnects
   * (drop + reconnect within a few seconds) so partners don't see the online
   * dot blink. Default: 5000. Set to 0 to publish offline immediately.
   */
  offlineDelayMs?: number;
}

interface PresenceEntry {
  connections: number;
  lastSeenAt: Date;
  offlineTimer?: ReturnType<typeof setTimeout>;
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

/** Create the presence plugin. */
export function presence(options: PresenceOptions = {}): ChatpackPlugin {
  const offlineDelayMs = options.offlineDelayMs ?? 5000;
  const entries = new Map<string, PresenceEntry>();

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

  function publishTransition(ctx: PluginContext, userId: string, online: boolean): void {
    const lastSeenAt = entries.get(userId)?.lastSeenAt ?? new Date();
    // Hooks are sync; the partner lookup is async, so it runs fire-and-forget
    // and must swallow its own failures — presence must never break a stream.
    void partnerIdsOf(ctx, userId)
      .then((recipientIds) => {
        if (recipientIds.length === 0) return;
        ctx.publishEphemeral({
          type: online ? "presence.online" : "presence.offline",
          senderId: userId,
          recipientIds,
          payload: { online, lastSeenAt: lastSeenAt.toISOString() },
        });
      })
      .catch((err) => console.error("chatpack: presence transition failed", err));
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

    // No presence leaks: only yourself and users you share a conversation with.
    const allowed = new Set(await partnerIdsOf(ctx, ctx.userId));
    allowed.add(ctx.userId);

    const result: Record<string, { online: boolean; lastSeenAt: string | null }> = {};
    for (const id of requested) {
      if (!allowed.has(id)) continue;
      const entry = entries.get(id);
      result[id] = {
        online: entry !== undefined && entry.connections > 0,
        lastSeenAt: entry?.lastSeenAt.toISOString() ?? null,
      };
    }
    return json(200, { presence: result });
  }

  return {
    name: "presence",

    onStreamOpen(ctx) {
      const entry = entries.get(ctx.userId) ?? { connections: 0, lastSeenAt: new Date() };
      entry.connections += 1;
      entry.lastSeenAt = new Date();
      if (entry.offlineTimer !== undefined) {
        // Reconnected within the grace period: cancel the pending offline.
        clearTimeout(entry.offlineTimer);
        delete entry.offlineTimer;
        entries.set(ctx.userId, entry);
        return;
      }
      entries.set(ctx.userId, entry);
      if (entry.connections === 1) publishTransition(ctx, ctx.userId, true);
    },

    onStreamClose(ctx) {
      const entry = entries.get(ctx.userId);
      if (!entry) return;
      entry.connections = Math.max(0, entry.connections - 1);
      entry.lastSeenAt = new Date();
      if (entry.connections > 0) return;

      const goOffline = (): void => {
        delete entry.offlineTimer;
        if (entry.connections === 0) publishTransition(ctx, ctx.userId, false);
      };
      if (offlineDelayMs <= 0) {
        goOffline();
        return;
      }
      entry.offlineTimer = setTimeout(goOffline, offlineDelayMs);
      // Never keep a Node process alive just to say someone left.
      if (typeof entry.offlineTimer === "object" && "unref" in entry.offlineTimer) {
        entry.offlineTimer.unref();
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
