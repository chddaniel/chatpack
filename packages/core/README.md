# @chatpack/core

The Chatpack engine: 1:1 and group conversations, messages, permissions,
durable read-state, and the `StorageAdapter` contract. Backend-only and
framework-agnostic - you bring auth, storage, and a frontend.

> Part of [Chatpack](https://github.com/chddaniel/chatpack) - open-source chat
> infrastructure for developers.

## Install

```sh
# pick your package manager - you need both packages
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
  // your auth, your users - e.g. resolve a session cookie:
  auth: async (req) => {
    const session = await getSessionFromCookie(req.headers.get("cookie"));
    return session ? { id: session.userId } : null;
  },
});
```

> **The `auth` hook must return `ChatpackUser | null`** - an object with at
> least `{ id: string }` (extra fields are allowed and ignored), or `null`
> for unauthenticated requests (which get a `401`). Returning a bare string
> is treated as unauthenticated. Prefer cookie-based sessions - the browser
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

A complete worked example - vanilla HTML+JS messenger with a tutorial README -
lives at [`examples/messenger`](../../examples/messenger).

## API surface

| Method                        | What it does                                                                                                        |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `api.getOrCreateConversation` | Find or create the 1:1 conversation for a user pair                                                                 |
| `api.createGroupConversation` | Create a group with the caller as its first admin - **always a new one**, never find-or-create                      |
| `api.listConversations`       | List a user's conversations (DMs and groups), most recent first                                                     |
| `api.getConversation`         | Fetch one conversation (read-permission checked)                                                                    |
| `api.updateConversation`      | Rename a group, or clear its name with `null` (admin only)                                                          |
| `api.addParticipants`         | Add members to a group as `member` (admin only); idempotent                                                         |
| `api.removeParticipant`       | Remove a member, or leave by passing your own id (admin, or self); idempotent                                       |
| `api.setParticipantRole`      | Promote to `admin` or demote to `member` (admin only)                                                               |
| `api.sendMessage`             | Send a text message, optionally quote-replying to another (write-permission checked)                                |
| `api.listMessages`            | Paginate history, newest-first                                                                                      |
| `api.searchMessages`          | Search participant conversation bodies case-insensitively, ranked and cursor-paginated; requires adapter capability |
| `api.editMessage`             | Edit your own message                                                                                               |
| `api.deleteMessage`           | Soft-delete your own message                                                                                        |
| `api.addReaction`             | React as `userId` (write-permission checked); idempotent                                                            |
| `api.removeReaction`          | Remove one of your own reactions; idempotent                                                                        |
| `api.markRead`                | Update durable read-state (`last_read`); monotonic - marking an older message is a silent no-op                     |
| `api.listMessagesAfter`       | Messages after a `seq` (SSE reconnect gap-fill)                                                                     |

The four group-management methods work on `type: "group"` conversations only -
calling one with a DM's id throws `NOT_GROUP_CONVERSATION` - and each returns the
full updated conversation. A group always keeps at least one admin: removing or
demoting the last one throws `LAST_ADMIN_REMAINING` rather than silently
promoting someone.

Conversation-returning methods (`getOrCreateConversation`,
`createGroupConversation`, `listConversations`, `getConversation`, and the four
group-management methods) return the conversation plus the calling user's
**`unreadCount`** - messages newer than their read-state, excluding their own
(soft-deleted messages count; they render as tombstones).

Message-returning methods all return `MessageWithDetails` - the stored
`Message` plus two per-request decorations: `replyTo` (the quoted parent's
read-only preview `{ id, senderId, excerpt, deleted }`, or `null`) and
`reactions` (`[{ emoji, count, userIds }]`, grouped, earliest-first). Neither is
stored; core computes both from batched adapter calls, one per page, so an
edited parent's excerpt is never stale.

### Which API do I call?

The same task, from both sides - `chat.api.*` in server code, the REST route
from a browser/client:

| I want to...                    | Server (`chat.api.*`)           | HTTP                                      |
| ------------------------------- | ------------------------------- | ----------------------------------------- |
| Start a chat with someone       | `getOrCreateConversation`       | `POST /conversations`                     |
| Start a group                   | `createGroupConversation`       | `POST /conversations/group`               |
| Show the inbox / sidebar        | `listConversations`             | `GET /conversations`                      |
| Open one conversation           | `getConversation`               | `GET /conversations/:id`                  |
| Rename a group                  | `updateConversation`            | `PATCH /conversations/:id`                |
| Add members                     | `addParticipants`               | `POST /conversations/:id/participants`    |
| Remove a member / leave         | `removeParticipant`             | `DELETE /conversations/:id/participants`  |
| Promote or demote               | `setParticipantRole`            | `PATCH /conversations/:id/participants`   |
| Load history / scroll back      | `listMessages`                  | `GET /conversations/:id/messages`         |
| Send a message                  | `sendMessage`                   | `POST /conversations/:id/messages`        |
| Edit / delete my message        | `editMessage`, `deleteMessage`  | `PATCH` / `DELETE /messages/:id`          |
| React / un-react                | `addReaction`, `removeReaction` | `POST` / `DELETE /messages/:id/reactions` |
| Mark a conversation read        | `markRead`                      | `POST /conversations/:id/read`            |
| Get live updates in the browser | - (server-sent events)          | `GET /stream` via `EventSource`           |

> **Pagination vs gap-fill - don't mix them up.** Infinite scroll ("load
> older messages") is `listMessages` with the `nextCursor` from the previous
> page passed back as `cursor`. `listMessagesAfter` is **not** pagination -
> it fetches messages _after_ a known `seq` (oldest-first) and exists for
> real-time catch-up; the `/stream` endpoint already uses it automatically
> on reconnect, so most apps never call it directly.

All failures throw `ChatpackError` with a stable `code`
(`FORBIDDEN_READ`, `MESSAGE_NOT_FOUND`, `INVALID_INPUT`, ...) - **methods
never return `null` for missing resources**. E.g. `api.getConversation`
throws `CONVERSATION_NOT_FOUND`; don't confuse it with the storage adapter's
`getConversation`, which is a lower-level method that returns
`Conversation | null` (core is the layer that turns a `null` into the domain
error). Wrap calls in `try/catch` and branch on `error.code`.

## REST API

`chat.handler()` mounts everything on one route using Web-standard
`Request`/`Response` - works on Next.js App Router
(see [`@chatpack/next`](../next)), Bun, Deno, Workers, or Node via a tiny
bridge (see [`examples/node-server`](../../examples/node-server)).

```ts
// app/api/chat/[...chatpack]/route.ts  (Next.js App Router)
import { chat } from "@/lib/chat";
export const { GET, POST, PATCH, DELETE, PUT } = chat.handler();
```

> **Mount on a catch-all route.** Chatpack serves many sub-paths under
> `basePath` (default `/api/chat`), so the route file must match all of them -
> `[...chatpack]` in Next.js, `chat.$` in TanStack Start, `/api/chat/*` in
> Hono/Elysia. A single exact `/api/chat` route will 404 every sub-path.

`GET`/`POST`/`PATCH`/`DELETE`/`PUT`/`fetch` on the returned handler are **all the
same function** - the method names only exist so they can be re-exported from
a Next.js route file. Any of them serves every route, including `/stream`.
For any other Web-standard runtime or router, use `fetch`:

```ts
const handler = chat.handler();

Bun.serve({ fetch: handler.fetch }); // Bun / Deno / Workers
app.all("/api/chat/*", (c) => handler.fetch(c.req.raw)); // Hono
app.all("/api/chat/*", ({ request }) => handler.fetch(request)); // Elysia
```

**TanStack Start** - a `$` catch-all route file delegating to the handler:

```ts
// src/routes/api/chat.$.ts
import { createFileRoute } from "@tanstack/react-router";
import { chat } from "@/lib/chat.server";

const handler = chat.handler();
const handle = ({ request }: { request: Request }) => handler.fetch(request);

export const Route = createFileRoute("/api/chat/$")({
  server: { handlers: { GET: handle, POST: handle, PATCH: handle, DELETE: handle, PUT: handle } },
});
```

**Express / plain Node** need a small `req`/`res` ↔ `Request`/`Response`
bridge (streaming the response body is what makes `/stream` work) - copy it
from [`examples/node-server`](../../examples/node-server) or the Express
variant in [`llms.txt`](../../llms.txt) (the same file ships inside this
npm package as `llms.txt`).

> **One instance, everywhere.** Create the `chatpack()` instance in a single
> module and import it into the route file - never one instance per route.
> Under dev-server HMR (Vite, `next dev`), guard it with `globalThis` so
> module re-evaluation doesn't reset in-memory state:
>
> ```ts
> const g = globalThis as typeof globalThis & { __chatpack__?: ChatpackInstance };
> export const chat = (g.__chatpack__ ??= chatpack({ storage, auth }));
> ```

Routes (relative to `basePath`, default `/api/chat`). Response envelopes are
keyed by resource - `{ conversation }`, `{ message }`, `{ conversations, nextCursor }`,
`{ messages, nextCursor }`. **The envelope is HTTP-only and intentional**
(room to add sibling fields without breaking clients): the server-side
`chat.api.*` methods return the bare object (`Conversation`, `Message`, ...),
so don't reuse HTTP-response types for `chat.api.*` calls or vice versa:

| Method | Path                              | Request body / query                            | Response (200/201)                        |
| ------ | --------------------------------- | ----------------------------------------------- | ----------------------------------------- |
| POST   | `/conversations`                  | `{ otherUserId, metadata? }`                    | `{ conversation }` - DM, find-or-create   |
| POST   | `/conversations/group`            | `{ name?, userIds?, metadata? }`                | `{ conversation }` (201) - always new     |
| GET    | `/conversations`                  | `?limit=&cursor=`                               | `{ conversations, nextCursor }`           |
| GET    | `/conversations/:id`              | -                                               | `{ conversation }`                        |
| PATCH  | `/conversations/:id`              | `{ name }` (string or `null`) - admin           | `{ conversation }`                        |
| POST   | `/conversations/:id/participants` | `{ userIds }` - admin                           | `{ conversation }`                        |
| DELETE | `/conversations/:id/participants` | `{ userId }` - admin, or self to leave          | `{ conversation }`                        |
| PATCH  | `/conversations/:id/participants` | `{ userId, role }` - admin                      | `{ conversation }`                        |
| POST   | `/conversations/:id/messages`     | `{ body, role?, replyToMessageId?, metadata? }` | `{ message }` (201)                       |
| GET    | `/conversations/:id/messages`     | `?limit=&cursor=`                               | `{ messages, nextCursor }` - newest first |
| GET    | `/search/messages`                | `?q=&limit=&cursor=`                            | `{ messages, nextCursor }` - ranked       |
| POST   | `/conversations/:id/read`         | `{ messageId }`                                 | `{ ok: true }`                            |
| PATCH  | `/messages/:id`                   | `{ body }`                                      | `{ message }`                             |
| DELETE | `/messages/:id`                   | -                                               | `{ message }` (soft-deleted)              |
| POST   | `/messages/:id/reactions`         | `{ emoji }`                                     | `{ message }` (full reaction set)         |
| DELETE | `/messages/:id/reactions`         | `{ emoji }`                                     | `{ message }` (full reaction set)         |
| GET    | `/stream`                         | SSE; auto `Last-Event-ID` on reconnect          | `text/event-stream`                       |

Every conversation object in a response carries the **viewer's**
`unreadCount` - messages newer than their read-state, excluding their own.

Opt-in plugins from `@chatpack/core/plugins` add routes of their own
(consulted after core routes miss, before the 404):

| Method | Path                        | Plugin       | Request body / query     | Response                                         |
| ------ | --------------------------- | ------------ | ------------------------ | ------------------------------------------------ |
| POST   | `/conversations/:id/typing` | `typing()`   | `{ isTyping?: boolean }` | `{ ok: true }`                                   |
| GET    | `/presence`                 | `presence()` | `?userIds=a,b` (max 50)  | `{ presence: { [id]: { online, lastSeenAt } } }` |

- **Message ordering:** both list endpoints return **newest first**
  (keyset-paginated by `cursor`). Reverse the page for a chronological
  top-to-bottom render.
- **Search is case-insensitive and ranked** by relevance, creation time, and
  message id. It searches only the viewer's participant conversations,
  excludes tombstones, and does not yet support non-participant `canRead`
  grants.
- **`role`** must be `"user" | "assistant" | "system"` (default `"user"`).
  It's an AI escape hatch only - core never behaves differently based on it;
  any other value is a 400 `INVALID_INPUT`.
- **`otherUserId` is not validated to exist** - Chatpack never owns a users
  table, so any non-empty string creates a conversation. Validate recipient
  ids against your own users table before calling.
- **Timestamps on the wire are ISO strings.** The exported types declare
  `createdAt`/`editedAt`/`deletedAt` as `Date` (correct for the server-side
  `chat.api.*` calls), but JSON serialization means HTTP clients receive ISO
  8601 strings - type them as `string` in frontend code.
- **Reaction routes are idempotent both ways** (reacting twice = one reaction,
  un-reacting nothing = no-op) and always return the message with its
  **complete** reaction set - replace that cache entry, don't merge a delta.
  The `emoji` is in the request **body** on `DELETE` too, because reaction keys
  are arbitrary strings that mangle in a path segment. A key is any non-empty
  string, trimmed, up to 32 characters (not validated as a Unicode emoji);
  violations are 400 `INVALID_INPUT`. Reacting needs **write** permission, like
  editing, and the actor always comes from the auth hook.
- **`replyToMessageId` must name a message in the same conversation** (else 404
  `MESSAGE_NOT_FOUND`); replying to a soft-deleted message is allowed, deleting
  a parent leaves its replies intact, a reply to a reply is still one flat hop,
  and the pointer is immutable. These are quote-replies, **not threads**.
- **A reaction is not a message:** no `seq`, no `unreadCount` bump, no
  reordering of the conversation list. The same is true of a membership change.
- **`POST /conversations/group` always creates.** Every field is optional (a
  bodyless POST makes an empty unnamed group), and calling it twice makes two
  groups - there is no pair key to converge on, so store the id you get back.
  `userIds` is de-duplicated and the caller is dropped from it; the caller
  becomes the first `admin` and everyone else joins as `member`.
- **The three group-only route shapes are admin-gated** (`canManage`, default
  admin-only) except self-removal: `DELETE /conversations/:id/participants` with
  your own id is "leave" and needs no admin rights. All three are idempotent -
  adding an existing member or removing an absent one succeeds and changes
  nothing - and all three return the whole conversation, so replace your cached
  copy rather than merging.
- **Group-only routes reject DMs** with `409 NOT_GROUP_CONVERSATION`, and any
  write that would leave a group with no admins is refused with
  `409 LAST_ADMIN_REMAINING` rather than auto-promoting someone. A group holds at
  most 256 participants (`422 GROUP_LIMIT_EXCEEDED`) and a name is trimmed,
  non-empty, at most 200 characters.

Example - send a message (the text field is **`body`**):

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

The `auth` hook runs on every request. Errors are JSON -
`{ "error": { "code", "message" } }` - with statuses mapped from the error
code:

| Status | Code(s)                                                                             | When                                                 |
| ------ | ----------------------------------------------------------------------------------- | ---------------------------------------------------- |
| 401    | `UNAUTHENTICATED`                                                                   | `auth` returned `null` (or a non-`ChatpackUser`)     |
| 400    | `INVALID_INPUT`                                                                     | bad body/query params                                |
| 403    | `FORBIDDEN_READ`, `FORBIDDEN_WRITE`, `NOT_MESSAGE_SENDER`, `NOT_CONVERSATION_ADMIN` | not allowed                                          |
| 404    | `CONVERSATION_NOT_FOUND`, `MESSAGE_NOT_FOUND`, `NOT_FOUND`                          | missing resource/route                               |
| 409    | `MESSAGE_DELETED`, `NOT_GROUP_CONVERSATION`, `LAST_ADMIN_REMAINING`                 | the resource is in the wrong state for the operation |
| 422    | `MESSAGE_REJECTED`, `GROUP_LIMIT_EXCEEDED`                                          | a hook refused the message / the group is too large  |
| 500    | `INTERNAL_ERROR`                                                                    | unexpected server error (opaque)                     |
| 501    | `SEARCH_UNSUPPORTED`                                                                | configured storage adapter has no search capability  |

## Message hooks

Content rules and side-effects, via the optional `hooks` option, after auth and
permission checks:

```ts
const chat = chatpack({
  storage,
  auth,
  hooks: {
    // BEFORE persistence: throw to reject (422 MESSAGE_REJECTED), return
    // { body }/{ metadata } to rewrite, or return nothing to accept.
    beforeMessageSend: ({ body }) => {
      if (body.length > 2000) throw new Error("Max 2000 characters.");
      return { body: censorProfanity(body) };
    },
    // AFTER persistence + broadcast: side-effects only. Filter by action.
    afterMessageMutation: async ({ action, message, recipientIds }) => {
      if (action !== "send") return;
      // recipientIds is everyone but the sender: one id in a DM, N in a group.
      await Promise.all(recipientIds.map((id) => sendPushNotification(id, message)));
    },
  },
});
```

A rejected message is never stored and never broadcast. Rewriting to an
empty body is `INVALID_INPUT` (rejecting must be explicit). The mutation hook
receives `send`, `edit`, and `delete`, plus `recipientIds` - every participant
except the sender (one id in a DM, up to 255 in a group, empty in a
creator-only group). `otherParticipantId` is still populated but **deprecated**
and removed at 1.0: it is single-valued, so in a group it resolves to the first
non-sender and everyone else gets no push. Hooks are in-process functions, not
webhooks - no retries or delivery guarantees; keep heavy work in your own queue
(design: `docs/decisions/0014`). `afterMessageSend` remains as a deprecated
send/edit-only compatibility hook.

## Real-time (SSE)

`GET /stream` is a Server-Sent Events endpoint. Each connected user receives
`message.created` / `message.updated` / `message.deleted`,
`reaction.added` / `reaction.removed`, and the membership events
`participant.added` / `participant.removed` / `conversation.updated` for their
conversations only - participation is re-checked server-side per event.

```ts
const events = new EventSource("/api/chat/stream");

// TypeScript: custom event names fall outside EventSourceEventMap, so cast
// the listener parameter to MessageEvent to access `.data`.
events.addEventListener("message.created", (e) => {
  const { message } = JSON.parse((e as MessageEvent).data);
});

events.addEventListener("reaction.added", (e) => {
  const { message, actorId, emoji } = JSON.parse((e as MessageEvent).data);
  // message.reactions is the COMPLETE set after the change - replace, don't merge.
});

events.addEventListener("participant.removed", (e) => {
  const { actorId, affectedUserIds, conversation } = JSON.parse((e as MessageEvent).data);
  // If affectedUserIds includes YOUR id, this is your removal - drop the
  // conversation; it's the last event you'll get for it. Otherwise replace
  // your cached copy with `conversation`.
});
// participant.added and conversation.updated carry the same shape.

events.onerror = () => {
  if (events.readyState === EventSource.CLOSED) {
    // Fatal (e.g. 401): the browser will NOT retry. Re-auth, then recreate.
  }
  // Otherwise: dropped connection - EventSource retries automatically with
  // Last-Event-ID and the server replays what was missed.
};
```

**Reaction events are a third category.** They're durable (stored, unlike
ephemeral plugin events) but reactions have no `seq`, so their SSE frames carry
**no `id:` line** - emitting one would rewind `Last-Event-ID` and replay
messages the client already has. The trade-off: reactions are **not
gap-filled**. A reaction applied while a client was disconnected shows up on
the next refetch of that conversation, not as a replayed frame. The payload is
`{ type, message, actorId, emoji }`, where `message.reactions` is the complete
set after the change - replace that field, don't merge into it. Design
rationale:
[ADR 0013](../../docs/decisions/0013-reactions-and-replies.md).

