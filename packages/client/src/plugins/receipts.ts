import type { ChatClientPlugin } from "../plugin";

export interface ReceiptState {
  deliveredSeq?: number;
  readMessageId?: string;
}

export type ReceiptSnapshot = Record<string, ReceiptState>;

function numberValue(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function receiptsClient(): ChatClientPlugin<
  "receipts",
  Record<never, never>,
  ReceiptSnapshot
> {
  return {
    id: "receipts",
    eventTypes: ["receipt.delivered", "receipt.read"],
    create(context) {
      const state = context.createStore<ReceiptSnapshot>({});
      const unsubscribeDelivered = context.realtime.on("receipt.delivered", (event) => {
        if (!("ephemeral" in event) || event.conversationId === undefined) return;
        const seq = event.payload.seq;
        if (!numberValue(seq)) return;
        state.update((current) => ({
          ...current,
          [event.conversationId!]: {
            ...current[event.conversationId!],
            deliveredSeq: Math.max(current[event.conversationId!]?.deliveredSeq ?? 0, seq),
          },
        }));
      });
      const unsubscribeRead = context.realtime.on("receipt.read", (event) => {
        if (!("ephemeral" in event) || event.conversationId === undefined) return;
        const messageId = event.payload.messageId;
        if (typeof messageId !== "string") return;
        state.update((current) => ({
          ...current,
          [event.conversationId!]: {
            ...current[event.conversationId!],
            readMessageId: messageId,
          },
        }));
      });

      return {
        actions: {},
        state,
        dispose() {
          unsubscribeDelivered();
          unsubscribeRead();
        },
      };
    },
  };
}
