/**
 * Unit tests for the plugin seam (`docs/decisions/0008`): the ephemeral-event
 * primitive and the {@link createPluginRuntime} dispatcher.
 *
 * End-to-end behavior of the first-party plugins (typing/presence/receipts)
 * is covered in `packages/adapter-memory/test/plugins.test.ts`, where a real
 * storage adapter is available.
 */
import { describe, expect, it, vi } from "vitest";

import type { ChatpackApi } from "../src/chatpack";
import { ChatpackError } from "../src/errors";
import { createHandler } from "../src/handler";
import { createPluginRuntime, type ChatpackPlugin } from "../src/plugin";
import {
  inProcessTransport,
  isEphemeralEvent,
  type TransportEvent,
  type ChatEvent,
} from "../src/transport";
import type { MessageWithDetails } from "../src/types";

const fakeApi = {} as ChatpackApi;

function sampleMessage(): MessageWithDetails {
  return {
    id: "m1",
    conversationId: "c1",
    senderId: "alice",
    body: "hi",
    role: "user",
    seq: 1,
    createdAt: new Date(),
    editedAt: null,
    deletedAt: null,
    replyToMessageId: null,
    metadata: {},
    replyTo: null,
    reactions: [],
  };
}

function sampleChatEvent(): ChatEvent {
  return {
    type: "message.created",
    conversationId: "c1",
    recipientIds: ["alice", "bob"],
    message: sampleMessage(),
  };
}

describe("isEphemeralEvent", () => {
  it("discriminates ephemeral events from durable chat events", () => {
    expect(isEphemeralEvent(sampleChatEvent())).toBe(false);
    expect(
      isEphemeralEvent({
        ephemeral: true,
        type: "typing.started",
        senderId: "alice",
        recipientIds: ["bob"],
        payload: {},
        at: new Date().toISOString(),
      }),
    ).toBe(true);
  });
});

