/**
 * Message lifecycle hooks (docs/decisions/0011): `beforeMessageSend` can
 * block or rewrite a message before it persists; `afterMessageSend` reacts
 * after persistence. Both run for sends AND edits.
 */
import { describe, expect, it, vi } from "vitest";

import { ChatpackError, chatpack, type TransportEvent } from "@chatpack/core";
import { memoryAdapter } from "../src/index";

function createChat(options: Partial<Parameters<typeof chatpack>[0]> = {}) {
  return chatpack({ storage: memoryAdapter(), telemetry: false, ...options });
}

async function conversationBetween(chat: ReturnType<typeof chatpack>) {
  return chat.api.getOrCreateConversation({ userId: "alice", otherUserId: "bob" });
}

describe("beforeMessageSend - blocking", () => {
  it("a throwing hook rejects the message with MESSAGE_REJECTED", async () => {
    const chat = createChat({
      hooks: {
        beforeMessageSend: ({ body }) => {
          if (body.length > 10) throw new Error("Max 10 characters.");
        },
      },
    });
    const conversation = await conversationBetween(chat);

    await expect(
      chat.api.sendMessage({
        userId: "alice",
        conversationId: conversation.id,
        body: "way past the ten character limit",
      }),
    ).rejects.toMatchObject({ code: "MESSAGE_REJECTED", message: "Max 10 characters." });
  });

  it("nothing is persisted and nothing is broadcast for a rejected message", async () => {
    const events: TransportEvent[] = [];
    const chat = createChat({
      hooks: {
        beforeMessageSend: () => {
          throw new Error("nope");
        },
      },
    });
    chat.transport.subscribe((event) => events.push(event));
    const conversation = await conversationBetween(chat);

    await expect(
      chat.api.sendMessage({ userId: "alice", conversationId: conversation.id, body: "hi" }),
    ).rejects.toBeInstanceOf(ChatpackError);

    const { messages } = await chat.api.listMessages({
      userId: "alice",
      conversationId: conversation.id,
    });
    expect(messages).toEqual([]);
    expect(events).toEqual([]);
  });

  it("a thrown ChatpackError passes through with its own code", async () => {
    const chat = createChat({
      hooks: {
        beforeMessageSend: () => {
          throw new ChatpackError("FORBIDDEN_WRITE", "Muted until tomorrow.");
        },
      },
    });
    const conversation = await conversationBetween(chat);

    await expect(
      chat.api.sendMessage({ userId: "alice", conversationId: conversation.id, body: "hi" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN_WRITE", message: "Muted until tomorrow." });
  });

  it("runs after permissions - a non-participant is rejected before the hook sees anything", async () => {
    const hook = vi.fn();
    const chat = createChat({ hooks: { beforeMessageSend: hook } });
    const conversation = await conversationBetween(chat);

    await expect(
      chat.api.sendMessage({ userId: "mallory", conversationId: conversation.id, body: "hi" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN_WRITE" });
    expect(hook).not.toHaveBeenCalled();
  });
});

describe("beforeMessageSend - rewriting", () => {
  it("persists and broadcasts the rewritten body", async () => {
    const events: TransportEvent[] = [];
    const chat = createChat({
      hooks: {
        beforeMessageSend: ({ body }) => ({ body: body.replaceAll("darn", "****") }),
      },
    });
    chat.transport.subscribe((event) => events.push(event));
    const conversation = await conversationBetween(chat);

    const message = await chat.api.sendMessage({
      userId: "alice",
      conversationId: conversation.id,
      body: "darn it",
    });

    expect(message.body).toBe("**** it");
    const { messages } = await chat.api.listMessages({
      userId: "bob",
      conversationId: conversation.id,
    });
    expect(messages[0]?.body).toBe("**** it");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "message.created",
      message: { body: "**** it" },
    });
  });

  it("can rewrite metadata on send", async () => {
    const chat = createChat({
      hooks: {
        beforeMessageSend: ({ metadata }) => ({ metadata: { ...metadata, flagged: true } }),
      },
    });
    const conversation = await conversationBetween(chat);

    const message = await chat.api.sendMessage({
      userId: "alice",
      conversationId: conversation.id,
      body: "hi",
      metadata: { source: "web" },
    });
    expect(message.metadata).toEqual({ source: "web", flagged: true });
  });

  it("returning nothing accepts the message unchanged", async () => {
    const chat = createChat({ hooks: { beforeMessageSend: () => undefined } });
    const conversation = await conversationBetween(chat);

    const message = await chat.api.sendMessage({
      userId: "alice",
      conversationId: conversation.id,
      body: "untouched",
    });
    expect(message.body).toBe("untouched");
  });

  it("rewriting to an empty body is an INVALID_INPUT error, not a silent drop", async () => {
    const chat = createChat({ hooks: { beforeMessageSend: () => ({ body: "  " }) } });
    const conversation = await conversationBetween(chat);

    await expect(
      chat.api.sendMessage({ userId: "alice", conversationId: conversation.id, body: "hi" }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("receives the full context", async () => {
    const seen: unknown[] = [];
    const chat = createChat({
      hooks: {
        beforeMessageSend: (ctx) => {
          seen.push(ctx);
        },
      },
    });
    const conversation = await conversationBetween(chat);

    await chat.api.sendMessage({
      userId: "alice",
      conversationId: conversation.id,
      body: "hi",
      metadata: { a: 1 },
    });

    expect(seen[0]).toMatchObject({
      user: { id: "alice" },
      conversation: { id: conversation.id, participantIds: ["alice", "bob"] },
      body: "hi",
      metadata: { a: 1 },
      role: "user",
      action: "send",
    });
  });
});

describe("hooks on editMessage", () => {
  it('beforeMessageSend runs on edits with action: "edit"', async () => {
    const actions: string[] = [];
    const chat = createChat({
      hooks: {
        beforeMessageSend: ({ body, action }) => {
          actions.push(action);
          if (body.includes("darn")) throw new Error("Language.");
        },
      },
    });
    const conversation = await conversationBetween(chat);
    const message = await chat.api.sendMessage({
      userId: "alice",
      conversationId: conversation.id,
      body: "polite",
    });

    // The filter can't be dodged by editing the message afterwards.
    await expect(
      chat.api.editMessage({ userId: "alice", messageId: message.id, body: "darn" }),
    ).rejects.toMatchObject({ code: "MESSAGE_REJECTED", message: "Language." });
    expect(actions).toEqual(["send", "edit"]);

    const { messages } = await chat.api.listMessages({
      userId: "alice",
      conversationId: conversation.id,
    });
    expect(messages[0]?.body).toBe("polite");
  });

  it("rewrites apply to edited bodies too", async () => {
    const chat = createChat({
      hooks: {
        beforeMessageSend: ({ body }) => ({ body: body.toUpperCase() }),
      },
    });
    const conversation = await conversationBetween(chat);
    const message = await chat.api.sendMessage({
      userId: "alice",
      conversationId: conversation.id,
      body: "hi",
    });

    const edited = await chat.api.editMessage({
      userId: "alice",
      messageId: message.id,
      body: "bye",
    });
    expect(edited.body).toBe("BYE");
  });
});

describe("afterMessageSend", () => {
  it("fires after persistence with the stored message", async () => {
    const seen: unknown[] = [];
    const chat = createChat({
      hooks: {
        afterMessageSend: (ctx) => {
          seen.push(ctx);
        },
      },
    });
    const conversation = await conversationBetween(chat);

    const message = await chat.api.sendMessage({
      userId: "alice",
      conversationId: conversation.id,
      body: "hi",
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      action: "send",
      conversation: { id: conversation.id, participantIds: ["alice", "bob"] },
      // The persisted message - id and seq already assigned.
      message: { id: message.id, seq: message.seq, body: "hi" },
    });
  });

  it("sees the rewritten body, not the submitted one", async () => {
    const bodies: string[] = [];
    const chat = createChat({
      hooks: {
        beforeMessageSend: () => ({ body: "rewritten" }),
        afterMessageSend: ({ message }) => {
          bodies.push(message.body);
        },
      },
    });
    const conversation = await conversationBetween(chat);

    await chat.api.sendMessage({ userId: "alice", conversationId: conversation.id, body: "hi" });
    expect(bodies).toEqual(["rewritten"]);
  });

  it("does not fire when beforeMessageSend rejects", async () => {
    const after = vi.fn();
    const chat = createChat({
      hooks: {
        beforeMessageSend: () => {
          throw new Error("no");
        },
        afterMessageSend: after,
      },
    });
    const conversation = await conversationBetween(chat);

    await expect(
      chat.api.sendMessage({ userId: "alice", conversationId: conversation.id, body: "hi" }),
    ).rejects.toBeInstanceOf(ChatpackError);
    expect(after).not.toHaveBeenCalled();
  });

  it("a throwing after-hook never fails the send - the message is already durable", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const chat = createChat({
      hooks: {
        afterMessageSend: () => {
          throw new Error("side-effect exploded");
        },
      },
    });
    const conversation = await conversationBetween(chat);

    const message = await chat.api.sendMessage({
      userId: "alice",
      conversationId: conversation.id,
      body: "hi",
    });
    expect(message.body).toBe("hi");
    expect(errorLog).toHaveBeenCalledWith(
      "chatpack: afterMessageSend hook failed",
      expect.any(Error),
    );
    errorLog.mockRestore();

    const { messages } = await chat.api.listMessages({
      userId: "alice",
      conversationId: conversation.id,
    });
    expect(messages).toHaveLength(1);
  });

  it('fires on edits with action: "edit"', async () => {
    const actions: string[] = [];
    const chat = createChat({
      hooks: {
        afterMessageSend: ({ action }) => {
          actions.push(action);
        },
      },
    });
    const conversation = await conversationBetween(chat);
    const message = await chat.api.sendMessage({
      userId: "alice",
      conversationId: conversation.id,
      body: "hi",
    });
    await chat.api.editMessage({ userId: "alice", messageId: message.id, body: "bye" });

    expect(actions).toEqual(["send", "edit"]);
  });
});
