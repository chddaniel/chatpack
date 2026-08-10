import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { memoryAdapter } from "@filepack/adapter-memory";
import {
  createFilepack,
  route,
  type FilepackApi,
  type FilepackHandlerOptions,
  type FilepackRouter,
} from "@filepack/core";
import { localAdapter } from "@filepack/storage-local";
import { chatpack, type ChatpackHandler, type StorageAdapter } from "@chatpack/core";
import { createFileAttachmentPlugin } from "../src/index";

const actor = { id: "alice" };
const routes = {
  chat: route({
    accepts: ["image/png"],
    maxFileSize: 10 * 1024 * 1024,
    maxFileCount: 1,
  }),
} as const;

interface Fixture {
  readonly directory: string;
  readonly filepack: FilepackApi<FilepackRouter>;
  readonly handler: ChatpackHandler;
  readonly auth: ReturnType<typeof vi.fn>;
  readonly filepackAuth: ReturnType<typeof vi.fn>;
}

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

async function fixture(): Promise<Fixture> {
  const directory = await mkdtemp(join(tmpdir(), "chatpack-file-capability-"));
  directories.push(directory);
  const filepack = createFilepack({
    routes,
    records: memoryAdapter(),
    storage: localAdapter({ directory }),
    basePath: "/filepack",
    uploadTargetTtlSeconds: 1,
    multipart: {
      thresholdBytes: 5 * 1024 * 1024,
      partSizeBytes: 5 * 1024 * 1024,
    },
  });
  const filepackAuth = vi.fn();
  const pluginFilepack = {
    ...filepack,
    handler(options: FilepackHandlerOptions) {
      return filepack.handler({
        ...options,
        auth: async (request) => {
          filepackAuth();
          return options.auth(request);
        },
      });
    },
  } as FilepackApi<FilepackRouter>;
  const plugin = createFileAttachmentPlugin({
    filepack: pluginFilepack,
    mountPath: "assets",
    authorizeUpload: () => true,
  });
  const auth = vi.fn(async (request: Request) => {
    const id = request.headers.get("x-user-id");
    return id === null ? null : { id };
  });
  const handler = chatpack({
    storage: {} as StorageAdapter,
    telemetry: false,
    auth,
    plugins: [plugin],
  }).handler({ basePath: "/messaging", heartbeatIntervalMs: 0 });
  return { directory, filepack, handler, auth, filepackAuth };
}

function chatPath(path: string): string {
  return `https://example.test/messaging/assets${path}`;
}

function transferUrl(targetUrl: string, pathPrefix: string): string {
  const url = new URL(targetUrl, "https://example.test");
  return `https://example.test/messaging/assets${url.pathname.slice(pathPrefix.length)}`;
}

