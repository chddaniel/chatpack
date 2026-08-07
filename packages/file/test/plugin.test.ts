import { describe, expect, it, vi } from "vitest";
import { createFileAttachmentPlugin } from "../src/index";
import {
  chatpack,
  type ChatpackApi,
  type ChatpackHandler,
  type ChatpackUser,
  type StorageAdapter,
} from "@chatpack/core";
import type {
  FilepackApi,
  FilepackFile,
  FilepackHandlerOptions,
  FilepackRouter,
} from "@filepack/core";

const file: FilepackFile = {
  id: "file-1",
  route: "chat",
  name: "photo.png",
  contentType: "image/png",
  size: 12,
  routeMetadata: { conversationId: "conversation-1" },
  createdAt: "2026-08-04T00:00:00.000Z",
  readyAt: "2026-08-04T00:00:01.000Z",
};

function context(request: Request, api: ChatpackApi, segments: string[]) {
  return {
    api,
    publishEphemeral: vi.fn(),
    request,
    url: new URL(request.url),
    method: request.method,
    segments,
    basePath: "/api/chat",
    userId: "alice",
    user: { id: "alice" },
  };
}

function fakeApi(
  filepackHandler: (request: Request) => Promise<Response>,
  onHandler?: (options: FilepackHandlerOptions) => void,
  listFiles: FilepackApi<FilepackRouter>["listFiles"] = async () => ({ files: [file] }),
): FilepackApi<FilepackRouter> {
  return {
    getFile: vi.fn(async () => file),
    listFiles: vi.fn(listFiles),
    handler: vi.fn((options: FilepackHandlerOptions) => {
      onHandler?.(options);
      return { fetch: filepackHandler };
    }),
  } as unknown as FilepackApi<FilepackRouter>;
}

function chatHandler(
  plugin: ReturnType<typeof createFileAttachmentPlugin>,
  auth: () => ChatpackUser | null,
  basePath = "/api/chat",
): ChatpackHandler {
  const chat = chatpack({
    storage: {} as StorageAdapter,
    telemetry: false,
    auth,
    plugins: [plugin],
  });
  return chat.handler({ basePath, heartbeatIntervalMs: 0 });
}

