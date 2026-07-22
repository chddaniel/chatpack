/**
 * Minimal curl-able Chatpack server — the M2 + M3 demo (REST + SSE).
 *
 * Auth here is a deliberately naive `x-user-id` header so you can play with
 * the API from curl. In a real app the auth hook resolves a session/JWT.
 *
 * Run:   pnpm --filter example-node-server start
 * Then:  see README.md for the curl walkthrough (including live SSE).
 */
import { createServer } from "node:http";

import { chatpack } from "@chatpack/core";
import { memoryAdapter } from "@chatpack/adapter-memory";

const chat = chatpack({
  storage: memoryAdapter(),
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