describe("Filepack capability transfers through Chatpack", () => {
  it("forwards single PUT and ranged download without host or Filepack auth", async () => {
    const { filepack, handler, auth, filepackAuth } = await fixture();
    const content = new TextEncoder().encode("hello");
    const [plan] = await filepack.createUploadPlans({
      actor,
      route: "chat",
      routeInput: undefined as never,
      files: [{ name: "photo.png", type: "image/png", size: content.byteLength }],
    });
    if (plan === undefined || plan.target.kind !== "single")
      throw new Error("single plan expected");

    const uploadResponse = await handler.PUT(
      new Request(transferUrl(plan.target.url, "/filepack"), {
        method: "PUT",
        headers: {
          ...plan.target.headers,
          "content-type": "image/png",
        },
        body: content,
      }),
    );
    expect(uploadResponse.status).toBe(204);
    expect(auth).not.toHaveBeenCalled();

    const file = await filepack.completeUpload({ actor, attemptId: plan.attemptId });
    const download = await filepack.prepareFileDownload({ actor, fileId: file.id });
    const downloadResponse = await handler.GET(
      new Request(transferUrl(download.url, "/filepack"), {
        headers: { range: "bytes=1-3" },
      }),
    );

    expect(downloadResponse.status).toBe(206);
    expect(downloadResponse.headers.get("content-range")).toBe("bytes 1-3/5");
    expect(await downloadResponse.text()).toBe("ell");
    expect(auth).not.toHaveBeenCalled();
    expect(filepackAuth).not.toHaveBeenCalled();
  });

  it("forwards multipart PUT through the exact capability route", async () => {
    const { filepack, handler, auth, filepackAuth } = await fixture();
    const content = new Uint8Array(5 * 1024 * 1024).fill(65);
    const [plan] = await filepack.createUploadPlans({
      actor,
      route: "chat",
      routeInput: undefined as never,
      files: [{ name: "large.png", type: "image/png", size: content.byteLength }],
    });
    if (plan === undefined || plan.target.kind !== "multipart") {
      throw new Error("multipart plan expected");
    }

    const prepared = await filepack.prepareUploadParts({
      actor,
      attemptId: plan.attemptId,
      partNumbers: [1],
    });
    const [part] = prepared.targets;
    if (part === undefined) throw new Error("multipart target expected");
    const response = await handler.PUT(
      new Request(transferUrl(part.url, "/filepack"), {
        method: "PUT",
        headers: { ...part.headers, "content-type": "image/png" },
        body: content,
      }),
    );

    expect(response.status).toBe(204);
    expect(auth).not.toHaveBeenCalled();
    expect(filepackAuth).not.toHaveBeenCalled();
  });

  it("keeps controls outer-authenticated and rejects invalid transfer capabilities safely", async () => {
    const { filepack, handler, auth, filepackAuth } = await fixture();
    const [plan] = await filepack.createUploadPlans({
      actor,
      route: "chat",
      routeInput: undefined as never,
      files: [{ name: "photo.png", type: "image/png", size: 5 }],
    });
    if (plan === undefined || plan.target.kind !== "single")
      throw new Error("single plan expected");

    const invalid = await handler.GET(new Request(chatPath("/downloads/v1.invalid-capability")));
    const malformed = await handler.GET(new Request(chatPath("/downloads/v1.%25")));
    const badContentType = await handler.PUT(
      new Request(transferUrl(plan.target.url, "/filepack"), {
        method: "PUT",
        headers: { ...plan.target.headers, "content-type": "text/plain" },
        body: "hello",
      }),
    );
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 2_000);
    const expiredUpload = await handler.PUT(
      new Request(transferUrl(plan.target.url, "/filepack"), {
        method: "PUT",
        headers: { ...plan.target.headers, "content-type": "image/png" },
        body: "hello",
      }),
    );
    vi.useRealTimers();
    const unauthenticatedControl = await handler.GET(
      new Request(chatPath(`/uploads/${plan.attemptId}`)),
    );
    const authenticatedControl = await handler.GET(
      new Request(chatPath(`/uploads/${plan.attemptId}`), {
        headers: { "x-user-id": "alice" },
      }),
    );
    const wrongOwnerControl = await handler.GET(
      new Request(chatPath(`/uploads/${plan.attemptId}`), {
        headers: { "x-user-id": "bob" },
      }),
    );

    expect(invalid.status).not.toBe(200);
    expect(malformed.status).not.toBe(200);
    expect(badContentType.status).not.toBe(204);
    expect(expiredUpload.status).not.toBe(204);
    expect(unauthenticatedControl.status).toBe(401);
    expect(authenticatedControl.status).toBe(200);
    expect(wrongOwnerControl.status).toBe(404);
    expect(auth).toHaveBeenCalledTimes(3);
    expect(filepackAuth).toHaveBeenCalledTimes(2);
  });

  // Filepack's `complete`/`abort` controls call `rejectOperationBody`, which
  // throws INVALID_REQUEST unless `request.body === null`. Next.js hands route
  // handlers a non-null (empty) body, so hosts had to strip it themselves.
  // Absorbed here so the framework difference never reaches the host.
  it("accepts complete and abort with an empty but non-null body (Next.js shape)", async () => {
    const { filepack, handler } = await fixture();
    const content = new TextEncoder().encode("hello");
    const [plan] = await filepack.createUploadPlans({
      actor,
      route: "chat",
      routeInput: undefined as never,
      files: [{ name: "photo.png", type: "image/png", size: content.byteLength }],
    });
    if (plan === undefined || plan.target.kind !== "single")
      throw new Error("single plan expected");

    const uploaded = await handler.PUT(
      new Request(transferUrl(plan.target.url, "/filepack"), {
        method: "PUT",
        headers: { ...plan.target.headers, "content-type": "image/png" },
        body: content,
      }),
    );
    expect(uploaded.status).toBe(204);

    // The shape Next.js produces: a body that is present but empty.
    const completed = await handler.POST(
      new Request(chatPath(`/uploads/${plan.attemptId}/complete`), {
        method: "POST",
        headers: { "content-type": "application/json", "x-user-id": "alice" },
        body: "",
      }),
    );
    expect(completed.status).toBe(200);

    // Same for abort, on a fresh attempt.
    const [second] = await filepack.createUploadPlans({
      actor,
      route: "chat",
      routeInput: undefined as never,
      files: [{ name: "other.png", type: "image/png", size: 5 }],
    });
    if (second === undefined) throw new Error("second plan expected");
    const aborted = await handler.POST(
      new Request(chatPath(`/uploads/${second.attemptId}/abort`), {
        method: "POST",
        headers: { "content-type": "application/json", "x-user-id": "alice" },
        body: "",
      }),
    );
    expect(aborted.status).toBe(200);
  });

  // The empty-body normalization must not become "ignore whatever the caller
  // sent". A control route that carries real bytes is still Filepack's to
  // reject, so the request is forwarded untouched.
  it("still rejects an upload control that carries a real body", async () => {
    const { filepack, handler } = await fixture();
    const [plan] = await filepack.createUploadPlans({
      actor,
      route: "chat",
      routeInput: undefined as never,
      files: [{ name: "photo.png", type: "image/png", size: 5 }],
    });
    if (plan === undefined) throw new Error("plan expected");

    const withPayload = await handler.POST(
      new Request(chatPath(`/uploads/${plan.attemptId}/abort`), {
        method: "POST",
        headers: { "content-type": "application/json", "x-user-id": "alice" },
        body: JSON.stringify({ unexpected: "payload" }),
      }),
    );
    expect(withPayload.status).toBe(400);
  });
});
