import { memoryAdapter } from "@chatpack/adapter-memory";
import { chatpack, type ChatpackHandler } from "@chatpack/core";
import { describe, expect, it } from "vitest";

import { createChatClient } from "../src/client";

function clientFor(handler: ChatpackHandler, userId: string) {
  return createChatClient({
    fetch: async (input, init) => {
      const requestURL = new URL(input instanceof Request ? input.url : String(input));
      const headers = new Headers(init?.headers);
      headers.set("x-user-id", userId);
      return handler.fetch(
        new Request("http://chatpack.invalid" + requestURL.pathname + requestURL.search, {
          ...init,
          headers,
        }),
      );
    },
  });
}

function handlerFor(storage = memoryAdapter()): ChatpackHandler {
  return chatpack({
    storage,
    telemetry: false,
    auth: (request) => {
      const userId = request.headers.get("x-user-id");
      return userId === null ? null : { id: userId };
    },
  }).handler();
}

describe("message search client", () => {
  it("encodes the search query and pagination parameters", async () => {
    let requestedURL: URL | undefined;
    const client = createChatClient({
      fetch: async (input) => {
        requestedURL = new URL(input instanceof Request ? input.url : String(input));
        return new Response(JSON.stringify({ messages: [], nextCursor: null }), { status: 200 });
      },
    });

    await client.messages.search({ query: "alpha & beta", limit: 7, cursor: "score:1/+?" });

    expect(requestedURL?.pathname).toBe("/api/chat/search/messages");
    expect(requestedURL?.searchParams.get("q")).toBe("alpha & beta");
    expect(requestedURL?.searchParams.get("limit")).toBe("7");
    expect(requestedURL?.searchParams.get("cursor")).toBe("score:1/+?");
  });

  it("preserves participant scope, whole-token AND matching, ranking, pagination, and tombstones", async () => {
    const handler = handlerFor();
    const alice = clientFor(handler, "alice");
    const bob = clientFor(handler, "bob");
    const mallory = clientFor(handler, "mallory");

    const group = await alice.conversations.createGroup({
      name: "Search group",
      userIds: ["bob"],
    });
    if (group.error !== null) throw new Error("group setup failed");

    const high = await alice.messages.send({
      conversationId: group.data.id,
      body: "alpha beta beta",
    });
    const low = await alice.messages.send({
      conversationId: group.data.id,
      body: "alpha beta",
    });
    await alice.messages.send({ conversationId: group.data.id, body: "alphabet beta" });
    const removed = await alice.messages.send({
      conversationId: group.data.id,
      body: "alpha beta beta beta",
    });
    if (high.error !== null || low.error !== null || removed.error !== null) {
      throw new Error("message setup failed");
    }
    await alice.messages.delete({ messageId: removed.data.id });

    const first = await bob.messages.search({ query: "ALPHA beta", limit: 1 });
    expect(first).toMatchObject({
      error: null,
      data: { messages: [{ id: high.data.id }], nextCursor: expect.any(String) },
    });
    if (first.error !== null || first.data.nextCursor === null) throw new Error("search failed");

    const second = await bob.messages.search({
      query: "ALPHA beta",
      limit: 1,
      cursor: first.data.nextCursor,
    });
    expect(second).toMatchObject({
      error: null,
      data: { messages: [{ id: low.data.id }], nextCursor: null },
    });

    expect(await bob.messages.search({ query: "alphabet alpha" })).toMatchObject({
      error: null,
      data: { messages: [] },
    });
    expect(await mallory.messages.search({ query: "alpha beta" })).toMatchObject({
      error: null,
      data: { messages: [] },
    });
    expect((await bob.messages.search({ query: "" })).error?.code).toBe("INVALID_INPUT");
  });

  it("returns SEARCH_UNSUPPORTED when the adapter omits search", async () => {
    const storage = memoryAdapter();
    delete storage.searchMessages;
    const client = clientFor(handlerFor(storage), "alice");

    const result = await client.messages.search({ query: "hello" });

    expect(result).toEqual({
      data: null,
      error: {
        code: "SEARCH_UNSUPPORTED",
        message: "Message search is not supported by this storage adapter.",
        status: 501,
      },
    });
  });
});