> **Browser auth for SSE must be cookie-based.** `EventSource` cannot send
> custom headers, so your `auth` hook must be able to resolve the user from
> what the browser sends automatically - typically a session cookie
> (`EventSource` sends same-origin cookies by default; pass
> `{ withCredentials: true }` for cross-origin). Header/bearer-token schemes
> work for the REST routes but not for `/stream`.
>
> **Any cross-site iframe drops `SameSite=Lax` cookies** - and that's exactly
> how AI-builder editors (Lovable, v0, Bolt, Shipper, ...) embed their preview
> panes. The app 401s in the preview but works in a real tab - the cookie
> never reaches the server. Demo cookies must be set with
> `SameSite=None; Secure; Partitioned`:
>
> ```ts
> document.cookie = "demo_user=alice; Path=/; Max-Age=86400; SameSite=None; Secure; Partitioned";
> ```
>
> (`localhost` counts as a secure context, so `Secure` works in dev too. For
> production apps that never run in an iframe, your auth library's
> `SameSite=Lax` default is correct and more CSRF-resistant.)

**Hybrid auth (bearer tokens + SSE).** If your app authenticates REST calls
with an `Authorization` header (Supabase, Clerk, Firebase JWTs, ...), you
don't have to abandon it - write the `auth` hook to accept _either_
credential: the header for REST requests, and a session cookie as the
fallback for `/stream`:

