/**
 * Typing indicators — the `typing()` plugin.
 *
 * Adds one route:
 *
 * | Method | Path                         | Body                     |
 * | ------ | ---------------------------- | ------------------------ |
 * | POST   | `/conversations/:id/typing`  | `{ isTyping?: boolean }` |
 *
 * Publishes an ephemeral `typing.started` / `typing.stopped` event to the
 * *other* participant (never echoed back to the typist). Nothing is stored.
 *
 * The plugin is stateless by design. Client conventions (documented in the
 * README): throttle `isTyping: true` to at most one POST every few seconds
 * while the user types, and clear the indicator locally if no new
 * `typing.started` arrives within ~5 seconds — so a client that disappears
 * mid-keystroke never leaves a stuck "is typing…".
 *
 * @module
 */

import { ChatpackError } from "../errors";
import type { ChatpackPlugin, PluginRequestContext } from "../plugin";

function json(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/** Create the typing-indicator plugin. */
export function typing(): ChatpackPlugin {
  async function handleTyping(
    ctx: PluginRequestContext,
    conversationId: string,
  ): Promise<Response> {
    // Reuses core permissions: getConversation throws CONVERSATION_NOT_FOUND /
    // FORBIDDEN_READ, which the handler maps to the usual JSON errors.
    const conversation = await ctx.api.getConversation({
      userId: ctx.userId,
      conversationId,
    });

    let isTyping = true;
    const raw = await ctx.request.text();
    if (raw.trim() !== "") {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new ChatpackError("INVALID_INPUT", "Request body must be a JSON object.");
      }
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new ChatpackError("INVALID_INPUT", "Request body must be a JSON object.");
      }
      const value = (parsed as Record<string, unknown>)["isTyping"];
      if (value !== undefined && typeof value !== "boolean") {
        throw new ChatpackError("INVALID_INPUT", `"isTyping" must be a boolean.`);
      }
      isTyping = value ?? true;
    }

    const recipientIds = conversation.participants
      .map((p) => p.userId)
      .filter((id) => id !== ctx.userId);

    ctx.publishEphemeral({
      type: isTyping ? "typing.started" : "typing.stopped",
      conversationId: conversation.id,
      senderId: ctx.userId,
      recipientIds,
      payload: { isTyping },
    });

    return json(200, { ok: true });
  }

  return {
    name: "typing",
    handleRequest(ctx) {
      if (
        ctx.method === "POST" &&
        ctx.segments.length === 3 &&
        ctx.segments[0] === "conversations" &&
        ctx.segments[2] === "typing"
      ) {
        return handleTyping(ctx, ctx.segments[1]!);
      }
      return null;
    },
  };
}
