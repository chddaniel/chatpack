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

  it("loads and paginates message search without changing server order", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      const cursor = url.searchParams.get("cursor");
      return new Response(
        JSON.stringify(
          cursor === null
            ? { messages: [{ id: "ranked-first", body: "needle needle" }], nextCursor: "next" }
            : { messages: [{ id: "ranked-second", body: "needle" }], nextCursor: null },
        ),
        { status: 200 },
      );
    });
    const client = createChatClient({ fetch: fetchImpl });
    let latest: ReturnType<typeof client.useMessageSearch> | undefined;
    function View(): React.JSX.Element {
      latest = client.useMessageSearch({ query: " needle ", limit: 1 });
      return <span>{latest.data?.messages.length ?? 0}</span>;
    }

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<View />);
      await Promise.resolve();
    });

    expect(String(fetchImpl.mock.calls[0]?.[0])).toContain("/search/messages?q=+needle+&limit=1");
    expect(latest?.data?.messages.map((message) => message.id)).toEqual(["ranked-first"]);

    await act(async () => {
      await latest?.loadMore();
    });

    expect(String(fetchImpl.mock.calls[1]?.[0])).toContain("cursor=next");
    expect(latest?.data?.messages.map((message) => message.id)).toEqual([
      "ranked-first",
      "ranked-second",
    ]);
    expect(renderer!.toJSON()).toEqual({ type: "span", props: {}, children: ["2"] });

    await act(async () => {
      await latest?.refetch();
    });

    expect(String(fetchImpl.mock.calls[2]?.[0])).not.toContain("cursor=");
    expect(latest?.data?.messages.map((message) => message.id)).toEqual(["ranked-first"]);
    client.dispose();
  });

  it("treats an empty search query as an idle empty page", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            error: { code: "INVALID_INPUT", message: '"query" must be a non-empty string.' },
          }),
          { status: 400 },
        ),
    );
    const client = createChatClient({ fetch: fetchImpl });
    await client.messages.search({ query: "   " });
    let latest: ReturnType<typeof client.useMessageSearch> | undefined;
    function View(): React.JSX.Element {
      latest = client.useMessageSearch({ query: "   " });
      return <span>{latest.isPending ? "pending" : "idle"}</span>;
    }

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<View />);
      await Promise.resolve();
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(latest?.data).toEqual({ messages: [], nextCursor: null });
    expect(latest?.error).toBeNull();
    expect(renderer!.toJSON()).toEqual({ type: "span", props: {}, children: ["idle"] });
    client.dispose();
  });
});