```ts
export const chat = chatpack({
  storage,
  auth: async (req) => {
    // 1. Bearer token - what your frontend already sends on REST calls.
    const bearer = req.headers.get("authorization")?.replace(/^Bearer /, "");
    if (bearer) {
      const user = await verifyJwt(bearer); // your auth provider's verify
      return user ? { id: user.id } : null;
    }
    // 2. Cookie fallback - the only thing EventSource can send.
    const session = await getSessionFromCookie(req.headers.get("cookie"));
    return session ? { id: session.userId } : null;
  },
});
```

The cookie can be your auth provider's own session cookie if it sets one, or
a short-lived one you set yourself from an authenticated endpoint right
before opening the stream. Avoid tokens in the `/stream` query string - URLs
end up in server logs and browser history.

**No lost messages:** events are published only _after_ the storage write
(durable-first), and every event id is `conversationId:seq`. On reconnect,
`EventSource` sends `Last-Event-ID` automatically and the server replays what
was missed from storage before resuming live delivery. Delivery is
at-least-once - dedupe by `message.id`. Details in
[ADR 0006](../../docs/decisions/0006-sse-gap-fill.md).

### Real-time plugins (ephemeral events)

Opt-in plugins add live signals on the **same** `/stream` connection:

```ts
import { typing, presence, receipts } from "@chatpack/core/plugins";

export const chat = chatpack({
  storage,
  auth,
  plugins: [typing(), presence(), receipts()],
});
```

