import { describe, expect, it } from "vitest";

import { chatpack, type StorageAdapter } from "@chatpack/core";
import { toNextRouteHandlers } from "../src/index";

// Minimal stub — routing/auth behavior is what this package forwards to.
const stubStorage = {
  async getOrCreateDirectConversation(input) {
    const now = new Date();
    return {
      conversation: {
        id: "conv_1",
        pairKey: input.pairKey,
        createdAt: now,
        metadata: {},
        participants: input.userIds.map((userId) => ({
          conversationId: "conv_1",
          userId,
          joinedAt: now,
          lastReadMessageId: null,
        })),
      },
      created: true,
    };
  },
  async getConversation() {
    return null;
  },
  async listConversations() {
    return { conversations: [], nextCursor: null };
  },
  async addMessage() {
    throw new Error("not needed");
  },
  async getMessage() {
    return null;
  },
  async listMessages() {
    return { messages: [], nextCursor: null };
  },
  async listMessagesAfterSeq() {
    return [];
  },
  async updateMessage() {
    throw new Error("not needed");
  },
  async updateLastRead() {},
} satisfies StorageAdapter;

describe("toNextRouteHandlers", () => {
  it("returns App Router-compatible named handlers", async () => {
    const chat = chatpack({
      storage: stubStorage,
      telemetry: false,
      auth: (request) => {
        const userId = request.headers.get("x-user-id");
        return userId ? { id: userId } : null;
      },
    });

    const { GET, POST, PATCH, DELETE } = toNextRouteHandlers(chat);
    expect(typeof GET).toBe("function");
    expect(typeof POST).toBe("function");
    expect(typeof PATCH).toBe("function");
    expect(typeof DELETE).toBe("function");

    const res = await POST(
      new Request("http://test.local/api/chat/conversations", {
        method: "POST",
        headers: { "x-user-id": "alice", "content-type": "application/json" },
        body: JSON.stringify({ otherUserId: "bob" }),
      }),
    );
    expect(res.status).toBe(200);

    const unauthenticated = await GET(new Request("http://test.local/api/chat/conversations"));
    expect(unauthenticated.status).toBe(401);
  });

  it("forwards basePath", async () => {
    const chat = chatpack({
      storage: stubStorage,
      telemetry: false,
      auth: () => ({ id: "alice" }),
    });
    const { GET } = toNextRouteHandlers(chat, { basePath: "/api/messaging" });

    const res = await GET(new Request("http://test.local/api/messaging/conversations"));
    expect(res.status).toBe(200);
  });
});
