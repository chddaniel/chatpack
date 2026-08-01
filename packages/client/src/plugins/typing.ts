/** First-party client plugin for ephemeral typing indicators. */
import type { ChatClientPlugin } from "../plugin";
import type { ChatClientResult } from "../errors";
import type { ClientOkResponse } from "../wire";

/** Sender and timestamp for the current typing indicator. */
export interface TypingIndicator {
  senderId: string;
  at: string;
}

/** Typing indicators keyed by conversation id. */
export type TypingSnapshot = Record<string, TypingIndicator | undefined>;

/** Input shared by the typing start and stop actions. */
export interface TypingInput {
  conversationId: string;
}

/** Actions exposed by the typing client plugin. */
export interface TypingActions {
  start(input: TypingInput): Promise<ChatClientResult<ClientOkResponse>>;
  stop(input: TypingInput): Promise<ChatClientResult<ClientOkResponse>>;
}

/** Configuration for typing indicator expiration. */
export interface TypingOptions {
  expireAfterMs?: number;
}

/** Creates the first-party typing client plugin. */
export function typingClient(
  options: TypingOptions = {},
): ChatClientPlugin<"typing", TypingActions, TypingSnapshot> {
  const expireAfterMs = options.expireAfterMs ?? 5000;
  return {
    id: "typing",
    eventTypes: ["typing.started", "typing.stopped"],
    create(context) {
      const state = context.createStore<TypingSnapshot>({});
      const timers = new Map<string, ReturnType<typeof setTimeout>>();
      const clearTimer = (conversationId: string): void => {
        const timer = timers.get(conversationId);
        if (timer !== undefined) clearTimeout(timer);
        timers.delete(conversationId);
      };
      const clearIndicator = (conversationId: string): void => {
        clearTimer(conversationId);
        state.update((current) => {
          if (!(conversationId in current)) return current;
          const next = { ...current };
          delete next[conversationId];
          return next;
        });
      };
      const unsubscribe = context.realtime.on("typing.started", (event) => {
        if (!("ephemeral" in event) || event.conversationId === undefined) return;
        clearTimer(event.conversationId);
        state.update((current) => ({
          ...current,
          [event.conversationId!]: { senderId: event.senderId, at: event.at },
        }));
        timers.set(
          event.conversationId,
          setTimeout(() => clearIndicator(event.conversationId!), expireAfterMs),
        );
      });
      const unsubscribeStopped = context.realtime.on("typing.stopped", (event) => {
        if ("ephemeral" in event && event.conversationId !== undefined) {
          clearIndicator(event.conversationId);
        }
      });
      const action = (input: TypingInput, isTyping: boolean) =>
        context.request<ClientOkResponse>(
          "/conversations/" + encodeURIComponent(input.conversationId) + "/typing",
          { method: "POST", body: { isTyping } },
        );

      return {
        actions: {
          start: (input) => action(input, true),
          stop: (input) => action(input, false),
        },
        state,
        dispose() {
          unsubscribe();
          unsubscribeStopped();
          for (const timer of timers.values()) clearTimeout(timer);
          timers.clear();
        },
      };
    },
  };
}
