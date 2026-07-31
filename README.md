<div align="center">

# Chatpack

**Open-source chat infrastructure for developers.**

Install a package, wire up your database and auth, and get a production-ready
1:1 chat backend - conversations, messages, permissions, read-state, and
real-time delivery - without rebuilding it from scratch.

[![CI](https://github.com/chddaniel/chatpack/actions/workflows/ci.yml/badge.svg)](https://github.com/chddaniel/chatpack/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

**[Documentation](./apps/docs)** - quickstart, concepts, real-time, storage
adapters, framework guides, and the full REST reference. Run it locally with
`pnpm --filter @chatpack/docs dev`.

</div>

---

> **Status: `0.2.x` - v0 MVP + real-time plugins, live on npm.** The v0 MVP
> (core engine, HTTP handler, real-time SSE, Postgres adapter) plus the opt-in
> real-time plugins - **`typing()`, `presence()`, and `receipts()`, all shipping
> today inside `@chatpack/core` under the `@chatpack/core/plugins` subpath** (see
> [Real-time plugins](#real-time-plugins-typing-presence-read-ticks)) - are
> published and installable now. The API is young - expect minor breaking
> changes before `1.0`. Follow along or [contribute](./CONTRIBUTING.md).

## Why

Every app that needs messaging ends up rebuilding the same things: conversations,
messages, permissions, read receipts, real-time delivery, and countless edge cases.

Chatpack removes that repetition - the same way BetterAuth did for authentication.
You bring your **auth** and your **frontend**; Chatpack gives you a small,
well-designed chat backend that just works.

Real-time comes built in: your frontend opens **one `EventSource`** and gets
live messages with automatic reconnection and missed-message backfill - no
WebSocket server, no Socket.IO, no reconnect code to write.

## How it fits together

```text
Your frontend  ──  fetch("/api/chat/…")  +  EventSource("/api/chat/stream")
      │
      ▼
chat.handler()        one Web-standard handler (Request → Response)
      │
      ├── auth hook   your session → { id: userId }     (you own users)
      ▼
chat.api.*            domain logic, permissions         (also callable directly)
      │
      ▼
StorageAdapter        memory · Drizzle/Postgres · your own
      │
      ▼
Your database
```

## Quickstart

> Prefer learning from a complete app? [`examples/messenger`](./examples/messenger)
> is a full 1:1 messenger - sidebar, live messages, read receipts - in vanilla
> HTML+JS with a step-by-step tutorial README.

### 1. Install

Both packages are needed for the quickstart - `@chatpack/core` is the engine,
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
> that's the guard - not a broken package. Check with
> `npm view @chatpack/core dist-tags`.

### 2. Create your chat server

```ts
// lib/chat.ts
import { chatpack } from "@chatpack/core";
import { memoryAdapter } from "@chatpack/adapter-memory";

export const chat = chatpack({
  storage: memoryAdapter(),
  // resolve the current user from a request - the ONLY auth touchpoint.
  // Concrete example with a session cookie (works with any auth library):
  auth: async (req) => {
    const session = await getSessionFromCookie(req.headers.get("cookie"));
    return session ? { id: session.userId } : null;
  },
});
```

> **The `auth` hook must return `ChatpackUser | null`** - an object with at
> least `{ id: string }` (extra fields are allowed and ignored), or `null`
> for unauthenticated requests. Returning a bare string is treated as
> unauthenticated and every request will get a `401`.
>
> **Prefer cookie-based sessions** over `Authorization` headers: the browser
> sends cookies automatically on every request - including the SSE stream in
> step 5, where custom headers are impossible.
>
> The hook receives a raw Web-standard `Request` - there is no
> `request.cookies` helper. Parse the `cookie` header yourself:
>
> ```ts
> // demo auth: a plain cookie naming the user (swap for your auth library)
> auth: (request) => {
>   const cookie = request.headers.get("cookie") ?? "";
>   const id = /(?:^|;\s*)demo_user=([^;]+)/.exec(cookie)?.[1] ?? null;
>   return id ? { id: decodeURIComponent(id) } : null;
> },
> ```
>
> **Setting the demo cookie in an embedded preview (Lovable, v0, Bolt, ...)?**
> Those editors show your app inside a cross-site iframe, where browsers
> silently drop `SameSite=Lax` cookies - the app 401s in the preview pane but
> works in a real tab. Set demo cookies with iframe-proof attributes:
>
> ```ts
> document.cookie = "demo_user=alice; Path=/; Max-Age=86400; SameSite=None; Secure; Partitioned";
> ```

For production, swap the storage line for Postgres -
[`@chatpack/adapter-drizzle`](./packages/adapter-drizzle):

```ts
import { drizzle } from "drizzle-orm/node-postgres";
import { drizzleAdapter } from "@chatpack/adapter-drizzle";

export const chat = chatpack({
  storage: drizzleAdapter(drizzle(process.env.DATABASE_URL!)),
  auth: async (req) => getSessionUser(req),
});
```

> **No direct Postgres connection string?** Platforms that only expose a
> database client (Supabase's JS client, Convex, and most AI-builder clouds)
> are supported through a custom `StorageAdapter`. The full guide - reference
> schema, invariants, skeleton, and a verification checklist - is Part 2 of
> [`llms.txt`](./llms.txt).
>
> **Building with an AI assistant or app builder?** [`llms.txt`](./llms.txt)
> is the single-fetch integration guide (hard rules, wiring, per-framework
> mount recipes, preview-iframe cookie recipe, verification steps). It also
> ships inside every `@chatpack/*` npm package as `llms.txt` - point your
> agent at `node_modules/@chatpack/core/llms.txt`.
>
> Using a coding agent (Claude Code, Cursor, Codex)? Install the
> [Chatpack agent skill](./skills) into your app's repo so the agent follows
> the correct workflow automatically:
>
> ```sh
> npx skills add chddaniel/chatpack
> ```

### 3. Mount the API (Next.js App Router)

```ts
// app/api/chat/[...chatpack]/route.ts
import { chat } from "@/lib/chat";
export const { GET, POST, PATCH, DELETE } = chat.handler();
```

Or, with the [`@chatpack/next`](./packages/next) helper (same result, reads
better):

```ts
import { toNextRouteHandlers } from "@chatpack/next";
import { chat } from "@/lib/chat";
export const { GET, POST, PATCH, DELETE } = toNextRouteHandlers(chat);
```

> **The route file must be a catch-all** (`[...chatpack]` in Next.js) -
> Chatpack serves many sub-paths under `basePath` (default `/api/chat`), so a
> single `app/api/chat/route.ts` would 404 everything but the root.
>
> **Never hand-write your own message or stream routes.** The one handler
> already serves every route - conversations, messages, read-state, plugins,
> and the SSE stream. Custom `/api/messages`-style routes split state and
> break live delivery.

Your chat backend is now live at `/api/chat` - find-or-create conversations,
send/list/edit/delete messages, read-state, and a **live SSE stream** at
`/api/chat/stream`, with your auth enforced on every request.

Not on Next.js? The handler is Web-standard (`Request` → `Response`) and
`GET`/`POST`/`PATCH`/`DELETE`/`fetch` are **all the same function** - the
method names only exist so they can be re-exported from a Next.js route file.
Any of them serves every route, including `/stream`:

```ts
const handler = chat.handler();

Bun.serve({ fetch: handler.fetch }); // Bun / Deno / Cloudflare Workers

app.all("/api/chat/*", (c) => handler.fetch(c.req.raw)); // Hono
app.all("/api/chat/*", ({ request }) => handler.fetch(request)); // Elysia
```

TanStack Start (`src/routes/api/chat.$.ts` catch-all) and Express recipes
live in [`@chatpack/core`'s README](./packages/core#rest-api) and
[`llms.txt`](./llms.txt). For plain Node, see
[`examples/node-server`](./examples/node-server).

### 4. Call it over HTTP

Find-or-create a conversation (the authenticated user + `otherUserId`):

```sh
curl -X POST /api/chat/conversations \
  -H 'content-type: application/json' \
  -d '{"otherUserId": "bob"}'
```

> **Chatpack never owns a users table**, so it cannot check that
> `otherUserId` actually exists - a typo silently creates a conversation
> with a ghost user. Validate recipient ids against your own users table
> before calling.

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
    ],
    "unreadCount": 0
  }
}
```

Every conversation object carries the **viewer's `unreadCount`** (messages
newer than their read-state, excluding their own) - the badge number comes
from the API, no client-side counting.

Send a message - note the field is **`body`**:

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

Errors are JSON with a stable machine-readable code and a mapped HTTP status -
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

// TypeScript: custom event names fall outside EventSourceEventMap, so the
// listener parameter is typed `Event` - cast to MessageEvent for `.data`.
events.addEventListener("message.created", (e) => {
  const { message } = JSON.parse((e as MessageEvent).data);
  // render it - reconnection & missed-message backfill are automatic
});

events.onerror = () => {
  if (events.readyState === EventSource.CLOSED) {
    // Fatal (e.g. 401 from your auth hook): the browser will NOT retry.
    // Re-authenticate, then create a new EventSource.
  }
  // Otherwise it's a dropped connection: EventSource retries automatically
  // and sends Last-Event-ID - no action needed.
};
```

If the connection drops, `EventSource` reconnects with `Last-Event-ID` and
Chatpack replays whatever was missed **from storage** - durable-first delivery,
no lost messages.

Two things to know before going live:

- **Browser auth must be cookie-based for SSE** - `EventSource` can't send
  custom headers, so your `auth` hook needs to resolve the user from a session
  cookie (sent automatically same-origin). Bearer-token headers work for the
  REST routes but not `/stream` - if your app uses them, write the `auth`
  hook to accept either (header first, cookie fallback); worked example in
  [`@chatpack/core`'s README](./packages/core#real-time-sse). If the app runs
  inside an embedded preview iframe (AI-builder editors), the cookie needs
  `SameSite=None; Secure` - see the quickstart note in step 2.
- **SSE + `memoryAdapter` need one long-lived process.** On serverless/edge
  (Workers, Lambda) each isolate has its own memory - use a
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

That's it. Only the two participants can read or write - enforced by default,
customizable via the `permissions` hooks.

### 7. Bonus: chat with an AI assistant

To Chatpack, an AI assistant is **just another participant** - pick a
synthetic user id (any string you'll never issue to a real user, e.g.
`ai:assistant`) and have your backend send its replies. No special AI support
needed, and the same 1:1 permissions apply:

```ts
const ASSISTANT_ID = "ai:assistant";

// find-or-create the user's conversation with the assistant
const conversation = await chat.api.getOrCreateConversation({
  userId: user.id,
  otherUserId: ASSISTANT_ID,
});

// the user's message arrives (via your route or the REST API)...
await chat.api.sendMessage({
  userId: user.id,
  conversationId: conversation.id,
  body: userText,
});

// ...your backend calls your LLM of choice with your own keys...
const reply = await generateReply(userText); // OpenAI, Anthropic, Gemini, ...

// ...and sends the answer as the assistant participant
await chat.api.sendMessage({
  userId: ASSISTANT_ID,
  conversationId: conversation.id,
  body: reply,
  role: "assistant", // "user" | "assistant" | "system" - stored & returned as-is
});
```

Chatpack stores, orders, and delivers the messages; the LLM call is yours
(model, keys, prompts, streaming). `role` is a plain label for your UI -
core never behaves differently based on it. Since `otherUserId` accepts any
non-empty string, make sure your `auth`/validation layer prevents real users
from registering ids in your synthetic namespace (e.g. reserve the `ai:`
prefix).

## Real-time plugins: typing, presence, read ticks

The "feels alive" features are **opt-in plugins** that ship inside
`@chatpack/core` - no extra install:

```ts
import { chatpack } from "@chatpack/core";
import { typing, presence, receipts } from "@chatpack/core/plugins";

export const chat = chatpack({
  storage: memoryAdapter(),
  auth: async (req) => getSessionUser(req),
  plugins: [typing(), presence(), receipts()],
});
```

They publish **ephemeral events** on the same `/stream` connection you already
have: fire-and-forget signals that are never stored and never replayed on
reconnect (miss a typing ping and it's gone - that's correct; durable state
like `lastReadMessageId` stays in core). Listen exactly like message events:

```ts
events.addEventListener("typing.started", (e) => {
  const { senderId, conversationId } = JSON.parse((e as MessageEvent).data);
  // show "… is typing" - and hide it if no new ping arrives within ~5s
});
events.addEventListener("presence.online", (e) => {
  /* light up the dot */
});
events.addEventListener("receipt.read", (e) => {
  const { payload } = JSON.parse((e as MessageEvent).data);
  // mark everything up to payload.messageId as ✓✓
});
```

What each plugin adds:

| Plugin       | Routes                           | Events published                      |
| ------------ | -------------------------------- | ------------------------------------- |
| `typing()`   | `POST /conversations/:id/typing` | `typing.started`, `typing.stopped`    |
| `presence()` | `GET /presence?userIds=a,b`      | `presence.online`, `presence.offline` |
| `receipts()` | - (hooks into send + mark-read)  | `receipt.delivered`, `receipt.read`   |

Notes that keep the design honest:

- **Typing** is stateless: while the user types, `POST …/typing` at most once
  every few seconds; the other side clears the indicator if no ping arrives
  within ~5s. Send `{ "isTyping": false }` to clear it eagerly.
- **Presence needs no heartbeat endpoint** - the SSE connection _is_ the
  heartbeat. Multi-tab safe; a short grace period (default 5s,
  `presence({ offlineDelayMs })`) stops the online dot from blinking during
  `EventSource` auto-reconnects. Snapshots via `GET /presence` only reveal
  users the caller shares a conversation with.
- **Receipts** are instant ✓/✓✓ pings while both sides are online:
  `receipt.delivered` fires to the sender the moment the recipient's stream
  receives the message; `receipt.read` fires when the other side calls
  mark-read. Ticks are at-least-once - dedupe by `payload.messageId`. The
  durable truth is still `lastReadMessageId`.
- Like the default transport, plugin state is **in-memory and single-node**
  (MVP §5). Multi-node fan-out is a future transport, not an API change.

Want to write your own plugin? The seam is public - see `ChatpackPlugin` in
[`@chatpack/core`](./packages/core) and
[ADR 0008](./docs/decisions/0008-ephemeral-events-in-core-plugins.md).

## What's in v0

| Feature                                 | Status            |
| --------------------------------------- | ----------------- |
| 1:1 conversations (find-or-create)      | ✅ Done (M1)      |
| Text messages: send, list, edit, delete | ✅ Done (M1)      |
| Participant-only permissions + hooks    | ✅ Done (M1)      |
| Durable read-state (`last_read`)        | ✅ Done (M1)      |
| In-memory storage adapter               | ✅ Done (M1)      |
| HTTP handler (Next.js App Router)       | ✅ Done (M2)      |
| Real-time delivery (SSE)                | ✅ Done (M3)      |
| Drizzle/Postgres adapter                | ✅ Done (M4)      |
| Launch polish + npm release             | ✅ Done (M5)      |
| Typing / presence / read-tick plugins   | ✅ Done (v0.next) |
| Unread counts (`unreadCount`)           | ✅ Done (v0.next) |

Deliberately **not** in scope yet: groups, file uploads, push notifications,
React UI. See [docs/MVP.md](./docs/MVP.md) for the full scope and reasoning.

## Packages

| Package                                                   | Description                                     |
| --------------------------------------------------------- | ----------------------------------------------- |
| [`@chatpack/core`](./packages/core)                       | The chat engine: domain logic, permissions, API |
| [`@chatpack/adapter-drizzle`](./packages/adapter-drizzle) | Drizzle/Postgres storage (production)           |
| [`@chatpack/adapter-memory`](./packages/adapter-memory)   | In-memory storage (demos, tests)                |
| [`@chatpack/next`](./packages/next)                       | Next.js App Router integration                  |

## Examples

| Example                                            | What it shows                                            |
| -------------------------------------------------- | -------------------------------------------------------- |
| [`examples/messenger`](./examples/messenger)       | **A complete 1:1 messenger** - vanilla HTML+JS, tutorial |
| [`examples/next-backend`](./examples/next-backend) | The quickstart, runnable: Next.js App Router + SSE       |
| [`examples/node-server`](./examples/node-server)   | Plain Node http server, in-memory or Postgres storage    |

## Design principles

- **Developers bring their own auth** - Chatpack never owns a users table.
- **Adapter-driven** - storage is an interface; Postgres, MySQL, or in-memory
  are just adapters.
- **Durable-first real-time** - a message is persisted before anyone is
  notified about it.
- **Small surface, no magic** - every feature must justify its existence.

Read more in [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md).

## Telemetry

Chatpack ships **anonymous, opt-out telemetry**: aggregate counters only.
Twice a day (at most) it POSTs a small JSON body - counter deltas
(`messagesSent`, `conversationsCreated`), the library version, and a random
per-process id that is never persisted. Never message bodies, user ids,
conversation ids, or hostnames. The payload shape is a documented public type
([`TelemetryPayload`](./packages/core/src/telemetry.ts)) so you can audit
exactly what leaves your server.

Opt out any time - either works:

```ts
chatpack({ storage, telemetry: false });
```

```sh
CHATPACK_TELEMETRY=0
```

Failures are silently ignored and the flush timer never keeps your process
alive. Details in [docs/MVP.md §12](./docs/MVP.md).

## Contributing

Contributions are very welcome - see [CONTRIBUTING.md](./CONTRIBUTING.md) for
repo layout, dev workflow, and the adapter contract.

## License

[MIT](./LICENSE)