| Event                                  | Published by | To whom                                                                 |
| -------------------------------------- | ------------ | ----------------------------------------------------------------------- |
| `typing.started` / `typing.stopped`    | `typing()`   | every other participant (never the typist)                              |
| `presence.online` / `presence.offline` | `presence()` | everyone who shares a conversation with the user                        |
| `receipt.delivered`                    | `receipts()` | the message sender, when a recipient's live stream receives the message |
| `receipt.read`                         | `receipts()` | every other participant, on mark-read                                   |

In a group these fan out to all N-1 others, so a receipt is a **per-user** ping,
not "everyone has read it" - track which ids you've seen if you want an
all-read state.

These are **ephemeral**: never stored, never replayed on reconnect, and their
SSE frames carry no `id:` field - so they can't disturb `Last-Event-ID`
gap-fill. The `data` payload is
`{ type, ephemeral: true, conversationId?, senderId, payload, at }`.
Client conventions: throttle typing POSTs to one every few seconds and expire
the indicator after ~5s of silence; dedupe receipt ticks by
`payload.messageId`; treat `lastReadMessageId` (durable, in core) as the
source of truth for read-state. Presence keeps in-memory, single-node state -
the SSE connection itself is the heartbeat, with an offline grace period
(`presence({ offlineDelayMs })`, default 5000) to absorb reconnect flaps.
Design rationale:
[ADR 0008](../../docs/decisions/0008-ephemeral-events-in-core-plugins.md).

