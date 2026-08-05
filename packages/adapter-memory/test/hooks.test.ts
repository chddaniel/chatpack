/**
 * Message lifecycle hooks (docs/decisions/0011 and 0014):
 * `beforeMessageSend` can block or rewrite a message before it persists;
 * `afterMessageMutation` reacts after persistence for sends, edits, and deletes.
 */
import { describe, expect, it, vi } from "vitest";

import { ChatpackError, chatpack, type ChatpackPlugin, type TransportEvent } from "@chatpack/core";
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

describe("plugin beforeMessageSend", () => {
  it("runs after the application hook and blocks before persistence", async () => {
    const calls: string[] = [];
    const plugin: ChatpackPlugin = {
      name: "filepack",
      beforeMessageSend: ({ body }) => {
        calls.push(`plugin:${body}`);
        throw new Error("Attachment is not ready.");
      },
    };
    const chat = createChat({
      hooks: {
        beforeMessageSend: ({ body }) => {
          calls.push(`application:${body}`);
          return { body: `${body}-checked` };
        },
      },
      plugins: [plugin],
    });
    const conversation = await conversationBetween(chat);

    await expect(
      chat.api.sendMessage({ userId: "alice", conversationId: conversation.id, body: "hello" }),
    ).rejects.toMatchObject({ code: "MESSAGE_REJECTED", message: "Attachment is not ready." });
    expect(calls).toEqual(["application:hello", "plugin:hello-checked"]);

    const history = await chat.api.listMessages({
      userId: "alice",
      conversationId: conversation.id,
    });
    expect(history.messages).toEqual([]);
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

describe("afterMessageMutation", () => {
  it("fires after send, edit, and delete with the persisted message and recipient", async () => {
    const seen: Array<{
      action: string;
      message: { id: string; seq: number; body: string; deletedAt: Date | null };
      otherParticipantId: string;
    }> = [];
    const events: TransportEvent[] = [];
    const chat = createChat({
      hooks: {
        afterMessageMutation: (ctx) => {
          seen.push({
            action: ctx.action,
            message: ctx.message,
            otherParticipantId: ctx.otherParticipantId,
          });
        },
      },
    });
    chat.transport.subscribe((event) => events.push(event));
    const conversation = await conversationBetween(chat);

    const message = await chat.api.sendMessage({
      userId: "alice",
      conversationId: conversation.id,
      body: "hi",
    });
    await chat.api.editMessage({ userId: "alice", messageId: message.id, body: "edited" });
    await chat.api.deleteMessage({ userId: "alice", messageId: message.id });

    expect(seen.map(({ action }) => action)).toEqual(["send", "edit", "delete"]);
    expect(seen[0]).toMatchObject({
      action: "send",
      message: { id: message.id, seq: message.seq, body: "hi", deletedAt: null },
      otherParticipantId: "bob",
    });
    expect(seen[1]).toMatchObject({
      action: "edit",
      message: { id: message.id, body: "edited" },
      otherParticipantId: "bob",
    });
    expect(seen[2]).toMatchObject({
      action: "delete",
      message: { id: message.id, body: "", deletedAt: expect.any(Date) },
      otherParticipantId: "bob",
    });
    expect(events.map(({ type }) => type)).toEqual([
      "message.created",
      "message.updated",
      "message.deleted",
    ]);
  });

  it("derives the other participant from the persisted message sender", async () => {
    const recipients: string[] = [];
    const chat = createChat({
      hooks: {
        afterMessageMutation: ({ otherParticipantId }) => {
          recipients.push(otherParticipantId);
        },
      },
    });
    const conversation = await conversationBetween(chat);

    await chat.api.sendMessage({
      userId: "bob",
      conversationId: conversation.id,
      body: "hi alice",
    });

    expect(recipients).toEqual(["alice"]);
  });

  it("preserves mutations when no after hook is configured", async () => {
    const storage = memoryAdapter();
    const { conversation } = await storage.getOrCreateDirectConversation({
      pairKey: "alice:bob",
      userIds: ["alice", "bob"],
      metadata: {},
    });
    vi.spyOn(storage, "getConversation").mockResolvedValue({
      ...conversation,
      participants: [conversation.participants[0]!],
    });
    const chat = chatpack({ storage, telemetry: false });

    const message = await chat.api.sendMessage({
      userId: "alice",
      conversationId: conversation.id,
      body: "single participant adapter",
    });
    await chat.api.editMessage({ userId: "alice", messageId: message.id, body: "edited" });
    await chat.api.deleteMessage({ userId: "alice", messageId: message.id });
  });

  it("logs and swallows recipient lookup failures after persistence", async () => {
    const storage = memoryAdapter();
    const { conversation } = await storage.getOrCreateDirectConversation({
      pairKey: "alice:bob",
      userIds: ["alice", "bob"],
      metadata: {},
    });
    vi.spyOn(storage, "getConversation").mockResolvedValue({
      ...conversation,
      participants: [conversation.participants[0]!],
    });
    const after = vi.fn();
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const chat = chatpack({
        storage,
        telemetry: false,
        hooks: { afterMessageMutation: after },
      });

      const message = await chat.api.sendMessage({
        userId: "alice",
        conversationId: conversation.id,
        body: "still durable",
      });

      expect(after).not.toHaveBeenCalled();
      expect(errorLog).toHaveBeenCalledWith(
        "chatpack: afterMessageMutation hook failed",
        expect.objectContaining({ code: "INVALID_INPUT" }),
      );
      await expect(
        chat.api.listMessages({ userId: "alice", conversationId: conversation.id }),
      ).resolves.toMatchObject({ messages: [{ id: message.id }] });
    } finally {
      errorLog.mockRestore();
    }
  });

  it("runs after persistence and transport publish", async () => {
    const storage = memoryAdapter();
    const events: TransportEvent[] = [];
    const persisted: string[] = [];
    const chat = chatpack({
      storage,
      telemetry: false,
      hooks: {
        afterMessageMutation: async ({ message }) => {
          expect(await storage.getMessage(message.id)).toEqual(message);
          expect(events).toHaveLength(1);
          persisted.push(message.id);
        },
      },
    });
    chat.transport.subscribe((event) => events.push(event));
    const conversation = await conversationBetween(chat);

    const message = await chat.api.sendMessage({
      userId: "alice",
      conversationId: conversation.id,
      body: "durable first",
    });

    expect(persisted).toEqual([message.id]);
  });

  it("does not fire when the before hook rejects", async () => {
    const after = vi.fn();
    const chat = createChat({
      hooks: {
        beforeMessageSend: () => {
          throw new Error("no");
        },
        afterMessageMutation: after,
      },
    });
    const conversation = await conversationBetween(chat);

    await expect(
      chat.api.sendMessage({ userId: "alice", conversationId: conversation.id, body: "hi" }),
    ).rejects.toBeInstanceOf(ChatpackError);
    expect(after).not.toHaveBeenCalled();
  });

  it("does not fire when message persistence fails", async () => {
    const storage = memoryAdapter();
    const addMessage = vi.spyOn(storage, "addMessage").mockRejectedValue(new Error("db down"));
    const after = vi.fn();
    const chat = chatpack({
      storage,
      telemetry: false,
      hooks: { afterMessageMutation: after },
    });
    const conversation = await conversationBetween(chat);

    await expect(
      chat.api.sendMessage({ userId: "alice", conversationId: conversation.id, body: "hi" }),
    ).rejects.toThrow("db down");
    expect(after).not.toHaveBeenCalled();
    addMessage.mockRestore();
  });

  it("does not fire for an idempotent repeated delete", async () => {
    const actions: string[] = [];
    const chat = createChat({
      hooks: {
        afterMessageMutation: ({ action }) => {
          actions.push(action);
        },
      },
    });
    const conversation = await conversationBetween(chat);
    const message = await chat.api.sendMessage({
      userId: "alice",
      conversationId: conversation.id,
      body: "delete once",
    });

    await chat.api.deleteMessage({ userId: "alice", messageId: message.id });
    await chat.api.deleteMessage({ userId: "alice", messageId: message.id });

    expect(actions).toEqual(["send", "delete"]);
  });

  it("logs mutation-hook failures and still returns a persisted message", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const chat = createChat({
        hooks: {
          afterMessageMutation: () => {
            throw new Error("push provider unavailable");
          },
        },
      });
      const conversation = await conversationBetween(chat);

      const message = await chat.api.sendMessage({
        userId: "alice",
        conversationId: conversation.id,
        body: "still durable",
      });

      expect(message.body).toBe("still durable");
      expect(errorLog).toHaveBeenCalledWith(
        "chatpack: afterMessageMutation hook failed",
        expect.any(Error),
      );
      await expect(
        chat.api.listMessages({ userId: "alice", conversationId: conversation.id }),
      ).resolves.toMatchObject({ messages: [{ id: message.id }] });
    } finally {
      errorLog.mockRestore();
    }
  });

  it("keeps the deprecated hook for send and edit, but not delete", async () => {
    const actions: string[] = [];
    const recipients: string[] = [];
    const chat = createChat({
      hooks: {
        afterMessageSend: ({ action, otherParticipantId }) => {
          actions.push(action);
          recipients.push(otherParticipantId);
        },
      },
    });
    const conversation = await conversationBetween(chat);
    const message = await chat.api.sendMessage({
      userId: "alice",
      conversationId: conversation.id,
      body: "legacy",
    });
    await chat.api.editMessage({ userId: "alice", messageId: message.id, body: "legacy edit" });
    await chat.api.deleteMessage({ userId: "alice", messageId: message.id });

    expect(actions).toEqual(["send", "edit"]);
    expect(recipients).toEqual(["bob", "bob"]);
  });

  it("rejects configuring both hook names", () => {
    expect(() =>
      createChat({
        hooks: {
          afterMessageMutation: () => undefined,
          afterMessageSend: () => undefined,
        },
      }),
    ).toThrow("Configure either hooks.afterMessageMutation");
  });
});
