import { describe, expect, it, vi } from "vitest";
import { createChatClient } from "../src/client";
import { typingClient } from "../src/plugins/typing";

describe("client plugins", () => {
  it("adds typed namespaced actions and disposes with the client", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    const client = createChatClient({ fetch: fetchImpl, plugins: [typingClient()] });

    const result = await client.typing.start({ conversationId: "c1" });
    expect(result).toEqual({ data: { ok: true }, error: null });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(client.$getPluginState("typing")?.getSnapshot()).toEqual({});

    client.dispose();
    expect(() => createChatClient({ plugins: [typingClient(), typingClient()] })).toThrow(
      'duplicate client plugin id "typing"',
    );
  });
});
