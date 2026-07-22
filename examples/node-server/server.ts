/**
 * Minimal curl-able Chatpack server — REST + SSE, on in-memory or Postgres
 * storage (the M2/M3/M4 demo).
 *
 * Storage:
 *   - default            → in-memory (zero setup, data lost on exit)
 *   - DATABASE_URL set   → Postgres via @chatpack/adapter-drizzle (M4).
 *     Tables are created automatically on boot (idempotent).
 *
 * Auth here is a deliberately naive `x-user-id` header so you can play with
 * the API from curl. In a real app the auth hook resolves a session/JWT.
 *
 * Run:   pnpm --filter example-node-server start
 * Or:    DATABASE_URL=postgres://localhost:5432/chatpack pnpm --filter example-node-server start
 * Then:  see README.md for the curl walkthrough (including live SSE).
 */
import { createServer } from "node:http";

import { chatpack, type StorageAdapter } from "@chatpack/core";
import { memoryAdapter } from "@chatpack/adapter-memory";
import { drizzleAdapter, migrationSql } from "@chatpack/adapter-drizzle";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";

async function createStorage(): Promise<StorageAdapter> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.log("storage: in-memory (set DATABASE_URL for Postgres)");
    return memoryAdapter();
  }

  const pool = new pg.Pool({ connectionString: databaseUrl });
  await pool.query(migrationSql); // idempotent CREATE TABLE IF NOT EXISTS
  console.log(`storage: Postgres (${databaseUrl.replace(/\/\/[^@]*@/, "//***@")})`);
  return drizzleAdapter(drizzle(pool));
}

const chat = chatpack({
  storage: await createStorage(),
  // DEMO ONLY: trust an x-user-id header. Real apps verify a session here.
  auth: (request) => {
    const userId = request.headers.get("x-user-id");
    return userId ? { id: userId } : null;
  },
});

const handler = chat.handler(); // basePath defaults to /api/chat
const PORT = Number(process.env.PORT ?? 3000);

// Node http <-> Web-standard Request/Response bridge (~20 lines).
// On Bun/Deno/Workers you would pass `handler.fetch` directly.
const server = createServer(async (req, res) => {
  const url = `http://${req.headers.host ?? `localhost:${PORT}`}${req.url ?? "/"}`;

  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const body = Buffer.concat(chunks);

  const request = new Request(url, {
    method: req.method ?? "GET",
    headers: Object.entries(req.headers).flatMap(([name, value]) =>
      value === undefined
        ? []
        : Array.isArray(value)
          ? value.map((v): [string, string] => [name, v])
          : ([[name, value]] as [string, string][]),
    ),
    body: body.length > 0 ? new Uint8Array(body) : null,
  });

  const response = await handler.fetch(request);

  res.writeHead(response.status, Object.fromEntries(response.headers.entries()));

  // Stream the body (required for SSE; harmless for JSON).
  if (response.body) {
    const reader = response.body.getReader();
    req.on("close", () => void reader.cancel().catch(() => {}));
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
      }
    } catch {
      // client disconnected mid-stream — fine
    }
  }
  res.end();
});

server.listen(PORT, () => {
  console.log(`Chatpack example listening on http://localhost:${PORT}/api/chat`);
  console.log(`Try: curl -s -X POST http://localhost:${PORT}/api/chat/conversations \\`);
  console.log(`       -H 'x-user-id: alice' -H 'content-type: application/json' \\`);
  console.log(`       -d '{"otherUserId":"bob"}'`);
});
