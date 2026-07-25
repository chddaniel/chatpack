/**
 * A complete 1:1 messenger — Chatpack backend + vanilla HTML/JS frontend,
 * served by this single Node file. Zero configuration, in-memory storage.
 *
 * What lives where:
 *   - Chat backend  → `chatpack()` + `chat.handler()` on /api/chat/* (Chatpack)
 *   - Demo auth     → /auth/* routes + a session cookie              (yours)
 *   - Frontend      → static files from ./public                    (yours)
 *
 * Auth is cookie-based on purpose: the browser sends cookies automatically
 * on every request INCLUDING the SSE stream, where `EventSource` cannot set
 * custom headers. The cookie here is just the raw username — DEMO ONLY. In a
 * real app, use your auth library's session and verify it in the `auth` hook.
 *
 * Run:   pnpm --filter example-messenger start
 * Then:  open http://localhost:3000 in two browser windows.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

import { chatpack } from "@chatpack/core";
import { memoryAdapter } from "@chatpack/adapter-memory";

const SESSION_COOKIE = "demo_user";
// No ":" allowed — Chatpack derives conversation pairKeys as "idA:idB".
const USERNAME_RE = /^[a-zA-Z0-9_-]{1,32}$/;

// ---------------------------------------------------------------------------
// 1. The chat server — this is the entire Chatpack setup.
// ---------------------------------------------------------------------------
const chat = chatpack({
  storage: memoryAdapter(),
  auth: (request) => {
    const cookie = request.headers.get("cookie") ?? "";
    const raw = cookie.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`))?.[1];
    const userId = raw ? decodeURIComponent(raw) : null;
    return userId && USERNAME_RE.test(userId) ? { id: userId } : null;
  },
});

const handler = chat.handler(); // serves everything under /api/chat
const PORT = Number(process.env.PORT ?? 3000);
const PUBLIC_DIR = join(import.meta.dirname, "public");

// ---------------------------------------------------------------------------
// 2. Demo auth routes — replace with your real auth library in production.
// ---------------------------------------------------------------------------
function json(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
) {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

async function handleAuth(req: IncomingMessage, res: ServerResponse, pathname: string) {
  if (pathname === "/auth/login" && req.method === "POST") {
    let username = "";
    try {
      username = String(JSON.parse((await readBody(req)).toString()).username ?? "").trim();
    } catch {
      /* fall through to validation */
    }
    if (!USERNAME_RE.test(username)) {
      return json(res, 400, { error: "Username must be 1-32 chars: letters, digits, _ or -" });
    }
    return json(
      res,
      200,
      { id: username },
      {
        "set-cookie": `${SESSION_COOKIE}=${encodeURIComponent(username)}; Path=/; HttpOnly; SameSite=Lax`,
      },
    );
  }

  if (pathname === "/auth/logout" && req.method === "POST") {
    return json(
      res,
      200,
      { ok: true },
      {
        "set-cookie": `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
      },
    );
  }

  if (pathname === "/auth/me" && req.method === "GET") {
    const raw = (req.headers.cookie ?? "").match(
      new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`),
    )?.[1];
    const userId = raw ? decodeURIComponent(raw) : null;
    if (!userId || !USERNAME_RE.test(userId)) return json(res, 401, { error: "Not signed in" });
    return json(res, 200, { id: userId });
  }

  return json(res, 404, { error: "Not found" });
}

// ---------------------------------------------------------------------------
// 3. Static frontend — index.html, app.js, styles.css from ./public.
// ---------------------------------------------------------------------------
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
};

async function serveStatic(res: ServerResponse, pathname: string) {
  const file = pathname === "/" ? "index.html" : normalize(pathname).replace(/^[/\\]+/, "");
  try {
    const contents = await readFile(join(PUBLIC_DIR, file));
    res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
    res.end(contents);
  } catch {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("Not found");
  }
}

// ---------------------------------------------------------------------------
// 4. Bridge Node's http server to the Web-standard Chatpack handler.
//    (On Bun/Deno/Workers/Next.js you'd pass `handler.fetch` directly.)
// ---------------------------------------------------------------------------
async function serveChat(req: IncomingMessage, res: ServerResponse, url: string) {
  const body = await readBody(req);
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
}

const server = createServer(async (req, res) => {
  const url = `http://${req.headers.host ?? `localhost:${PORT}`}${req.url ?? "/"}`;
  const pathname = new URL(url).pathname;

  if (pathname.startsWith("/api/chat")) return serveChat(req, res, url);
  if (pathname.startsWith("/auth/")) return handleAuth(req, res, pathname);
  return serveStatic(res, pathname);
});

server.listen(PORT, () => {
  console.log(`Messenger running — open http://localhost:${PORT} in two browser windows`);
  console.log(`(sign in as e.g. "alice" in one and "bob" in the other)`);
});
