/**
 * End-to-end smoke test: boots the real example server (`server.ts`) as a
 * child process and exercises every route over actual localhost HTTP -
 * including live SSE delivery and reconnect gap-fill.
 *
 * This is the automated version of the README curl walkthrough. It exists to
 * catch integration breakage the in-process suites can't see: the Node
 * http <-> Web-standard bridge, real network streaming, process boot, etc.
 *
 * Storage backends:
 *   - in-memory - always runs, zero setup
 *   - real Postgres - runs when SMOKE_DATABASE_URL is set (e.g. a Neon URL);
 *     the server creates tables on boot and the suite uses run-unique user
 *     ids so a persistent database never bleeds state between runs.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

const exampleDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

let server: ChildProcess;
let BASE: string;

/** Ask the OS for a free port so parallel/local runs never collide. */
function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, () => {
      const address = probe.address();
      if (address === null || typeof address === "string") {
        reject(new Error("could not determine free port"));
        return;
      }
      probe.close(() => resolve(address.port));
    });
  });
}

async function waitForServer(url: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      await fetch(url); // any response (even 401) means the server is up
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error(`server did not come up within ${timeoutMs}ms: ${String(lastError)}`);
}

function request(
  userId: string | null,
  method: string,
  route: string,
  body?: unknown,
): Promise<Response> {
  return fetch(`${BASE}${route}`, {
    method,
    headers: {
      ...(userId ? { "x-user-id": userId } : {}),
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

async function json(response: Response): Promise<Record<string, any>> {
  expect(response.ok, `${response.url} → ${response.status}`).toBe(true);
  return (await response.json()) as Record<string, any>;
}

interface SseEvent {
  id: string | null;
  event: string | null;
  data: { type: string; message: { id: string; body: string; seq: number } };
}

/** Minimal SSE client over a real network fetch. */
class SseClient {
  readonly events: SseEvent[] = [];
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  private buffer = "";
  // The in-flight read must survive poll iterations: racing a fresh read()
  // against a timer on every loop would abandon reads that later resolve
  // with real chunks, silently dropping them (bites under network latency).
  private pendingRead: Promise<ReadableStreamReadResult<Uint8Array>> | null = null;

  private constructor(response: Response) {
    this.reader = response.body!.getReader();
  }

  static async connect(userId: string, headers: Record<string, string> = {}): Promise<SseClient> {
    const response = await fetch(`${BASE}/stream`, {
      headers: { "x-user-id": userId, ...headers },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    return new SseClient(response);
  }

  async waitForEvents(count: number, timeoutMs = 5000): Promise<SseEvent[]> {
    const deadline = Date.now() + timeoutMs;
    while (this.events.length < count && Date.now() < deadline) {
      this.pendingRead ??= this.reader.read();
      const result = await Promise.race([
        this.pendingRead,
        new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 100)),
      ]);
      if (result === "timeout") continue;
      this.pendingRead = null;
      if (result.done) break;
      this.buffer += new TextDecoder().decode(result.value);
      this.drainBuffer();
    }
    return this.events;
  }

  private drainBuffer(): void {
    const frames = this.buffer.split("\n\n");
    this.buffer = frames.pop() ?? "";
    for (const frame of frames) {
      let id: string | null = null;
      let event: string | null = null;
      let data = "";
      for (const line of frame.split("\n")) {
        if (line.startsWith("id: ")) id = line.slice(4);
        else if (line.startsWith("event: ")) event = line.slice(7);
        else if (line.startsWith("data: ")) data = line.slice(6);
        // ":" comment lines (heartbeats) are ignored
      }
      if (data) this.events.push({ id, event, data: JSON.parse(data) });
    }
  }

  async close(): Promise<void> {
    await this.reader.cancel().catch(() => {});
  }
}

interface Backend {
  name: string;
  databaseUrl: string;
}

// In-memory always runs; real Postgres joins in when SMOKE_DATABASE_URL is
// set (never hardcode credentials here - pass the URL via the environment).
const backends: Backend[] = [{ name: "in-memory", databaseUrl: "" }];
if (process.env.SMOKE_DATABASE_URL) {
  backends.push({ name: "Postgres", databaseUrl: process.env.SMOKE_DATABASE_URL });
}

describe.each(backends)("storage: $name", ({ databaseUrl }) => {
  // A real database keeps rows between runs, so every run gets its own
  // cast of users (pairKey-unique ⇒ fresh conversations, stable assertions).
  const runId = randomUUID().slice(0, 8);
  const users = {
    alice: `alice-${runId}`,
    bob: `bob-${runId}`,
    mallory: `mallory-${runId}`,
    carol: `carol-${runId}`,
    dave: `dave-${runId}`,
  };

  beforeAll(async () => {
    const port = await getFreePort();
    BASE = `http://127.0.0.1:${port}/api/chat`;

    server = spawn("node", ["--experimental-strip-types", "server.ts"], {
      cwd: exampleDir,
      env: {
        ...process.env,
        PORT: String(port),
        DATABASE_URL: databaseUrl,
        CHATPACK_TELEMETRY: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    server.stderr!.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      // Node prints an ExperimentalWarning for --experimental-strip-types; real errors matter.
      if (!text.includes("Warning")) process.stderr.write(`[server] ${text}`);
    });

    // Postgres boot includes TLS + idempotent migration, so allow extra time.
    await waitForServer(`${BASE}/conversations`, 45_000);
  }, 60_000);

  afterAll(() => {
    server?.kill("SIGTERM");
  });

  describe("REST over real HTTP (the curl walkthrough)", () => {
    it("rejects unauthenticated requests with 401", async () => {
      const response = await request(null, "GET", "/conversations");
      expect(response.status).toBe(401);
      const body = (await response.json()) as { error: { code: string } };
      expect(body.error.code).toBeDefined();
    });

    it("find-or-create is idempotent, then send / list / read / edit / delete", async () => {
      // alice finds-or-creates a conversation with bob - twice, same id
      const first = await json(
        await request(users.alice, "POST", "/conversations", { otherUserId: users.bob }),
      );
      const second = await json(
        await request(users.alice, "POST", "/conversations", { otherUserId: users.bob }),
      );
      const conversationId: string = first.conversation.id;
      expect(second.conversation.id).toBe(conversationId);

      // both sides send
      const sent = await json(
        await request(users.alice, "POST", `/conversations/${conversationId}/messages`, {
          body: "hey bob!",
        }),
      );
      await json(
        await request(users.bob, "POST", `/conversations/${conversationId}/messages`, {
          body: "hey alice!",
        }),
      );

      // bob lists history (newest first)
      const list = await json(
        await request(users.bob, "GET", `/conversations/${conversationId}/messages`),
      );
      expect(list.messages.map((m: { body: string }) => m.body)).toEqual([
        "hey alice!",
        "hey bob!",
      ]);

      // conversation endpoints
      const conversations = await json(await request(users.bob, "GET", "/conversations"));
      expect(conversations.conversations).toHaveLength(1);
      const one = await json(await request(users.bob, "GET", `/conversations/${conversationId}`));
      expect(one.conversation.id).toBe(conversationId);

      // bob marks read
      const read = await json(
        await request(users.bob, "POST", `/conversations/${conversationId}/read`, {
          messageId: sent.message.id,
        }),
      );
      expect(read).toBeDefined();

      // alice edits then soft-deletes her message
      const edited = await json(
        await request(users.alice, "PATCH", `/messages/${sent.message.id}`, {
          body: "hey bob! (edited)",
        }),
      );
      expect(edited.message.body).toBe("hey bob! (edited)");
      const deleted = await json(
        await request(users.alice, "DELETE", `/messages/${sent.message.id}`),
      );
      expect(deleted.message.deletedAt).toBeTruthy();
    });

    it("enforces permissions: non-participants get 403", async () => {
      const { conversation } = await json(
        await request(users.alice, "POST", "/conversations", { otherUserId: users.bob }),
      );
      const response = await request(
        users.mallory,
        "GET",
        `/conversations/${conversation.id}/messages`,
      );
      expect(response.status).toBe(403);
    });
  });

  describe("SSE over a real network connection", () => {
    it("delivers messages live, and gap-fills on reconnect with Last-Event-ID", async () => {
      const { conversation } = await json(
        await request(users.carol, "POST", "/conversations", { otherUserId: users.dave }),
      );

      // dave listens; carol sends → live delivery
      const dave = await SseClient.connect(users.dave);
      try {
        await json(
          await request(users.carol, "POST", `/conversations/${conversation.id}/messages`, {
            body: "live!",
          }),
        );
        const [live] = await dave.waitForEvents(1);
        expect(live!.event).toBe("message.created");
        expect(live!.data.message.body).toBe("live!");
        expect(live!.id).toBe(`${conversation.id}:${live!.data.message.seq}`);

        // dave drops, misses two messages…
        const lastSeenId = live!.id!;
        await dave.close();
        await json(
          await request(users.carol, "POST", `/conversations/${conversation.id}/messages`, {
            body: "missed 1",
          }),
        );
        await json(
          await request(users.carol, "POST", `/conversations/${conversation.id}/messages`, {
            body: "missed 2",
          }),
        );

        // …reconnects with Last-Event-ID → backfill, then live delivery resumes
        const daveAgain = await SseClient.connect(users.dave, { "last-event-id": lastSeenId });
        try {
          const replayed = await daveAgain.waitForEvents(2);
          expect(replayed.map((e) => e.data.message.body)).toEqual(["missed 1", "missed 2"]);

          await json(
            await request(users.carol, "POST", `/conversations/${conversation.id}/messages`, {
              body: "live again",
            }),
          );
          const all = await daveAgain.waitForEvents(3);
          expect(all.map((e) => e.data.message.body)).toEqual([
            "missed 1",
            "missed 2",
            "live again",
          ]);
        } finally {
          await daveAgain.close();
        }
      } finally {
        await dave.close();
      }
    });

    it("rejects unauthenticated stream connections with 401", async () => {
      const response = await fetch(`${BASE}/stream`);
      expect(response.status).toBe(401);
      await response.body?.cancel();
    });
  });
});