You can write your own plugin - implement the exported `ChatpackPlugin`
interface (extra routes via `handleRequest`, live signals via
`publishEphemeral`, hooks for stream open/close, mark-read, and delivery).

If you write your own `Transport`, note that `TransportEvent` now has **four**
members: `ChatEvent` (messages), `ReactionEvent`, `ConversationEvent`
(membership/rename), and `EphemeralEvent`. So `!isEphemeralEvent(event)` no
longer means "this is a message" - use the exported `isMessageEvent(event)` when
you need the `seq`/`id:` frame. Plugin `onEventDelivered` still only ever sees a
`ChatEvent`.

> **⚠️ Deployment reality check:** the default transport is **in-process** and
> `memoryAdapter` is **per-process** - both assume one long-lived server
> (a Node server, a single Fly/Railway container, `next start`, `Bun.serve`).
> Running 2+ app servers behind a load balancer? Events published on one node
> never reach streams held by another - drop in
> [`@chatpack/transport-redis`](../transport-redis), a one-line change with the
> same public API (`presence()` still stays per-node).
> On serverless/edge platforms (Cloudflare Workers, Vercel/AWS Lambda), each
> isolate has its own memory and a bounded lifetime, so SSE is a poor fit
> whatever the transport: use a database adapter
> ([`@chatpack/adapter-drizzle`](../adapter-drizzle)) and poll instead of
> `/stream`. [`@chatpack/client`](../client#polling-fallback) does that on its
> own, so a serverless deploy needs no frontend change.

## Telemetry (anonymous, opt-out)

Chatpack reports **aggregate counters only** - deltas of `messagesSent` and
`conversationsCreated`, the library version, and a random per-process id -
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

Implement the exported `StorageAdapter` interface - the full contract ships
in the package's `.d.ts` with TSDoc on every method. The surface is
deliberately small:

| Method                          | Contract                                                                 |
| ------------------------------- | ------------------------------------------------------------------------ |
| `getOrCreateDirectConversation` | Find or atomically create by `pairKey` - concurrent calls must converge  |
| `createGroupConversation`       | Always creates: `type: "group"`, `pairKey: null`, creator as `admin`     |
| `updateConversation`            | Update a group's mutable fields (today just `name`)                      |
| `addParticipants`               | Idempotent add as `member`; return the **full** updated conversation     |
| `removeParticipant`             | Idempotent remove; keep the departed user's messages                     |
| `setParticipantRole`            | Change one participant's role; return the full conversation              |
| `getConversation`               | Fetch by id (with participants), or `null`                               |
| `listConversations`             | A user's conversations, most-recently-active first, cursor-paginated     |
| `addMessage`                    | Persist + assign the next strictly-increasing `seq` for the conversation |
| `getMessage`                    | Fetch by id, or `null`                                                   |
| `getMessagesByIds`              | Batched fetch by id; unknown ids simply absent (reply previews)          |
| `listMessages`                  | Newest-first, cursor-paginated                                           |
| `listMessagesAfterSeq`          | Messages with `seq > afterSeq`, **oldest first** (SSE gap-fill)          |
| `updateMessage`                 | Edit body / set `editedAt` / set `deletedAt` in place                    |
| `updateLastRead`                | Set a participant's `lastReadMessageId`                                  |
| `countUnread`                   | Batched per-conversation unread counts for one viewer                    |
| `addReaction`                   | Idempotent insert; return the message's **full** reaction set            |
| `removeReaction`                | Idempotent delete; return the remaining set                              |
| `listReactionsByMessageIds`     | Batched reactions for a page, ascending `createdAt`                      |

Contract rules that the type signatures alone don't tell you:

- **Reuse the reference schema - don't design your own.**
  `@chatpack/adapter-drizzle` exports the official data model two ways:
  `migrationSql` (plain idempotent Postgres DDL - no Drizzle needed to run
  it) and `chatpackSchema` (Drizzle table objects). If your database speaks
  SQL, start from those tables; if not, translate their shape.
- **Cursors are opaque strings that _you_ define.** Core and the HTTP layer
  round-trip your `nextCursor` back into `input.cursor` verbatim - pick any
  encoding that survives a URL query param (the Drizzle adapter uses the last
  message's `seq` for `listMessages`). Return `null` when there are no more
  results.
- **Return real `Date` instances, never ISO strings.** Core doesn't coerce;
  many drivers (and HTTP database clients like Supabase's) return strings -
  convert at the adapter boundary. JSON serialization is the HTTP handler's
  job, not the adapter's.
- **The adapter generates ids** for conversations and messages (any unique
  string - the official adapters use prefixed random ids like `msg_<uuid>`).
- **Never enforce permissions in the adapter** - core validates participants
  and permission hooks before calling you. On hosted databases this also
  means the adapter runs server-side with privileged credentials, and the
  Chatpack tables must not be readable by browser/anon clients.
- **`countUnread` is exact and batched**: per conversation, count messages
  with `seq` greater than the seq of the viewer's `lastReadMessageId`
  (`null` = 0) and `senderId !== userId`. Tombstones count. One query per
  page, not one per conversation.
- **Reaction writes are idempotent and return the full set.** Enforce
  uniqueness on `(messageId, userId, emoji)` in the database
  (insert-on-conflict-do-nothing), not in JS; a duplicate react and a missing
  un-react are both no-ops. Return every reaction on the message afterwards -
  core publishes that as a snapshot, so a delta blanks other users' reactions
  in every client. Reactions must **not** touch the conversation's `lastSeq` or
  activity timestamp.
- **Batched lookups tolerate misses.** `getMessagesByIds` and
  `listReactionsByMessageIds` take a whole page's ids and do one query;
  unknown ids are simply absent (no `null`s, no throw), and `[]` in means `[]`
  out without touching the database. Sort reactions ascending by `createdAt`.
- **Store `replyToMessageId` verbatim** - core already validated that it names
  a message in the same conversation. Adapters never see `replyTo` /
  `reactions`; those are core's per-request decorations.
- **Group creation is atomic and never find-or-create.** The conversation row
  and all its participant rows land in one transaction, and two groups with
  identical membership are two distinct groups. `pairKey` is `null` for groups,
  so its uniqueness index must be **partial**
  (`... WHERE pair_key IS NOT NULL`) - and on Postgres an `ON CONFLICT` only
  matches a partial index if the insert repeats the predicate.
- **Membership writes are idempotent, and never `DO UPDATE`.** Re-adding an
  existing participant is a no-op that must not reset their role or read-state
  (`ON CONFLICT DO NOTHING`); removing a non-participant is a silent no-op.
- **Participant order must be stable across reads** - clients diff positionally.
  Order by join time (or any deterministic key), not by whatever the database
  hands back.
- **Adapters never enforce group policy.** The last-admin rule, the 256-member
  cap, the DM-vs-group check, and `canManage` are all core's; by the time you're
  called they've passed.

The [in-memory adapter](../adapter-memory) is the reference implementation,
and the [Drizzle/Postgres adapter](../adapter-drizzle) shows the contract on
a real database (row-locked `seq` assignment, `ON CONFLICT` pair creation).
For the complete agent-friendly guide - invariants, reference schema, a
method-by-method skeleton, pitfalls, and a "verify your adapter" checklist -
see [`llms.txt`](../../llms.txt) at the repo root. Contract rules also live
in the [contributing guide](../../CONTRIBUTING.md).

## License

[MIT](../../LICENSE)
