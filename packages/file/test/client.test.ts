import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FilepackFile, FilepackRouter } from "@filepack/core";
import { createChatpackFileClient } from "../src/client";

const NOW = new Date("2026-08-04T00:00:00.000Z");
const FILE: FilepackFile = {
  id: "file-1",
  route: "chat",
  name: "photo.png",
  contentType: "image/png",
  size: 12,
  routeMetadata: { conversationId: "conversation-1" },
  createdAt: NOW.toISOString(),
  readyAt: "2026-08-04T00:00:01.000Z",
};
const INPUT = { conversationId: "conversation-1", fileId: "file-1" } as const;

describe("Chatpack Filepack client", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reuses a target while it remains valid beyond the safety window", async () => {
    let requestedDelivery: unknown;
    const harness = createHarness((_call, init) => {
      requestedDelivery = JSON.parse(String(init?.body)).delivery;
      return targetResponse("target-1", Date.now() + 60_000);
    });

    const first = await harness.client.resolveTarget(INPUT);
    vi.setSystemTime(Date.now() + 54_999);
    const second = await harness.client.resolveTarget(INPUT);

    expect(first).toMatchObject({
      status: "available",
      kind: "inline",
      delivery: "inline",
      url: "/api/chat/files/downloads/v1.target-1",
    });
    expect(second).toEqual(first);
    expect(harness.calls).toEqual({ metadata: 1, target: 1 });
    expect(requestedDelivery).toBe("inline");
  });

  it.each([
    ["the expiry safety boundary", 55_000],
    ["expiry", 60_000],
  ])("automatically refreshes a target at %s", async (_case, elapsed) => {
    const harness = createHarness((call) =>
      targetResponse(`target-${call}`, NOW.getTime() + (call === 1 ? 60_000 : 120_000)),
    );

    const first = await harness.client.resolveTarget(INPUT);
    vi.setSystemTime(NOW.getTime() + elapsed);
    const second = await harness.client.resolveTarget(INPUT);

    expect(first).toMatchObject({ url: "/api/chat/files/downloads/v1.target-1" });
    expect(second).toMatchObject({ url: "/api/chat/files/downloads/v1.target-2" });
    expect(harness.calls).toEqual({ metadata: 1, target: 2 });
  });

  it("refreshes a still-valid target when force is true", async () => {
    const harness = createHarness((call) => targetResponse(`target-${call}`, Date.now() + 60_000));

    const first = await harness.client.resolveTarget(INPUT);
    const second = await harness.client.resolveTarget({ ...INPUT, force: true });

    expect(first).toMatchObject({ url: "/api/chat/files/downloads/v1.target-1" });
    expect(second).toMatchObject({ url: "/api/chat/files/downloads/v1.target-2" });
    expect(harness.calls).toEqual({ metadata: 1, target: 2 });
  });

  it("deduplicates concurrent automatic refresh requests", async () => {
    const pendingTarget = deferred<Response>();
    const targetStarted = deferred<void>();
    const harness = createHarness((call) => {
      if (call === 1) return targetResponse("target-1", NOW.getTime() + 60_000);
      targetStarted.resolve(undefined);
      return pendingTarget.promise;
    });

    await harness.client.resolveTarget(INPUT);
    vi.setSystemTime(NOW.getTime() + 55_000);
    const first = harness.client.resolveTarget(INPUT);
    const second = harness.client.resolveTarget(INPUT);
    await targetStarted.promise;

    expect(harness.calls).toEqual({ metadata: 1, target: 2 });
    pendingTarget.resolve(targetResponse("target-2", Date.now() + 60_000));
    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ url: "/api/chat/files/downloads/v1.target-2" }),
      expect.objectContaining({ url: "/api/chat/files/downloads/v1.target-2" }),
    ]);
  });

  it("evicts a rejected target request so the next call can retry", async () => {
    const harness = createHarness((call) =>
      call === 1
        ? jsonResponse({ error: "temporary" }, 500)
        : targetResponse("target-2", Date.now() + 60_000),
    );

    await expect(harness.client.resolveTarget(INPUT)).rejects.toMatchObject({ status: 500 });
    await expect(harness.client.resolveTarget(INPUT)).resolves.toMatchObject({
      url: "/api/chat/files/downloads/v1.target-2",
    });
    expect(harness.calls).toEqual({ metadata: 1, target: 2 });
  });

  it("evicts a rejected metadata request so the next call can retry", async () => {
    const harness = createHarness(
      () => targetResponse("target-1", Date.now() + 60_000),
      (call) => (call === 1 ? jsonResponse({ error: "temporary" }, 500) : metadataResponse()),
    );

    await expect(harness.client.resolveTarget(INPUT)).rejects.toMatchObject({ status: 500 });
    await expect(harness.client.resolveTarget(INPUT)).resolves.toMatchObject({
      url: "/api/chat/files/downloads/v1.target-1",
    });
    expect(harness.calls).toEqual({ metadata: 2, target: 1 });
  });

  it("does not cache a target with an invalid expiry indefinitely", async () => {
    const harness = createHarness((call) =>
      call === 1
        ? jsonResponse({
            url: "/api/chat/files/downloads/v1.target-1",
            expiresAt: "not-a-date",
          })
        : targetResponse("target-2", Date.now() + 60_000),
    );

    const first = await harness.client.resolveTarget(INPUT);
    const second = await harness.client.resolveTarget(INPUT);

    expect(first).toMatchObject({ url: "/api/chat/files/downloads/v1.target-1" });
    expect(second).toMatchObject({ url: "/api/chat/files/downloads/v1.target-2" });
    expect(harness.calls).toEqual({ metadata: 1, target: 2 });
  });
});

type ResponseFactory = (
  call: number,
  init: RequestInit | undefined,
) => Response | Promise<Response>;

function createHarness(target: ResponseFactory, metadata: ResponseFactory = metadataResponse) {
  const calls = { metadata: 0, target: 0 };
  const fetcher: typeof globalThis.fetch = async (_input, init) => {
    if (init?.method === "POST") {
      calls.target += 1;
      return target(calls.target, init);
    }
    calls.metadata += 1;
    return metadata(calls.metadata, init);
  };
  return {
    calls,
    client: createChatpackFileClient<FilepackRouter>({
      basePath: "/api/chat/files",
      controlFetch: fetcher,
    }),
  };
}

function metadataResponse(): Response {
  return jsonResponse({ file: FILE });
}

function targetResponse(target: string, expiresAt: number): Response {
  return jsonResponse({
    url: `/api/chat/files/downloads/v1.${target}`,
    expiresAt: new Date(expiresAt).toISOString(),
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
