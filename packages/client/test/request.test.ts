import { describe, expect, it, vi } from "vitest";
import { createRequester } from "../src/request";

describe("client requests", () => {
  it("builds relative URLs, JSON bodies, credentials, and envelopes", async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.credentials).toBe("include");
      expect(new Headers(init?.headers).get("content-type")).toBe("application/json");
      expect(init?.body).toBe(JSON.stringify({ otherUserId: "bob" }));
      return new Response(JSON.stringify({ conversation: { id: "c1" } }), { status: 200 });
    });
    const requester = createRequester({
      basePath: "/api/chat",
      credentials: "include",
      fetch: fetchImpl,
    });

    const result = await requester.request<{ conversation: { id: string } }>("/conversations", {
      method: "POST",
      query: { limit: 10, cursor: "next page" },
      body: { otherUserId: "bob" },
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      "http://chatpack.invalid/api/chat/conversations?limit=10&cursor=next+page",
      expect.any(Object),
    );
    expect(result).toEqual({ data: { conversation: { id: "c1" } }, error: null });
  });

  it("maps server and network failures to stable errors", async () => {
    const server = createRequester({
      basePath: "/api/chat",
      credentials: "same-origin",
      fetch: vi.fn(
        async () =>
          new Response(JSON.stringify({ error: { code: "FORBIDDEN_WRITE", message: "no" } }), {
            status: 403,
          }),
      ),
    });
    const denied = await server.request("/messages/m1", { method: "DELETE" });
    expect(denied.error?.code).toBe("FORBIDDEN_WRITE");
    expect(denied.data).toBeNull();

    const network = createRequester({
      basePath: "/api/chat",
      credentials: "same-origin",
      fetch: vi.fn(async () => {
        throw new Error("offline");
      }),
    });
    const failed = await network.request("/conversations");
    expect(failed.error?.code).toBe("NETWORK_ERROR");
  });
});
