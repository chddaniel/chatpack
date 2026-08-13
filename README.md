<div align="center">

# Chatpack

**Open-source chat infrastructure for developers.**

Install a package, wire up your database and auth, and get a production-ready
chat backend - 1:1 and group conversations, messages, permissions, read-state,
and real-time delivery - without rebuilding it from scratch.

[![CI](https://github.com/chddaniel/chatpack/actions/workflows/ci.yml/badge.svg)](https://github.com/chddaniel/chatpack/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Discord](https://img.shields.io/badge/Discord-Join%20the%20community-5865F2?logo=discord&logoColor=white)](https://discord.gg/gY3GCTRv5Y)

**[Documentation → docs.chatpack.dev](https://docs.chatpack.dev)** -
quickstart, concepts, real-time, storage adapters, framework guides, and the
full REST reference. (Source in [`apps/docs`](./apps/docs); run locally with
`pnpm --filter @chatpack/docs dev`.)

</div>

---

> **Status: `0.x` - v0 MVP + real-time plugins + unread counts + browser
> client + reactions + search + group chats, live on npm.** The v0 MVP (core engine,
> HTTP handler, real-time SSE, Postgres adapter) plus the opt-in real-time
> plugins - **`typing()`, `presence()`, and `receipts()`, all shipping today
> inside `@chatpack/core` under the `@chatpack/core/plugins` subpath** (see
> [Real-time plugins](#real-time-plugins-typing-presence-read-ticks)) - are
> published and installable now, along with the first-party
> [`@chatpack/client`](./packages/client), which provides the matching typed
> REST, SSE, and React client. The API is young - expect minor breaking
> changes before `1.0`. Follow along or [contribute](./CONTRIBUTING.md).

## Why

Every app that needs messaging ends up rebuilding the same things: conversations,
messages, permissions, read receipts, real-time delivery, group membership and
roles, and countless edge cases.

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
> step 6, where custom headers are impossible.
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
export const { GET, POST, PATCH, DELETE, PUT } = chat.handler();
```

Or, with the [`@chatpack/next`](./packages/next) helper (same result, reads
better):

```ts
import { toNextRouteHandlers } from "@chatpack/next";
import { chat } from "@/lib/chat";
export const { GET, POST, PATCH, DELETE, PUT } = toNextRouteHandlers(chat);
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
`GET`/`POST`/`PATCH`/`DELETE`/`PUT`/`fetch` are **all the same function** - the
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

Groups are **created, never found** - a separate route, because two groups with
the same members are still two different groups:

```sh
curl -X POST /api/chat/conversations/group \
  -H 'content-type: application/json' \
  -d '{"name": "Standup", "userIds": ["bob", "carol"]}'
```

The caller becomes an `admin`, everyone in `userIds` a `member`, and the
conversation comes back with `type: "group"`, `pairKey: null`, and the `name`.
Managing it afterwards is four admin-only routes - rename
(`PATCH /conversations/:id`), add (`POST /conversations/:id/participants`),
remove (`DELETE`, and any member may pass their own id to leave), and change a
role (`PATCH …/participants`). Groups hold 1-256 participants and always keep at
least one admin.

For the people whose user ids you don't have, mint an **invite link** instead:

```sh
curl -X POST /api/chat/conversations/conv_2/invites \
  -H 'content-type: application/json' \
  -d '{"expiresInSeconds": 86400, "maxUses": 5}'
```

You get back a 43-character `code` to build your own `/join/:code` page from.
`GET /invites/:code` previews what it admits to - a participant **count**, never
the member list, since a non-member can call it - and
`POST /invites/:code/accept` redeems it. Add `"requiresApproval": true` and
redeeming files a **join request** for an admin to approve instead, which is the
same queue any user lands in by asking directly
(`POST /conversations/:id/join-requests`). Either way, joining publishes the
existing `participant.added` event, so live clients need no new code.

When you want people to find the room themselves, publish the group as a
**public channel** - a group with `visibility: "public"`, not a third
conversation type:

```sh
curl -X PATCH /api/chat/conversations/conv_2 \
  -H 'content-type: application/json' \
  -d '{"visibility": "public", "joinPolicy": "open"}'
```

`GET /channels` is then a browsable directory for any signed-in user, returning
thin previews - a name, a participant **count**, and two viewer-relative flags -
and `POST /conversations/:id/join` gets them in: instantly when the policy is
`"open"`, or as a join request when it's `"approval"` (the default, because a
stranger in a queue is recoverable and a stranger in the room isn't).
**Discoverable is not readable**: browsing grants nothing, so reading the
transcript still means joining first.

Letting strangers in needs the other half too, so `/moderation/*` covers blocks,
mutes, reports, and bans. Blocking, muting, and filing a report are
self-service:

```sh
curl -X POST /api/chat/moderation/blocks \
  -H 'content-type: application/json' \
  -d '{"targetUserId": "bob"}'
```

A block stops new DMs and direct writes **both ways** while leaving the existing
history readable, and does nothing inside a shared group. A mute is a hint for
your own UI - unread counts and SSE delivery don't change. The report queue and
the ban routes are for your moderators, so they need a hook:

```ts
chatpack({
  storage,
  auth,
  moderation: { canModerate: ({ user }) => user.role === "staff" },
});
```

Without it, `GET /moderation/reports` and every ban route answer `403
NOT_MODERATOR`. With it, an active ban is checked **before routing** - a banned
user gets `403 USER_BANNED` on every route including `/stream`. Configuring
`moderation` at all is what switches that enforcement on, so an app that doesn't
use bans pays no per-request lookup; add `enforceBans: true` if ban rows are
written outside Chatpack.

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
    "metadata": {},
    "replyToMessageId": null,
    "replyTo": null,
    "reactions": []
  }
}
```

Quote-reply by passing `replyToMessageId`, and react with a `POST` (removing is
the same route with `DELETE`; the emoji travels in the body, not the path):

```sh
curl -X POST /api/chat/conversations/conv_1/messages \
  -H 'content-type: application/json' \
  -d '{"body": "hey alice!", "replyToMessageId": "msg_1"}'

curl -X POST /api/chat/messages/msg_1/reactions \
  -H 'content-type: application/json' \
  -d '{"emoji": "👍"}'
```

A reply carries a read-only `replyTo` preview
(`{ id, senderId, excerpt, deleted }`) hydrated per request - edit the parent
and the quote bar follows. Reaction routes are idempotent and always return the
message with its **complete** reaction set
(`[{ emoji, count, userIds }]`). These are quote-replies, not threads, and a
reaction is not a message: it has no `seq` and never reorders the conversation
list.

List history (newest first, keyset-paginated):

```sh
curl '/api/chat/conversations/conv_1/messages?limit=50'
```

```json
{ "messages": [{ "id": "msg_1", "body": "hey bob!", "seq": 1, "…": "…" }], "nextCursor": null }
```

Search participant conversations across message bodies. Search is
case-insensitive, punctuation-separated, relevance-ranked, and excludes
tombstones:

```sh
curl '/api/chat/search/messages?q=hello&limit=50'
```

The response is `{ "messages": [...], "nextCursor": null }`. Core applies
`canRead` to the participant-scoped results. Dynamic access to conversations
where the user is not a participant is not supported by this initial design.

Errors are JSON with a stable machine-readable code and a mapped HTTP status -
`401` when `auth` returns `null`, `400` for invalid input, `403`/`404`/`409`
for domain errors:

```json
{ "error": { "code": "FORBIDDEN_READ", "message": "…" } }
```

The full endpoint reference (every route, request/response shapes, error
codes) lives in [`@chatpack/core`'s README](./packages/core#rest-api).

### 5. Use the first-party client (optional)

The server setup above remains the same. Add the client when you want typed
REST methods, one managed SSE connection, a small shared cache, and React
hooks:

```sh
npm install @chatpack/client react
```

Create one shared client instance in its own module:

```ts
// lib/chat-client.ts
import { createChatClient } from "@chatpack/client/react";
import { typingClient, presenceClient, receiptsClient } from "@chatpack/client/plugins";

export const chatClient = createChatClient({
  // Omit baseURL when the client and handler share an origin.
  baseURL: "http://localhost:3000",
  credentials: "include",
  plugins: [typingClient(), presenceClient(), receiptsClient()],
});
```

Then read with hooks and write with actions - every action returns
`{ data, error }` instead of throwing:

```tsx
// components/messages.tsx
"use client";

import { chatClient } from "../lib/chat-client";

export function Messages({ conversationId }: { conversationId: string }) {
  const result = chatClient.useMessages({ conversationId, limit: 50 });

  async function send() {
    const sent = await chatClient.messages.send({
      conversationId,
      body: "hey bob!",
    });
    if (sent.error) console.error(sent.error.message);
  }

  return (
    <>
      <ul>
        {result.data?.messages.map((message) => (
          <li key={message.id}>{message.body}</li>
        ))}
      </ul>
      <button onClick={send}>Send</button>
    </>
  );
}
```

The client uses the authenticated identity resolved by the server's `auth`
hook. It does not implement login, sessions, or user lookup. Same-origin
cookies work by default; use `credentials: "include"` for cross-origin cookie
sessions. Native `EventSource` cannot send custom headers, so cookie auth is
also required for browser realtime unless you provide a custom EventSource.

Where SSE can't work - serverless function timeouts, buffering proxies, React
Native - the client falls back to refetching on an interval by itself, so a
serverless deploy needs no frontend change. Typing, presence and receipts are
unavailable while polling, since ephemeral events are never stored.

Group management is wrapped too (client 0.5.0+): `conversations.createGroup`,
`addParticipants`, `removeParticipant` (your own id = leave),
`setParticipantRole`, and `update` for renames - and membership events keep
the cache in sync, including dropping a conversation you were removed from.
Invites, join requests, and channels are wrapped by `chatClient.invites`,
`chatClient.joinRequests`, and `chatClient.channels`. Invite and channel joins
return either a joined conversation or a pending request; expected HTTP failures
remain structured client results. `chatClient.moderation` wraps all thirteen
moderation calls the same way - note that none of them touch the query cache, so
refetch the lists you show after a block or a mute.

See [`@chatpack/client`](./packages/client) for the framework-agnostic API,
React hooks, the polling fallback, and client plugin usage.

### 6. Go live in the browser

```ts
const events = new EventSource("/api/chat/stream");

// TypeScript: custom event names fall outside EventSourceEventMap, so the
// listener parameter is typed `Event` - cast to MessageEvent for `.data`.
events.addEventListener("message.created", (e) => {
  const { message } = JSON.parse((e as MessageEvent).data);
  // render it - reconnection & missed-message backfill are automatic
});

events.addEventListener("reaction.added", (e) => {
  const { message } = JSON.parse((e as MessageEvent).data);
  // message.reactions is the COMPLETE set after the change - replace, don't merge
});

events.addEventListener("participant.removed", (e) => {
  const { affectedUserIds, conversation } = JSON.parse((e as MessageEvent).data);
  // If affectedUserIds includes YOUR id, you were removed - drop the
  // conversation. Otherwise replace your cached copy with `conversation`.
});
// participant.added and conversation.updated (rename / role change) match.

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

Four things to know before going live:

- **Membership changes are live too, and also not replayed.**
  `participant.added` / `participant.removed` / `conversation.updated` carry
  `{ actorId, affectedUserIds, conversation }` - a complete snapshot, so replace
  your cached conversation rather than patching it. Compare `affectedUserIds`
  against your own id to tell "I was removed" (drop it; it's the last event
  you'll see for that conversation) from "someone else was".
- **Reactions are live but not replayed.** `reaction.added` /
  `reaction.removed` are stored, unlike ephemeral plugin events, but reactions
  have no `seq` - so their frames carry no `id:` (emitting one would rewind
  `Last-Event-ID`) and they are **not** gap-filled. A reaction applied while the
  client was offline appears on the next refetch of that conversation.
- **Browser auth must be cookie-based for SSE** - `EventSource` can't send
  custom headers, so your `auth` hook needs to resolve the user from a session
  cookie (sent automatically same-origin). Bearer-token headers work for the
  REST routes but not `/stream` - if your app uses them, write the `auth`
  hook to accept either (header first, cookie fallback); worked example in
  [`@chatpack/core`'s README](./packages/core#real-time-sse). If the app runs
  inside an embedded preview iframe (AI-builder editors), the cookie needs
  `SameSite=None; Secure` - see the quickstart note in step 2.
- **SSE + `memoryAdapter` need one long-lived process.** The default transport
  fans out inside a single process, so with 2+ app servers a message sent on one
  node never reaches a stream on another - drop in
  [`@chatpack/transport-redis`](./packages/transport-redis) (one line) to relay
  events between nodes. On serverless/edge (Workers, Lambda) each isolate has
  its own memory - use a [database adapter](./packages/adapter-drizzle) there and
  poll for new messages; SSE is a poor fit regardless of transport, since the
  function lifetime is the blocker. `@chatpack/client` falls back to polling on
  its own, so a serverless deploy needs no frontend change. Details in
  [`@chatpack/core`'s README](./packages/core#real-time-sse).

### 7. Or call it straight from server code

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

// react to a message (idempotent - returns the full reaction set)
await chat.api.addReaction({ userId: "bob", messageId: messages[0].id, emoji: "👍" });
await chat.api.removeReaction({ userId: "bob", messageId: messages[0].id, emoji: "👍" });
```

Groups use a different first call - `createGroupConversation` always creates,
and everything after it is the same API:

```ts
const group = await chat.api.createGroupConversation({
  userId: "alice", // becomes the group's first admin
  userIds: ["bob", "carol"], // joined as members
  name: "Standup",
});

await chat.api.addParticipants({ userId: "alice", conversationId: group.id, userIds: ["dave"] });
await chat.api.setParticipantRole({
  userId: "alice",
  conversationId: group.id,
  targetUserId: "bob",
  role: "admin",
});
await chat.api.removeParticipant({
  userId: "carol", // passing your own id = leaving; no admin needed
  conversationId: group.id,
  targetUserId: "carol",
});
```

That's it. Only participants can read or write - enforced by default,
customizable via the `permissions` hooks (`canRead`, `canWrite`, `canManage` for
the group-management methods including publishing a channel, and `canInvite` for
minting links - the last two default to admins only, and browsing or joining a
public channel is gated by neither). Platform-wide moderators are a separate
hook, `moderation: { canModerate }`, because being an admin of one conversation
shouldn't open the report queue for all of them. Need content
rules (length caps, profanity filters) or post-send side-effects? Add
`hooks: { beforeMessageSend, afterMessageMutation }` - block or rewrite a
message before it persists, react after send/edit/delete persistence (see [`@chatpack/core`'s
README](./packages/core#message-hooks)).

### 8. Bonus: chat with an AI assistant

To Chatpack, an AI assistant is **just another participant** - pick a
synthetic user id (any string you'll never issue to a real user, e.g.
`ai:assistant`) and have your backend send its replies. No special AI support
needed, and the same permissions apply (drop the same id into a group's
`userIds` for a shared assistant):

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
  within ~5s. Send `{ "isTyping": false }` to clear it eagerly. In a group the
  ping goes to every other participant, so key your indicator by `senderId` -
  several people can be typing at once.
- **Presence needs no heartbeat endpoint** - the SSE connection _is_ the
  heartbeat. Multi-tab safe; a short grace period (default 5s,
  `presence({ offlineDelayMs })`) stops the online dot from blinking during
  `EventSource` auto-reconnects. Snapshots via `GET /presence` only reveal
  users the caller shares a conversation with.
- **Receipts** are instant ✓/✓✓ pings while both sides are online:
  `receipt.delivered` fires to the sender the moment a recipient's stream
  receives the message; `receipt.read` fires when someone else calls mark-read.
  Ticks are at-least-once - dedupe by `payload.messageId`. Each tick is
  **per-user**, so in a group collect `senderId`s rather than treating one tick
  as "everyone read it". The durable truth is still `lastReadMessageId`.
- Plugin state is **in-memory and single-node** (MVP §5).
  [`@chatpack/transport-redis`](./packages/transport-redis) relays events
  between nodes, but `presence()` connection state remains local to each
  process.

Want to write your own plugin? The seam is public - see `ChatpackPlugin` in
[`@chatpack/core`](./packages/core) and
[ADR 0008](./docs/decisions/0008-ephemeral-events-in-core-plugins.md).

## What's in v0

| Feature                                  | Status            |
| ---------------------------------------- | ----------------- |
| 1:1 conversations (find-or-create)       | ✅ Done (M1)      |
| Text messages: send, list, edit, delete  | ✅ Done (M1)      |
| Participant-only permissions + hooks     | ✅ Done (M1)      |
| Durable read-state (`last_read`)         | ✅ Done (M1)      |
| In-memory storage adapter                | ✅ Done (M1)      |
| HTTP handler (Next.js App Router)        | ✅ Done (M2)      |
| Real-time delivery (SSE)                 | ✅ Done (M3)      |
| SSE reconnect gap-fill                   | ✅ Done (M3)      |
| Drizzle/Postgres adapter                 | ✅ Done (M4)      |
| Launch polish + npm release              | ✅ Done (M5)      |
| Typing / presence / read-tick plugins    | ✅ Done (v0.next) |
| Unread counts (`unreadCount`)            | ✅ Done (v0.next) |
| Redis transport (multi-node SSE)         | ✅ Done (v0.next) |
| Browser client + React hooks             | ✅ Done (v0.next) |
| Client polling fallback                  | ✅ Done (v0.next) |
| Reactions + quote-replies                | ✅ Done (v0.next) |
| Participant-scoped message search        | ✅ Done (v0.next) |
| Post-persistence message mutation hook   | ✅ Done (v0.next) |
| `@chatpack/cli init`                     | ✅ Done (v0.next) |
| Group chats: membership, roles, admin    | ✅ Done (v0.next) |
| File attachments (`@chatpack/file`)      | ✅ Done (v0.next) |
| Invite links + join requests             | ✅ Done (v0.next) |
| Public channels (browsable directory)    | ✅ Done (v0.next) |
| Moderation: blocks, mutes, reports, bans | ✅ Done (v1.next) |

Push notification providers, reusable UI components, true message threads,
and multi-node presence have not shipped. Replies are flat pointers, not
threads. See [docs/MVP.md](./docs/MVP.md) for the full scope and reasoning.

## Packages

| Package                                                   | Description                                      |
| --------------------------------------------------------- | ------------------------------------------------ |
| [`@chatpack/core`](./packages/core)                       | The chat engine: domain logic, permissions, API  |
| [`@chatpack/adapter-drizzle`](./packages/adapter-drizzle) | Drizzle/Postgres storage (production)            |
| [`@chatpack/adapter-memory`](./packages/adapter-memory)   | In-memory storage (demos, tests)                 |
| [`@chatpack/next`](./packages/next)                       | Next.js App Router integration                   |
| [`@chatpack/client`](./packages/client)                   | Typed REST, SSE, React hooks, and client plugins |
| [`@chatpack/cli`](./packages/cli)                         | Safe project setup CLI (`chatpack init`)         |
| [`@chatpack/transport-redis`](./packages/transport-redis) | Redis pub/sub transport (multi-node SSE)         |
| [`@chatpack/file`](./packages/file)                       | Filepack-backed message attachments              |

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

## Community

- **[GitHub Discussions](https://github.com/chddaniel/chatpack/discussions)** — questions, show-and-tell, and feedback
- **[Discord](https://discord.gg/gY3GCTRv5Y)** — chat with the community
- **[Open an issue](https://github.com/chddaniel/chatpack/issues/new/choose)** — bugs and feature requests

If you've built something with Chatpack, got stuck installing it, or have opinions about the API — we want to hear from you. The team reads everything.

## Contributing

Contributions are very welcome - see [CONTRIBUTING.md](./CONTRIBUTING.md) for
repo layout, dev workflow, and the adapter contract.

## License

[MIT](./LICENSE)
