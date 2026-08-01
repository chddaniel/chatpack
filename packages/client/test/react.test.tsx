import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import { createChatClient } from "../src/react";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe("React client", () => {
  it("shares the client cache with hooks", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ conversations: [{ id: "c1" }], nextCursor: null }), {
          status: 200,
        }),
    );
    const client = createChatClient({ fetch: fetchImpl });
    let latest: ReturnType<typeof client.useConversations> | undefined;
    function View(): React.JSX.Element {
      latest = client.useConversations();
      return <span>{latest.data?.conversations.length ?? 0}</span>;
    }

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<View />);
      await Promise.resolve();
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(latest?.data?.conversations).toHaveLength(1);
    expect(renderer!.toJSON()).toEqual({ type: "span", props: {}, children: ["1"] });
    client.dispose();
  });
});
