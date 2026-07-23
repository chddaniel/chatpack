<div align="center">

# Chatpack

**Open-source chat infrastructure for developers.**

Install a package, wire up your database and auth, and get a production-ready
1:1 chat backend — conversations, messages, permissions, read-state, and
real-time delivery — without rebuilding it from scratch.

[![CI](https://github.com/chddaniel/chatpack/actions/workflows/ci.yml/badge.svg)](https://github.com/chddaniel/chatpack/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

</div>

---

> **Status: `0.1.0` — the v0 MVP is complete.** All five milestones (core
> engine, HTTP handler, real-time SSE, Postgres adapter, launch polish) are
> shipped and on npm. The API is young — expect minor breaking changes before
> `1.0`. Follow along or [contribute](./CONTRIBUTING.md).

## Why

Every app that needs messaging ends up rebuilding the same things: conversations,
messages, permissions, read receipts, real-time delivery, and countless edge cases.

Chatpack removes that repetition — the same way BetterAuth did for authentication.
You bring your **auth** and your **frontend**; Chatpack gives you a small,
well-designed chat backend that just works.

## Quickstart

### 1. Install

Both packages are needed for the quickstart — `@chatpack/core` is the engine,
`@chatpack/adapter-memory` is the storage it plugs into:

```sh
# pick your package manager
npm  install @chatpack/core @chatpack/adapter-memory
pnpm add     @chatpack/core @chatpack/adapter-memory
bun  add     @chatpack/core @chatpack/adapter-memory
```

> **Bun note:** if Bun's supply-chain guard (`minimumReleaseAge`) is enabled,
> versions published in the last 24 h are skipped and Bun silently resolves an
> older release. If you get an unexpectedly old version right after a release,
> that's the guard — not a broken package. Check with
> `npm view @chatpack/core dist-tags`.

### 2. Create your chat server

```ts
// lib/chat.ts
import { chatpack } from "@chatpack/core";
import { memoryAdapter } from "@chatpack/adapter-memory";

export const chat = chatpack({
  storage: memoryAdapter(),
  // resolve the current user from a request — the ONLY auth touchpoint
  auth: async (req) => getSessionUser(req),
});
```

> **The `auth` hook must return `ChatpackUser | null`** — an object with at
> least `{ id: string }` (extra fields are allowed and ignored), or `null`
> for unauthenticated requests. Returning a bare string is treated as
> unauthenticated and every request will get a `401`.

For production, swap the storage line for Postgres —
[`@chatpack/adapter-drizzle`](./packages/adapter-drizzle):

```ts
import { drizzle } from "drizzle-orm/node-postgres";
import { drizzleAdapter } from "@chatpack/adapter-drizzle";

export const chat = chatpack({
  storage: drizzleAdapter(drizzle(process.env.DATABASE_URL!)),
  auth: async (req) => getSessionUser(req),
});
```

### 3. Mount the API (Next.js App Router)

```ts
// app/api/chat/[...chatpack]/route.ts
import { chat } from "@/lib/chat";
export const { GET, POST, PATCH, DELETE } = chat.handler();
```

> **The route file must be a catch-all** (`[...chatpack]` in Next.js) —
> Chatpack serves many sub-paths under `basePath` (default `/api/chat`), so a
> single `app/api/chat/route.ts` would 404 everything but the root.

Your chat backend is now live at `/api/chat` — find-or-create conversations,
send/list/edit/delete messages, read-state, and a **live SSE stream** at
`/api/chat/stream`, with your auth enforced on every request.

Not on Next.js? The handler is Web-standard (`Request` → `Response`) and
`GET`/`POST`/`PATCH`/`DELETE`/`fetch` are **all the same function** — the
method names only exist so they can be re-exported from a Next.js route file.
Any of them serves every route, including `/stream`:

```ts
const handler = chat.handler();

Bun.serve({ fetch: handler.fetch }); // Bun / Deno / Cloudflare Workers

app.all("/api/chat/*", (c) => handler.fetch(c.req.raw)); // Hono
app.all("/api/chat/*", ({ request }) => handler.fetch(request)); // Elysia
```

For plain Node, see [`examples/node-server`](./examples/node-server).

### 4. Call it over HTTP

Find-or-create a conversation (the authenticated user + `otherUserId`):

```sh
curl -X POST /api/chat/conversations \
  -H 'content-type: application/json' \
  -d '{"otherUserId": "bob"}'
```

```json
{
  "conversation": {
    "id": "conv_1",
    "pairKey": "alice:bob",
    "createdAt": "2026-07-22T19:47:47.945Z",
    "metadata": {},
    "participants": [
      { "conversationId": "conv_1", "userId": "alice", "joinedAt": "…", "lastReadMessageId": null },
      { "conversationId": "conv_1", "userId": "bob", "joinedAt": "…", "lastReadMessageId": null }
    ]
  }
}
```

Send a message — note the field is **`body`**:

```sh
curl -X POST /api/chat/conversations/conv_1/messages \
  -H 'content-type: application/json' \
  -d '{"body": "hey bob!"}'
```

```json
{
  "message": {
    "id": "msg_1",
    "conversationId": "conv_1",
    "senderId": "alice",
    "body": "hey bob!",
    "role": "user",
    "seq": 1,
    "createdAt": "2026-07-22T19:48:06.416Z",
    "editedAt": null,
    "deletedAt": null,
    "metadata": {}
  }
}
```

List history (newest first, keyset-paginated):

```sh
curl '/api/chat/conversations/conv_1/messages?limit=50'
```

```json
{ "messages": [{ "id": "msg_1", "body": "hey bob!", "seq": 1, "…": "…" }], "nextCursor": null }
```

Errors are JSON with a stable machine-readable code and a mapped HTTP status —
`401` when `auth` returns `null`, `400` for invalid input, `403`/`404`/`409`
for domain errors:

```json
{ "error": { "code": "FORBIDDEN_READ", "message": "…" } }
```

The full endpoint reference (all 9 routes, request/response shapes, error
codes) lives in [`@chatpack/core`'s README](./packages/core#rest-api).

### 5. Go live in the browser

```ts
const events = new EventSource("/api/chat/stream");
events.addEventListener("message.created", (e) => {
  const { message } = JSON.parse(e.data);
  // render it — reconnection & missed-message backfill are automatic
});
```

If the connection drops, `EventSource` reconnects with `Last-Event-ID` and
Chatpack replays whatever was missed **from storage** — durable-first delivery,
no lost messages.

Two things to know before going live:

- **Browser auth must be cookie-based for SSE** — `EventSource` can't send
  custom headers, so your `auth` hook needs to resolve the user from a session
  cookie (sent automatically same-origin). Bearer-token headers work for the
  REST routes but not `/stream`.
- **SSE + `memoryAdapter` need one long-lived process.** On serverless/edge
  (Workers, Lambda) each isolate has its own memory — use a
  [database adapter](./packages/adapter-drizzle) there and poll for new
  messages until a distributed transport ships. Details in
  [`@chatpack/core`'s README](./packages/core#real-time-sse).

### 6. Or call it straight from server code

```ts
// find-or-create a 1:1 conversation between two users
const conversation = await chat.api.getOrCreateConversation({
  userId: "alice",
  otherUserId: "bob",
});

// send a message
await chat.api.sendMessage({
  userId: "alice",
  conversationId: conversation.id,
  body: "hey bob!",
});

// read the history
const { messages } = await chat.api.listMessages({
  userId: "bob",
  conversationId: conversation.id,
});
```

That's it. Only the two participants can read or write — enforced by default,
customizable via the `permissions` hooks.

## What's in v0

| Feature                                 | Status       |
| --------------------------------------- | ------------ |
| 1:1 conversations (find-or-create)      | ✅ Done (M1) |
| Text messages: send, list, edit, delete | ✅ Done (M1) |
| Participant-only permissions + hooks    | ✅ Done (M1) |
| Durable read-state (`last_read`)        | ✅ Done (M1) |
| In-memory storage adapter               | ✅ Done (M1) |
| HTTP handler (Next.js App Router)       | ✅ Done (M2) |
| Real-time delivery (SSE)                | ✅ Done (M3) |
| Drizzle/Postgres adapter                | ✅ Done (M4) |
| Launch polish + npm release             | ✅ Done (M5) |

Deliberately **not** in v0: groups, typing indicators, presence, file uploads,
push notifications, React UI. See [docs/MVP.md](./docs/MVP.md) for the full
scope and reasoning.

## Packages

| Package                                                   | Description                                     |
| --------------------------------------------------------- | ----------------------------------------------- |
| [`@chatpack/core`](./packages/core)                       | The chat engine: domain logic, permissions, API |
| [`@chatpack/adapter-drizzle`](./packages/adapter-drizzle) | Drizzle/Postgres storage (production)           |
| [`@chatpack/adapter-memory`](./packages/adapter-memory)   | In-memory storage (demos, tests)                |
| [`@chatpack/next`](./packages/next)                       | Next.js App Router integration                  |

## Examples

| Example                                            | What it shows                                         |
| -------------------------------------------------- | ----------------------------------------------------- |
| [`examples/next-backend`](./examples/next-backend) | The quickstart, runnable: Next.js App Router + SSE    |
| [`examples/node-server`](./examples/node-server)   | Plain Node http server, in-memory or Postgres storage |

## Design principles

- **Developers bring their own auth** — Chatpack never owns a users table.
- **Adapter-driven** — storage is an interface; Postgres, MySQL, or in-memory
  are just adapters.
- **Durable-first real-time** — a message is persisted before anyone is
  notified about it.
- **Small surface, no magic** — every feature must justify its existence.

Read more in [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md).

## Telemetry

Chatpack ships **anonymous, opt-out telemetry**: aggregate counters only.
Twice a day (at most) it POSTs a small JSON body — counter deltas
(`messagesSent`, `conversationsCreated`), the library version, and a random
per-process id that is never persisted. Never message bodies, user ids,
conversation ids, or hostnames. The payload shape is a documented public type
([`TelemetryPayload`](./packages/core/src/telemetry.ts)) so you can audit
exactly what leaves your server.

Opt out any time — either works:

```ts
chatpack({ storage, telemetry: false });
```

```sh
CHATPACK_TELEMETRY=0
```

Failures are silently ignored and the flush timer never keeps your process
alive. Details in [docs/MVP.md §12](./docs/MVP.md).

## Contributing

Contributions are very welcome — see [CONTRIBUTING.md](./CONTRIBUTING.md) for
repo layout, dev workflow, and the adapter contract.

## License

[MIT](./LICENSE)
