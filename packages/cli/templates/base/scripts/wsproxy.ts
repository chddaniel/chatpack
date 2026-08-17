/**
 * Local-development only: bridges the Neon driver's WebSocket transport to a
 * plain Postgres TCP port.
 *
 * Neon's edge normally terminates that WebSocket for you. Point a local app at
 * a Docker Postgres and there is nothing on the other end, so this stands in for
 * that one piece - it copies bytes, it does not understand the wire protocol.
 *
 * Run it beside `dev`, with `NEON_WS_PROXY=127.0.0.1:5480` in your environment:
 *
 *   docker run -d --name chat-pg -e POSTGRES_PASSWORD=postgres -p 5432:5432 postgres:17
 *   {{PACKAGE_MANAGER}} run db:proxy
 *
 * Never deploy this. Production talks to Neon directly over TLS.
 */
import net from "node:net";

import { config } from "dotenv";
import { WebSocketServer } from "ws";

// Read the same env files the app does, so WSPROXY_* and the port the app
// expects live in one place instead of being retyped on the command line.
config({ path: "{{ENV_FILE}}" });
config();

const port = Number(process.env.WSPROXY_PORT ?? 5480);
const databaseHost = process.env.WSPROXY_PG_HOST ?? "127.0.0.1";
const databasePort = Number(process.env.WSPROXY_PG_PORT ?? 5432);

const server = new WebSocketServer({ port });

server.on("error", (error: NodeJS.ErrnoException) => {
  // A stray proxy from an earlier session is the usual cause, and an unhandled
  // EADDRINUSE stack trace is a poor way to say so.
  if (error.code === "EADDRINUSE") {
    console.error(
      `[db:proxy] port ${port} is already in use. Stop the other process, or set WSPROXY_PORT and NEON_WS_PROXY to a free port.`,
    );
    process.exit(1);
  }
  throw error;
});

server.on("connection", (socket) => {
  const upstream = net.connect(databasePort, databaseHost);
  // The client can start talking before the TCP handshake finishes, so hold
  // those first bytes rather than dropping them.
  const pending: Buffer[] = [];
  let connected = false;

  upstream.on("connect", () => {
    connected = true;
    for (const chunk of pending.splice(0)) upstream.write(chunk);
  });
  upstream.on("data", (chunk) => {
    if (socket.readyState === socket.OPEN) socket.send(chunk);
  });
  upstream.on("error", (error) => {
    console.error(`[db:proxy] upstream error: ${(error as Error).message}`);
    socket.close();
  });
  upstream.on("close", () => socket.close());

  socket.on("message", (data) => {
    const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
    if (connected) upstream.write(chunk);
    else pending.push(chunk);
  });
  socket.on("close", () => upstream.destroy());
  socket.on("error", () => upstream.destroy());
});

console.log(`[db:proxy] ws://127.0.0.1:${port} -> ${databaseHost}:${databasePort}`);
console.log("[db:proxy] set NEON_WS_PROXY=127.0.0.1:%d and DATABASE_URL=...?sslmode=disable", port);
