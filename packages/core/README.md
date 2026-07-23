# @chatpack/core

The Chatpack engine: 1:1 conversations, messages, permissions, durable
read-state, and the `StorageAdapter` contract. Backend-only and
framework-agnostic — you bring auth, storage, and a frontend.

> Part of [Chatpack](https://github.com/chddaniel/chatpack) — open-source chat
> infrastructure for developers.

## Install

```sh
# pick your package manager — you need both packages
npm  install @chatpack/core @chatpack/adapter-memory
pnpm add     @chatpack/core @chatpack/adapter-memory
bun  add     @chatpack/core @chatpack/adapter-memory
```

## Use

```ts
import { chatpack } from "@chatpack/core";
import { memoryAdapter } from "@chatpack/adapter-memory";

const chat = chatpack({
  storage: memoryAdapter(),
  // your auth, your users — e.g. resolve a session cookie:
  auth: async (req) => {
    const session = await getSessionFromCookie(req.headers.get("cookie"));
    return session ? { id: session.userId } : null;
  },
});
```

> **The `auth` hook must return `ChatpackUser | null`** — an object with at
> least `{ id: string }` (extra fields are allowed and ignored), or `null`
> for unauthenticated requests (which get a `401`). Returning a bare string
> is treated as unauthenticated. Prefer cookie-based sessions — the browser
> sends cookies automatically, including on the SSE stream where custom
> headers are impossible.

```ts
const conversation = await chat.api.getOrCreateConversation({
  userId: "alice",
  otherUserId: "bob",
});

await chat.api.sendMessage({
  userId: "alice",
  conversationId: conversation.id,
  body: "hey bob!",
});
```

## API surface

| Method                        | What it does                                        |
| ----------------------------- | --------------------------------------------------- |
| `api.getOrCreateConversation` | Find or create the 1:1 conversation for a user pair |
| `api.listConversations`       | List a user's conversations, most recent first      |
| `api.getConversation`         | Fetch one conversation (read-permission checked)    |
| `api.sendMessage`             | Send a text message (write-permission checked)      |
| `api.listMessages`            | Paginate history, newest-first                      |
| `api.editMessage`             | Edit your own message                               |
| `api.deleteMessage`           | Soft-delete your own message                        |
| `api.markRead`                | Update durable read-state (`last_read`)             |
| `api.listMessagesAfter`       | Messages after a `seq` (SSE reconnect gap-fill)     |

All failures throw `ChatpackError` with a stable `code`
(`FORBIDDEN_READ`, `MESSAGE_NOT_FOUND`, `INVALID_INPUT`, ...).

## REST API

`chat.handler()` mounts everything on one route using Web-standard
`Request`/`Response` — works on Next.js App Router
(see [`@chatpack/next`](../next)), Bun, Deno, Workers, or Node via a tiny
bridge (see [`examples/node-server`](../../examples/node-server)).

```ts
// app/api/chat/[...chatpack]/route.ts  (Next.js App Router)
import { chat } from "@/lib/chat";
export const { GET, POST, PATCH, DELETE } = chat.handler();
```

> **Mount on a catch-all route.** Chatpack serves many sub-paths under
> `basePath` (default `/api/chat`), so the route file must match all of them —
> `[...chatpack]` in Next.js, `chat.$` in TanStack Start, `/api/chat/*` in
> Hono/Elysia. A single exact `/api/chat` route will 404 every sub-path.

`GET`/`POST`/`PATCH`/`DELETE`/`fetch` on the returned handler are **all the
same function** — the method names only exist so they can be re-exported from
a Next.js route file. Any of them serves every route, including `/stream`.
For any other Web-standard runtime or router, use `fetch`:

```ts
const handler = chat.handler();

Bun.serve({ fetch: handler.fetch }); // Bun / Deno / Workers
app.all("/api/chat/*", (c) => handler.fetch(c.req.raw)); // Hono
app.all("/api/chat/*", ({ request }) => handler.fetch(request)); // Elysia
```

Routes (relative to `basePath`, default `/api/chat`). Response envelopes are
keyed by resource — `{ conversation }`, `{ message }`, `{ conversations, nextCursor }`,
`{ messages, nextCursor }`:

| Method | Path                          | Request body / query                   | Response (200/201)                        |
| ------ | ----------------------------- | -------------------------------------- | ----------------------------------------- |
| POST   | `/conversations`              | `{ otherUserId, metadata? }`           | `{ conversation }`                        |
| GET    | `/conversations`              | `?limit=&cursor=`                      | `{ conversations, nextCursor }`           |
| GET    | `/conversations/:id`          | —                                      | `{ conversation }`                        |
| POST   | `/conversations/:id/messages` | `{ body, role?, metadata? }`           | `{ message }` (201)                       |
| GET    | `/conversations/:id/messages` | `?limit=&cursor=`                      | `{ messages, nextCursor }` — newest first |
| POST   | `/conversations/:id/read`     | `{ messageId }`                        | `{ ok: true }`                            |
| PATCH  | `/messages/:id`               | `{ body }`                             | `{ message }`                             |
| DELETE | `/messages/:id`               | —                                      | `{ message }` (soft-deleted)              |
| GET    | `/stream`                     | SSE; auto `Last-Event-ID` on reconnect | `text/event-stream`                       |

- **Message ordering:** both list endpoints return **newest first**
  (keyset-paginated by `cursor`). Reverse the page for a chronological
  top-to-bottom render.
- **`role`** must be `"user" | "assistant" | "system"` (default `"user"`).
  It's an AI escape hatch only — core never behaves differently based on it;
  any other value is a 400 `INVALID_INPUT`.
- **`otherUserId` is not validated to exist** — Chatpack never owns a users
  table, so any non-empty string creates a conversation. Validate recipient
  ids against your own users table before calling.
- **Timestamps on the wire are ISO strings.** The exported types declare
  `createdAt`/`editedAt`/`deletedAt` as `Date` (correct for the server-side
  `chat.api.*` calls), but JSON serialization means HTTP clients receive ISO
  8601 strings — type them as `string` in frontend code.

Example — send a message (the text field is **`body`**):

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

The `auth` hook runs on every request. Errors are JSON —
`{ "error": { "code", "message" } }` — with statuses mapped from the error
code:

| Status | Code(s)                                                    | When                                             |
| ------ | ---------------------------------------------------------- | ------------------------------------------------ |
| 401    | `UNAUTHENTICATED`                                          | `auth` returned `null` (or a non-`ChatpackUser`) |
| 400    | `INVALID_INPUT`                                            | bad body/query params                            |
| 403    | `FORBIDDEN_READ`, `FORBIDDEN_WRITE`, `NOT_MESSAGE_SENDER`  | not allowed                                      |
| 404    | `CONVERSATION_NOT_FOUND`, `MESSAGE_NOT_FOUND`, `NOT_FOUND` | missing resource/route                           |
| 409    | `MESSAGE_DELETED`                                          | editing a deleted message                        |
| 500    | `INTERNAL_ERROR`                                           | unexpected server error (opaque)                 |

## Real-time (SSE)

`GET /stream` is a Server-Sent Events endpoint. Each connected user receives
`message.created` / `message.updated` / `message.deleted` events for their
conversations only — participation is re-checked server-side per event.

```ts
const events = new EventSource("/api/chat/stream");

// TypeScript: custom event names fall outside EventSourceEventMap, so cast
// the listener parameter to MessageEvent to access `.data`.
events.addEventListener("message.created", (e) => {
  const { message } = JSON.parse((e as MessageEvent).data);
});

events.onerror = () => {
  if (events.readyState === EventSource.CLOSED) {
    // Fatal (e.g. 401): the browser will NOT retry. Re-auth, then recreate.
  }
  // Otherwise: dropped connection — EventSource retries automatically with
  // Last-Event-ID and the server replays what was missed.
};
```

> **Browser auth for SSE must be cookie-based.** `EventSource` cannot send
> custom headers, so your `auth` hook must be able to resolve the user from
> what the browser sends automatically — typically a session cookie
> (`EventSource` sends same-origin cookies by default; pass
> `{ withCredentials: true }` for cross-origin). Header/bearer-token schemes
> work for the REST routes but not for `/stream`.

**No lost messages:** events are published only _after_ the storage write
(durable-first), and every event id is `conversationId:seq`. On reconnect,
`EventSource` sends `Last-Event-ID` automatically and the server replays what
was missed from storage before resuming live delivery. Delivery is
at-least-once — dedupe by `message.id`. Details in
[ADR 0006](../../docs/decisions/0006-sse-gap-fill.md).

> **⚠️ Deployment reality check:** the default transport is **in-process** and
> `memoryAdapter` is **per-process** — both assume one long-lived server
> (a Node server, a single Fly/Railway container, `next start`, `Bun.serve`).
> On serverless/edge platforms (Cloudflare Workers, Vercel/AWS Lambda), each
> isolate has its own memory: SSE events won't reach connections held by other
> isolates, and in-memory history isn't shared at all. For those platforms use
> a database adapter ([`@chatpack/adapter-drizzle`](../adapter-drizzle)) and,
> until a distributed `Transport` ships (e.g. Redis — same public API), prefer
> polling `GET /conversations/:id/messages` over `/stream`.

## Telemetry (anonymous, opt-out)

Chatpack reports **aggregate counters only** — deltas of `messagesSent` and
`conversationsCreated`, the library version, and a random per-process id —
at most twice a day, fire-and-forget. Never message content, user ids,
conversation ids, or hostnames. The exact payload is the exported
`TelemetryPayload` type; the flush timer is `unref`'d and can never keep your
process alive or affect chat.

Opt out with either:

```ts
chatpack({ storage, telemetry: false });
```

```sh
CHATPACK_TELEMETRY=0
```

## Writing a storage adapter

Implement the exported `StorageAdapter` interface — the full contract ships
in the package's `.d.ts` with TSDoc on every method. The surface is
deliberately small:

| Method                          | Contract                                                                 |
| ------------------------------- | ------------------------------------------------------------------------ |
| `getOrCreateDirectConversation` | Find or atomically create by `pairKey` — concurrent calls must converge  |
| `getConversation`               | Fetch by id (with participants), or `null`                               |
| `listConversations`             | A user's conversations, most-recently-active first, cursor-paginated     |
| `addMessage`                    | Persist + assign the next strictly-increasing `seq` for the conversation |
| `getMessage`                    | Fetch by id, or `null`                                                   |
| `listMessages`                  | Newest-first, cursor-paginated                                           |
| `listMessagesAfterSeq`          | Messages with `seq > afterSeq`, **oldest first** (SSE gap-fill)          |
| `updateMessage`                 | Edit body / set `editedAt` / set `deletedAt` in place                    |
| `updateLastRead`                | Set a participant's `lastReadMessageId`                                  |

The [in-memory adapter](../adapter-memory) is the reference implementation,
and the [Drizzle/Postgres adapter](../adapter-drizzle) shows the contract on
a real database (row-locked `seq` assignment, `ON CONFLICT` pair creation).
See the [contributing guide](../../CONTRIBUTING.md) for the contract rules.

## License

[MIT](../../LICENSE)