describe("Filepack nested plugin", () => {
  it("requires Chatpack read access before metadata forwarding", async () => {
    let forwardedRequest: Request | undefined;
    const forwarded = vi.fn(async (request: Request) => {
      forwardedRequest = request;
      return new Response(JSON.stringify({ file }), { status: 200 });
    });
    const api = {
      getConversation: vi.fn(async () => ({ id: "conversation-1" })),
    } as unknown as ChatpackApi;
    const plugin = createFileAttachmentPlugin({
      filepack: fakeApi(forwarded),
      authorizeUpload: () => true,
    });

    const response = await plugin.handleRequest!(
      context(
        new Request(
          "https://example.test/api/chat/files/files/file-1?conversationId=conversation-1",
        ),
        api,
        ["files", "files", "file-1"],
      ),
    );

    expect(response?.status).toBe(200);
    expect(api.getConversation).toHaveBeenCalledWith({
      userId: "alice",
      conversationId: "conversation-1",
    });
    expect(forwarded).toHaveBeenCalledOnce();
    expect(forwardedRequest).toBeDefined();
    expect(new URL(forwardedRequest!.url).search).toBe("");
  });

  it("does not forward a cross-conversation file", async () => {
    const forwarded = vi.fn(async () => new Response(null, { status: 200 }));
    const api = {
      getConversation: vi.fn(async () => ({ id: "conversation-1" })),
    } as unknown as ChatpackApi;
    const plugin = createFileAttachmentPlugin({
      filepack: fakeApi(forwarded),
      authorizeUpload: () => true,
    });

    const response = await plugin.handleRequest!(
      context(
        new Request(
          "https://example.test/api/chat/files/files/file-1?conversationId=conversation-2",
        ),
        api,
        ["files", "files", "file-1"],
      ),
    );

    expect(response?.status).toBe(404);
    expect(forwarded).not.toHaveBeenCalled();
  });

  it("pages the conversation list with opaque cursors across Filepack pages", async () => {
    const secondFile: FilepackFile = { ...file, id: "file-2", name: "second.png" };
    const foreignFile: FilepackFile = {
      ...file,
      id: "file-foreign",
      routeMetadata: { conversationId: "conversation-2" },
    };
    const listFiles = vi.fn(async (input: { readonly cursor?: string }) =>
      input.cursor === "page-2"
        ? { files: [foreignFile, secondFile] }
        : { files: [file], nextCursor: "page-2" },
    );
    const filepack = fakeApi(
      async () => new Response("not used", { status: 500 }),
      undefined,
      listFiles,
    );
    const api = {
      getConversation: vi.fn(async () => ({ id: "conversation-1" })),
    } as unknown as ChatpackApi;
    const plugin = createFileAttachmentPlugin({ filepack, authorizeUpload: () => true });

    const first = await plugin.handleRequest!(
      context(
        new Request(
          "https://example.test/api/chat/files/files?conversationId=conversation-1&limit=1",
        ),
        api,
        ["files", "files"],
      ),
    );
    const firstBody = (await first?.json()) as { files: unknown[]; nextCursor: string };
    expect(firstBody.files).toEqual([JSON.parse(JSON.stringify(file))]);
    expect(typeof firstBody.nextCursor).toBe("string");

    const second = await plugin.handleRequest!(
      context(
        new Request(
          `https://example.test/api/chat/files/files?conversationId=conversation-1&cursor=${encodeURIComponent(firstBody.nextCursor)}&limit=1`,
        ),
        api,
        ["files", "files"],
      ),
    );
    expect(await second?.json()).toEqual({ files: [JSON.parse(JSON.stringify(secondFile))] });
  });

  it("fills a page even when the conversation's files sit deep in the actor's list", async () => {
    // 120 foreign files first (more than one internal Filepack page), then
    // 5 for this conversation - the filter-after-fetch bug returned an empty
    // first page with a nextCursor here.
    const foreign = Array.from({ length: 120 }, (_, i) => ({
      ...file,
      id: `foreign-${i}`,
      routeMetadata: { conversationId: "conversation-2" },
    }));
    const mine = Array.from({ length: 5 }, (_, i) => ({ ...file, id: `mine-${i}` }));
    const all = [...foreign, ...mine];
    const listFiles = vi.fn(
      async (input: { readonly cursor?: string; readonly limit?: number }) => {
        const start = input.cursor === undefined ? 0 : Number(input.cursor);
        const size = input.limit ?? 50;
        const nextStart = start + size;
        return {
          files: all.slice(start, nextStart),
          ...(nextStart < all.length ? { nextCursor: String(nextStart) } : {}),
        };
      },
    );
    const filepack = fakeApi(
      async () => new Response("not used", { status: 500 }),
      undefined,
      listFiles,
    );
    const api = {
      getConversation: vi.fn(async () => ({ id: "conversation-1" })),
    } as unknown as ChatpackApi;
    const plugin = createFileAttachmentPlugin({ filepack, authorizeUpload: () => true });

    const response = await plugin.handleRequest!(
      context(
        new Request(
          "https://example.test/api/chat/files/files?conversationId=conversation-1&limit=10",
        ),
        api,
        ["files", "files"],
      ),
    );
    const body = (await response?.json()) as { files: { id: string }[]; nextCursor?: string };
    expect(body.files.map((f) => f.id)).toEqual(["mine-0", "mine-1", "mine-2", "mine-3", "mine-4"]);
    expect(body.nextCursor).toBeUndefined();
  });

  it("rejects a malformed list cursor", async () => {
    const listFiles = vi.fn(async () => ({ files: [file] }));
    const filepack = fakeApi(
      async () => new Response("not used", { status: 500 }),
      undefined,
      listFiles,
    );
    const api = {
      getConversation: vi.fn(async () => ({ id: "conversation-1" })),
    } as unknown as ChatpackApi;
    const plugin = createFileAttachmentPlugin({ filepack, authorizeUpload: () => true });

    const response = await plugin.handleRequest!(
      context(
        new Request(
          "https://example.test/api/chat/files/files?conversationId=conversation-1&cursor=raw-filepack-cursor",
        ),
        api,
        ["files", "files"],
      ),
    );
    expect(response?.status).toBe(400);
    await expect(response?.json()).resolves.toMatchObject({ error: { code: "INVALID_REQUEST" } });
    expect(listFiles).not.toHaveBeenCalled();
  });

  it.each(["", "0", "01", "1.5", "101", "999999999999999999999999"])(
    "rejects invalid list limit %j",
    async (limit) => {
      const listFiles = vi.fn(async () => ({ files: [file] }));
      const filepack = fakeApi(
        async () => new Response("not used", { status: 500 }),
        undefined,
        listFiles,
      );
      const api = {
        getConversation: vi.fn(async () => ({ id: "conversation-1" })),
      } as unknown as ChatpackApi;
      const plugin = createFileAttachmentPlugin({ filepack, authorizeUpload: () => true });

      const response = await plugin.handleRequest!(
        context(
          new Request(
            `https://example.test/api/chat/files/files?conversationId=conversation-1&limit=${limit}`,
          ),
          api,
          ["files", "files"],
        ),
      );

      expect(response?.status).toBe(400);
      await expect(response?.json()).resolves.toMatchObject({ error: { code: "INVALID_REQUEST" } });
      expect(listFiles).not.toHaveBeenCalled();
    },
  );

  it.each([
    "conversationId=conversation-1&conversationId=conversation-1",
    "conversationId=conversation-1&cursor=first&cursor=second",
    "conversationId=conversation-1&limit=1&limit=2",
    "unknown=value",
  ])("rejects duplicate or unknown list query %s", async (query) => {
    const listFiles = vi.fn(async () => ({ files: [file] }));
    const filepack = fakeApi(
      async () => new Response("not used", { status: 500 }),
      undefined,
      listFiles,
    );
    const api = {
      getConversation: vi.fn(async () => ({ id: "conversation-1" })),
    } as unknown as ChatpackApi;
    const plugin = createFileAttachmentPlugin({ filepack, authorizeUpload: () => true });

    const response = await plugin.handleRequest!(
      context(new Request(`https://example.test/api/chat/files/files?${query}`), api, [
        "files",
        "files",
      ]),
    );

    expect(response?.status).toBe(400);
    await expect(response?.json()).resolves.toMatchObject({ error: { code: "INVALID_REQUEST" } });
    expect(listFiles).not.toHaveBeenCalled();
  });

  it.each(["", "?conversationId="])(
    "keeps missing or empty conversation query %j unavailable",
    async (query) => {
      const listFiles = vi.fn(async () => ({ files: [file] }));
      const filepack = fakeApi(
        async () => new Response("not used", { status: 500 }),
        undefined,
        listFiles,
      );
      const api = { getConversation: vi.fn() } as unknown as ChatpackApi;
      const plugin = createFileAttachmentPlugin({ filepack, authorizeUpload: () => true });

      const response = await plugin.handleRequest!(
        context(new Request(`https://example.test/api/chat/files/files${query}`), api, [
          "files",
          "files",
        ]),
      );

      expect(response?.status).toBe(404);
      await expect(response?.json()).resolves.toMatchObject({
        error: { code: "FILE_UNAVAILABLE" },
      });
      expect(api.getConversation).not.toHaveBeenCalled();
      expect(listFiles).not.toHaveBeenCalled();
    },
  );

  it("does not list files when the conversation is unauthorized", async () => {
    const listFiles = vi.fn(async () => ({ files: [file] }));
    const filepack = fakeApi(
      async () => new Response("not used", { status: 500 }),
      undefined,
      listFiles,
    );
    const api = {
      getConversation: vi.fn(async () => {
        throw new Error("forbidden");
      }),
    } as unknown as ChatpackApi;
    const plugin = createFileAttachmentPlugin({ filepack, authorizeUpload: () => true });

    const response = await plugin.handleRequest!(
      context(
        new Request(
          "https://example.test/api/chat/files/files?conversationId=conversation-1&limit=10",
        ),
        api,
        ["files", "files"],
      ),
    );

    expect(response?.status).toBe(404);
    await expect(response?.json()).resolves.toMatchObject({ error: { code: "FILE_UNAVAILABLE" } });
    expect(api.getConversation).toHaveBeenCalledOnce();
    expect(listFiles).not.toHaveBeenCalled();
  });

  it("runs host upload authorization on the route association", async () => {
    const forwarded = vi.fn(async () => new Response(null, { status: 201 }));
    const authorizeUpload = vi.fn(() => true);
    const api = {
      getConversation: vi.fn(),
    } as unknown as ChatpackApi;
    const plugin = createFileAttachmentPlugin({
      filepack: fakeApi(forwarded),
      authorizeUpload,
    });

    const response = await plugin.handleRequest!(
      context(
        new Request("https://example.test/api/chat/files/uploads", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            route: "chat",
            routeInput: { conversationId: "conversation-1" },
            files: [{ name: "photo.png", type: "image/png", size: 12 }],
          }),
        }),
        api,
        ["files", "uploads"],
      ),
    );

    expect(response?.status).toBe(201);
    expect(authorizeUpload).toHaveBeenCalledWith(
      expect.objectContaining({ actor: { id: "alice" }, conversationId: "conversation-1" }),
    );
  });

  it("forwards exact unauthenticated transfer routes with custom base and mount paths", async () => {
    const forwarded: Request[] = [];
    const handlerOptions: FilepackHandlerOptions[] = [];
    const filepackHandler = vi.fn(async (request: Request) => {
      forwarded.push(request);
      return request.method === "GET"
        ? new Response("media", { status: 200, headers: { "content-type": "image/png" } })
        : new Response(null, { status: 204 });
    });
    const plugin = createFileAttachmentPlugin({
      filepack: fakeApi(filepackHandler, (options) => handlerOptions.push(options)),
      mountPath: "assets",
      authorizeUpload: () => true,
    });
    let authCalls = 0;
    const handler = chatHandler(
      plugin,
      () => {
        authCalls += 1;
        return null;
      },
      "/messaging",
    );

    const upload = await handler.PUT(
      new Request("https://example.test/messaging/assets/uploads/attempt-1/content", {
        method: "PUT",
        headers: {
          "content-type": "image/png",
          "x-filepack-upload-capability": "upload-capability",
        },
        body: "bytes",
      }),
    );
    const part = await handler.PUT(
      new Request("https://example.test/messaging/assets/uploads/attempt-1/parts/2/content", {
        method: "PUT",
        headers: {
          "content-type": "image/png",
          "x-filepack-upload-capability": "part-capability",
        },
        body: "part",
      }),
    );
    const download = await handler.GET(
      new Request("https://example.test/messaging/assets/downloads/v1.download-capability", {
        method: "GET",
        headers: { range: "bytes=2-4" },
      }),
    );

    expect(upload.status).toBe(204);
    expect(part.status).toBe(204);
    expect(download.status).toBe(200);
    expect(await download.text()).toBe("media");
    expect(authCalls).toBe(0);
    expect(forwarded).toHaveLength(3);
    expect(forwarded.map((request) => new URL(request.url).pathname)).toEqual([
      "/messaging/assets/uploads/attempt-1/content",
      "/messaging/assets/uploads/attempt-1/parts/2/content",
      "/messaging/assets/downloads/v1.download-capability",
    ]);
    expect(handlerOptions).toHaveLength(3);
    expect(handlerOptions[0]?.basePath).toBe("/messaging/assets");
    expect(handlerOptions[0]?.auth(new Request("https://example.test/"))).toBeNull();
    expect(forwarded[0]?.headers.get("x-filepack-upload-capability")).toBe("upload-capability");
    expect(forwarded[0]?.headers.get("content-type")).toBe("image/png");
    expect(new TextDecoder().decode(await forwarded[0]!.arrayBuffer())).toBe("bytes");
    expect(forwarded[1]?.headers.get("x-filepack-upload-capability")).toBe("part-capability");
    expect(new TextDecoder().decode(await forwarded[1]!.arrayBuffer())).toBe("part");
    expect(forwarded[2]?.headers.get("range")).toBe("bytes=2-4");
  });

  it("leaves invalid, expired, and malformed capabilities to Filepack safe failures", async () => {
    const forwarded = vi.fn(async (request: Request) => {
      const path = new URL(request.url).pathname;
      if (path.endsWith("v1.expired")) return new Response("", { status: 404 });
      if (path.endsWith("v1.%25")) {
        return new Response(JSON.stringify({ error: { code: "INVALID_REQUEST" } }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("unexpected", { status: 500 });
    });
    const plugin = createFileAttachmentPlugin({
      filepack: fakeApi(forwarded),
      authorizeUpload: () => true,
    });
    let authCalls = 0;
    const handler = chatHandler(plugin, () => {
      authCalls += 1;
      return null;
    });

    const expired = await handler.GET(
      new Request("https://example.test/api/chat/files/downloads/v1.expired"),
    );
    const malformed = await handler.GET(
      new Request("https://example.test/api/chat/files/downloads/v1.%25"),
    );

    expect(expired.status).toBe(404);
    expect(malformed.status).toBe(400);
    expect(await malformed.text()).not.toContain("unexpected");
    expect(forwarded).toHaveBeenCalledTimes(2);
    expect(authCalls).toBe(0);
  });

  it.each([
    ["PUT", "/uploads/attempt-1/content/extra"],
    ["GET", "/downloads/v1.capability/extra"],
    ["POST", "/uploads/attempt-1/content"],
    ["PUT", "/uploads/attempt-1/content?unexpected=1"],
    ["GET", "/downloads/v1.capability?unexpected=1"],
    ["GET", "/downloads/v1."],
    ["PUT", "/uploads/attempt-1/parts/0/content"],
    ["PUT", "/uploads/attempt-1/parts/10001/content"],
    ["PUT", "/uploads//content"],
  ] as const)("does not make near-miss transfer route %s %s public", async (method, path) => {
    const forwarded = vi.fn(async () => new Response("should not reach", { status: 200 }));
    const plugin = createFileAttachmentPlugin({
      filepack: fakeApi(forwarded),
      authorizeUpload: () => true,
    });
    let authCalls = 0;
    const handler = chatHandler(plugin, () => {
      authCalls += 1;
      return null;
    });

    const response = await handler.fetch(
      new Request(`https://example.test/api/chat/files${path}`, { method }),
    );

    expect(response.status).toBe(401);
    expect(forwarded).not.toHaveBeenCalled();
    expect(authCalls).toBe(1);
  });

  it.each([
    ["POST", "/uploads"],
    ["POST", "/uploads/attempt-1/complete"],
    ["GET", "/files/file-1?conversationId=conversation-1"],
    ["DELETE", "/files/file-1?conversationId=conversation-1"],
    ["POST", "/files/file-1/download?conversationId=conversation-1"],
  ] as const)("keeps unauthenticated control route %s %s behind auth", async (method, path) => {
    const forwarded = vi.fn(async () => new Response("should not reach", { status: 200 }));
    const plugin = createFileAttachmentPlugin({
      filepack: fakeApi(forwarded),
      authorizeUpload: () => true,
    });
    let authCalls = 0;
    const handler = chatHandler(plugin, () => {
      authCalls += 1;
      return null;
    });

    const response = await handler.fetch(
      new Request(`https://example.test/api/chat/files${path}`, { method }),
    );

    expect(response.status).toBe(401);
    expect(forwarded).not.toHaveBeenCalled();
    expect(authCalls).toBe(1);
  });

  it("forwards only the explicit owner-bound control allowlist", async () => {
    const forwarded = vi.fn(async () => new Response("forwarded", { status: 200 }));
    const handlerOptions: FilepackHandlerOptions[] = [];
    const plugin = createFileAttachmentPlugin({
      filepack: fakeApi(forwarded, (options) => handlerOptions.push(options)),
      authorizeUpload: () => true,
    });
    const handler = chatHandler(plugin, () => ({ id: "alice" }));
    const controls = [
      ["GET", "/uploads/attempt-1"],
      ["POST", "/uploads/attempt-1/parts/prepare"],
      ["POST", "/uploads/attempt-1/parts/record"],
      ["POST", "/uploads/attempt-1/complete"],
      ["POST", "/uploads/attempt-1/abort"],
    ] as const;

    for (const [method, path] of controls) {
      const response = await handler.fetch(
        new Request(`https://example.test/api/chat/files${path}`, { method }),
      );
      expect(response.status).toBe(200);
    }

    const unknown = await handler.fetch(
      new Request("https://example.test/api/chat/files/uploads/attempt-1/unknown", {
        method: "POST",
      }),
    );
    const deleteFile = await handler.fetch(
      new Request("https://example.test/api/chat/files/files/file-1", { method: "DELETE" }),
    );

    expect(unknown.status).toBe(404);
    expect(deleteFile.status).toBe(404);
    expect(forwarded).toHaveBeenCalledTimes(5);
    expect(handlerOptions).toHaveLength(5);
    for (const options of handlerOptions) {
      expect(options.auth(new Request("https://example.test/"))).toEqual({ id: "alice" });
    }
  });
});
