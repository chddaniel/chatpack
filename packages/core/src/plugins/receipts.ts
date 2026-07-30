/**
 * Live delivery / read ticks - the `receipts()` plugin.
 *
 * Two ephemeral signals, no routes:
 *
 * - `receipt.delivered` - sent to the **message sender** the moment a
 *   recipient's live SSE stream receives their `message.created` event
 *   (the instant ✓✓-while-both-online case). If the recipient is offline,
 *   no tick fires - durable state is what `lastReadMessageId` is for.
 * - `receipt.read` - sent to the **other participant** whenever a user
 *   durably updates their read-state via `POST /conversations/:id/read`.
 *
 * Both are at-least-once pings (a recipient with two tabs triggers two
 * delivered ticks): clients dedupe by `payload.messageId`. Durable read-state
 * stays in core, untouched - miss a tick and the truth is still in storage.
 *
 * @module
 */

import type { ChatpackPlugin } from "../plugin";

/** Create the delivery/read-tick plugin. */
export function receipts(): ChatpackPlugin {
  return {
    name: "receipts",

    onEventDelivered(ctx) {
      if (ctx.event.type !== "message.created") return;
      const message = ctx.event.message;
      // Your own stream receiving your own message is not a delivery.
      if (ctx.userId === message.senderId) return;

      ctx.publishEphemeral({
        type: "receipt.delivered",
        conversationId: ctx.event.conversationId,
        senderId: ctx.userId,
        recipientIds: [message.senderId],
        payload: { messageId: message.id, seq: message.seq },
      });
    },

    onMarkRead(ctx) {
      const recipientIds = ctx.recipientIds.filter((id) => id !== ctx.userId);
      if (recipientIds.length === 0) return;

      ctx.publishEphemeral({
        type: "receipt.read",
        conversationId: ctx.conversationId,
        senderId: ctx.userId,
        recipientIds,
        payload: { messageId: ctx.messageId },
      });
    },
  };
}
