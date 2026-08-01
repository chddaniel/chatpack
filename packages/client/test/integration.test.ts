import { describe, expect, it } from "vitest";
import { memoryAdapter } from "@chatpack/adapter-memory";
import { chatpack } from "@chatpack/core";
import { createChatClient } from "../src/client";

describe("client and handler integration", () => {
  it("uses the public handler without duplicating protocol logic", async () => {
    const chat = chatpack({
      storage: memoryAdapter(),
      auth: (request) => {
        const userId = request.headers.get("x-user-id");
        return userId === null ? null : { id: userId };
      },
    });
    const handler = chat.handler({ heartbeatIntervalMs: 0 });
    const client = createChatClient({
      fetch: async (input, init) => {
        const requestURL = new URL(input instanceof Request ? input.url : input);
        const headers = new Headers(init?.headers);
        headers.set("x-user-id", "alice");
        return handler.fetch(
          new Request("http://chatpack.invalid" + requestURL.pathname + requestURL.search, {
            ...init,
            headers,
          }),
        );
      },
    });

    const conversation = await client.conversations.create({ otherUserId: "bob" });
    expect(conversation.error).toBeNull();
    if (conversation.error !== null) return;

    const sent = await client.messages.send({
      conversationId: conversation.data.id,
      body: "hello from the client",
    });
    expect(sent.error).toBeNull();

    const page = await client.messages.list({ conversationId: conversation.data.id });
    expect(page).toMatchObject({
      error: null,
      data: { messages: [{ body: "hello from the client" }] },
    });
  });
});
