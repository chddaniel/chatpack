import type { ChatClientPlugin } from "../plugin";
import type { ChatClientResult } from "../errors";
import type { ClientPresence, ClientPresenceResponse } from "../wire";

export type PresenceSnapshot = Record<string, ClientPresence>;

export interface PresenceActions {
  get(input: { userIds: string[] }): Promise<ChatClientResult<ClientPresenceResponse>>;
}

function isPresence(value: unknown): value is ClientPresence {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.online === "boolean" &&
    (record.lastSeenAt === null || typeof record.lastSeenAt === "string")
  );
}

function readPresencePayload(value: Record<string, unknown>): ClientPresence | null {
  const presence = {
    online: value.online,
    lastSeenAt: value.lastSeenAt,
  };
  return isPresence(presence) ? presence : null;
}

export function presenceClient(): ChatClientPlugin<"presence", PresenceActions, PresenceSnapshot> {
  return {
    id: "presence",
    eventTypes: ["presence.online", "presence.offline"],
    create(context) {
      const state = context.createStore<PresenceSnapshot>({});
      const unsubscribeOnline = context.realtime.on("presence.online", (event) => {
        if (!("ephemeral" in event)) return;
        const presence = readPresencePayload(event.payload);
        if (presence === null) return;
        state.update((current) => ({
          ...current,
          [event.senderId]: {
            ...presence,
          },
        }));
      });
      const unsubscribeOffline = context.realtime.on("presence.offline", (event) => {
        if (!("ephemeral" in event)) return;
        const lastSeenAt = event.payload.lastSeenAt;
        state.update((current) => ({
          ...current,
          [event.senderId]: {
            online: false,
            lastSeenAt: typeof lastSeenAt === "string" ? lastSeenAt : null,
          },
        }));
      });

      return {
        actions: {
          async get(input) {
            const result = await context.request<ClientPresenceResponse>("/presence", {
              query: { userIds: input.userIds.join(",") },
            });
            if (result.error === null) state.set(result.data.presence);
            return result;
          },
        },
        state,
        dispose() {
          unsubscribeOnline();
          unsubscribeOffline();
        },
      };
    },
  };
}
