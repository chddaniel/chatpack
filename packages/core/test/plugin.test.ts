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
    const passes: ChatpackPlugin = { name: "passes", handleRequest: () => null };
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
      userId: "alice",
    });

    expect(response).not.toBeNull();
    expect(await response!.text()).toBe("claimed");

    const unclaimed = await createPluginRuntime([passes], fakeApi, transport).handleRequest({
      request: new Request(url),
      url,
      method: "GET",
      segments: ["custom"],
      userId: "alice",
    });
    expect(unclaimed).toBeNull();
  });
});