describe("createPluginRuntime", () => {
  it("publishEphemeral shapes a complete ephemeral event", () => {
    const transport = inProcessTransport();
    const received: TransportEvent[] = [];
    transport.subscribe((event) => received.push(event));

    const runtime = createPluginRuntime([], fakeApi, transport);
    runtime.publishEphemeral({
      type: "typing.started",
      conversationId: "c1",
      senderId: "alice",
      recipientIds: ["bob"],
    });

    expect(received).toHaveLength(1);
    const event = received[0]!;
    expect(isEphemeralEvent(event)).toBe(true);
    if (!isEphemeralEvent(event)) return;
    expect(event.type).toBe("typing.started");
    expect(event.conversationId).toBe("c1");
    expect(event.senderId).toBe("alice");
    expect(event.recipientIds).toEqual(["bob"]);
    expect(event.payload).toEqual({}); // defaults to empty object
    expect(Number.isNaN(Date.parse(event.at))).toBe(false); // valid ISO timestamp
  });

  it("hasPlugins reflects registration", () => {
    const transport = inProcessTransport();
    expect(createPluginRuntime([], fakeApi, transport).hasPlugins).toBe(false);
    expect(createPluginRuntime([{ name: "x" }], fakeApi, transport).hasPlugins).toBe(true);
  });

  it("dispatches notification hooks to every plugin", () => {
    const transport = inProcessTransport();
    const calls: string[] = [];
    const plugin = (name: string): ChatpackPlugin => ({
      name,
      onStreamOpen: () => calls.push(`${name}:open`),
      onStreamClose: () => calls.push(`${name}:close`),
      onMarkRead: () => calls.push(`${name}:read`),
      onEventDelivered: () => calls.push(`${name}:delivered`),
    });
    const runtime = createPluginRuntime([plugin("a"), plugin("b")], fakeApi, transport);

    runtime.notifyStreamOpen("alice");
    runtime.notifyStreamClose("alice");
    runtime.notifyMarkRead({
      userId: "alice",
      conversationId: "c1",
      messageId: "m1",
      recipientIds: ["alice", "bob"],
    });
    runtime.notifyEventDelivered("bob", sampleChatEvent());

    expect(calls).toEqual([
      "a:open",
      "b:open",
      "a:close",
      "b:close",
      "a:read",
      "b:read",
      "a:delivered",
      "b:delivered",
    ]);
  });

  it("a throwing plugin never breaks a notification, nor the plugins after it", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const transport = inProcessTransport();
      const calls: string[] = [];
      const broken: ChatpackPlugin = {
        name: "broken",
        onStreamOpen: () => {
          throw new Error("boom");
        },
      };
      const healthy: ChatpackPlugin = {
        name: "healthy",
        onStreamOpen: () => calls.push("healthy:open"),
      };
      const runtime = createPluginRuntime([broken, healthy], fakeApi, transport);

      expect(() => runtime.notifyStreamOpen("alice")).not.toThrow();
      expect(calls).toEqual(["healthy:open"]);
      expect(errorSpy).toHaveBeenCalledOnce();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("handleRequest: first plugin response wins, null passes through", async () => {
    const transport = inProcessTransport();
    const basePaths: string[] = [];
    const passes: ChatpackPlugin = {
      name: "passes",
      handleRequest: (ctx) => {
        basePaths.push(ctx.basePath);
        return null;
      },
    };
    const answers: ChatpackPlugin = {
      name: "answers",
      handleRequest: () => new Response("claimed", { status: 200 }),
    };
    const never: ChatpackPlugin = {
      name: "never",
      handleRequest: () => new Response("too late", { status: 200 }),
    };
    const runtime = createPluginRuntime([passes, answers, never], fakeApi, transport);

    const url = new URL("http://test.local/api/chat/custom");
    const response = await runtime.handleRequest({
      request: new Request(url),
      url,
      method: "GET",
      segments: ["custom"],
      basePath: "/api/chat",
      userId: "alice",
      user: { id: "alice" },
    });

    expect(response).not.toBeNull();
    expect(await response!.text()).toBe("claimed");

    const unclaimed = await createPluginRuntime([passes], fakeApi, transport).handleRequest({
      request: new Request(url),
      url,
      method: "GET",
      segments: ["custom"],
      basePath: "/api/chat",
      userId: "alice",
      user: { id: "alice" },
    });
    expect(unclaimed).toBeNull();
    expect(basePaths).toEqual(["/api/chat", "/api/chat"]);
  });

  it("handleCapabilityRequest: first response wins and context excludes auth/domain state", async () => {
    const transport = inProcessTransport();
    const calls: string[] = [];
    const seenKeys: string[][] = [];
    const first: ChatpackPlugin = {
      name: "first",
      handleCapabilityRequest: (ctx) => {
        calls.push("first");
        seenKeys.push(Object.keys(ctx).sort());
        expect(ctx.method).toBe("GET");
        expect(ctx.segments).toEqual(["assets", "downloads", "v1.capability"]);
        return null;
      },
    };
    const second: ChatpackPlugin = {
      name: "second",
      handleCapabilityRequest: () => {
        calls.push("second");
        return new Response("claimed", { status: 200 });
      },
    };
    const never: ChatpackPlugin = {
      name: "never",
      handleCapabilityRequest: () => {
        calls.push("never");
        return new Response("too late", { status: 200 });
      },
    };

    const url = new URL("http://test.local/chat/assets/downloads/v1.capability");
    const response = await createPluginRuntime(
      [first, second, never],
      fakeApi,
      transport,
    ).handleCapabilityRequest({
      request: new Request(url),
      url,
      method: "GET",
      segments: ["assets", "downloads", "v1.capability"],
      basePath: "/chat",
    });

    expect(await response?.text()).toBe("claimed");
    expect(calls).toEqual(["first", "second"]);
    expect(seenKeys).toEqual([["basePath", "method", "request", "segments", "url"]]);
  });

  it.each([
    ["ordinary errors", () => new Error("secret capability detail")],
    ["Chatpack errors", () => new ChatpackError("FORBIDDEN_READ", "private capability denial")],
  ])("capability hook %s return opaque 500 and do not fall through", async (_case, fail) => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const auth = vi.fn(() => null);
      const failure = fail();
      const runtime = createPluginRuntime(
        [
          {
            name: "broken-capability-plugin",
            handleCapabilityRequest: () => {
              throw failure;
            },
          },
        ],
        fakeApi,
        inProcessTransport(),
      );
      const handler = createHandler(fakeApi, auth, {}, undefined, runtime);

      const response = await handler.GET(new Request("http://test.local/api/chat/public"));

      expect(response.status).toBe(500);
      const body = await response.json();
      expect(body).toEqual({
        error: { code: "INTERNAL_ERROR", message: "Something went wrong." },
      });
      expect(JSON.stringify(body)).not.toContain("secret capability detail");
      expect(JSON.stringify(body)).not.toContain("private capability denial");
      expect(JSON.stringify(body)).not.toContain("FORBIDDEN_READ");
      expect(auth).not.toHaveBeenCalled();
      expect(errorSpy).toHaveBeenCalledOnce();
      const loggedError = errorSpy.mock.calls[0]?.[1] as Error & { cause?: unknown };
      expect(loggedError.cause).toBe(failure);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("plugins without a capability hook remain behind normal auth", async () => {
    const handleRequest = vi.fn(() => new Response("private", { status: 200 }));
    const auth = vi.fn(() => null);
    const runtime = createPluginRuntime(
      [{ name: "ordinary", handleRequest }],
      fakeApi,
      inProcessTransport(),
    );
    const handler = createHandler(fakeApi, auth, {}, undefined, runtime);

    const response = await handler.GET(new Request("http://test.local/api/chat/custom"));

    expect(response.status).toBe(401);
    expect(handleRequest).not.toHaveBeenCalled();
  });

  it("runs blocking message hooks in registration order and rewrites sequentially", async () => {
    const calls: string[] = [];
    const runtime = createPluginRuntime(
      [
        {
          name: "first",
          beforeMessageSend: ({ body }) => {
            calls.push(`first:${body}`);
            return { body: `${body}!` };
          },
        },
        {
          name: "second",
          beforeMessageSend: ({ body }) => {
            calls.push(`second:${body}`);
          },
        },
      ],
      fakeApi,
      inProcessTransport(),
    );

    await expect(
      runtime.runBeforeMessageSend({
        user: { id: "alice" },
        conversation: {
          id: "c1",
          pairKey: "alice:bob",
          createdAt: new Date(),
          metadata: {},
          participants: [],
          participantIds: ["alice", "bob"],
        },
        body: "hello",
        metadata: {},
        role: "user",
        action: "send",
      }),
    ).resolves.toMatchObject({ body: "hello!", metadata: {} });
    expect(calls).toEqual(["first:hello", "second:hello!"]);
  });

  it("maps non-Chatpack plugin validation errors to MESSAGE_REJECTED", async () => {
    const runtime = createPluginRuntime(
      [
        {
          name: "validator",
          beforeMessageSend: () => {
            throw new Error("File is not ready.");
          },
        },
      ],
      fakeApi,
      inProcessTransport(),
    );

    await expect(
      runtime.runBeforeMessageSend({
        user: { id: "alice" },
        conversation: {
          id: "c1",
          pairKey: "alice:bob",
          createdAt: new Date(),
          metadata: {},
          participants: [],
          participantIds: ["alice", "bob"],
        },
        body: "hello",
        metadata: {},
        role: "user",
        action: "send",
      }),
    ).rejects.toMatchObject({ code: "MESSAGE_REJECTED", message: "File is not ready." });
  });
});
