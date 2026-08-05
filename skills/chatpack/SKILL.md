---
name: chatpack
description: Integrate Chatpack (@chatpack/core) - an open-source TypeScript 1:1 chat backend with REST + real-time SSE - into any app. Use when adding chat, messaging, DMs, or an AI-assistant conversation to an app; when working with any @chatpack/* package, chatpack(), chat.handler(), or toNextRouteHandlers; or when debugging Chatpack integrations (401 UNAUTHENTICATED, 404 on /api/chat/*, EventSource /stream not receiving events, cookies dropped in preview iframes).
---

# Integrating Chatpack

Chatpack is a chat **backend** library: 1:1 conversations, messages, permissions,
read-state, and real-time SSE. You bring auth and the frontend; Chatpack serves
everything else from ONE handler. It has no UI components and no AI features.

**Authoritative reference** (full route table, custom-adapter contract, HTTP
semantics): read `node_modules/@chatpack/core/llms.txt` after install. If the
package isn't installed yet, fetch
https://raw.githubusercontent.com/chddaniel/chatpack/main/llms.txt.
This skill is the workflow; that file is the truth. When they disagree, the
installed `llms.txt` wins (it matches the installed version).

## Hard rules (violating any of these is the #1 cause of broken integrations)

1. **Mount the ONE handler on a catch-all route. Never hand-write your own
   message/stream/API routes.** `chat.handler()` already serves every route -
   conversations, messages, read-state, plugins, AND `/stream` - under one
   `basePath` (default `/api/chat`).
2. **The only server-side methods on `chat.api`** are: `getOrCreateConversation`,
   `listConversations`, `getConversation`, `sendMessage`, `listMessages`,
   `searchMessages`, `editMessage`, `deleteMessage`, `addReaction`, `removeReaction`, `markRead`,
   `listMessagesAfter`.
   `getOrCreateDirectConversation` is a storage-adapter method - never call the
   adapter directly. If a method name is not in this list, **it does not exist -
   do not invent it.**
3. **Conversation ids are server-generated opaque strings** (e.g. `conv_1`).
   Never construct ids like `"alice-bob"`.
4. **Create exactly ONE `chatpack()` instance** in one module, guarded with
   `globalThis` for dev-server HMR, and import it everywhere (exact snippet in
   Step 2).
5. **The `auth` hook returns `{ id: string }` or `null`.** A bare string or
   `{ userId }` shape = unauthenticated = 401 on everything. The hook gets a raw
   WHATWG `Request` - there is no `request.cookies`; parse
   `request.headers.get("cookie")` yourself.
6. **Browser auth must be cookie-based** (`EventSource` can't send headers).
   Inside a cross-site iframe - every AI-builder preview pane - cookies need
   `SameSite=None; Secure; Partitioned` or they are silently dropped and every
   request 401s.

## Step 1 - Decide, before writing any code

**Storage** - pick one:

| Situation                                                                                      | Storage                                                        |
| ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Demo, tests, preview, single long-lived process                                                | `@chatpack/adapter-memory`                                     |
| Postgres reachable by **connection string** (Neon, RDS, Railway, Fly, Replit, Vercel Postgres) | `@chatpack/adapter-drizzle`                                    |
| DB behind an HTTP client only (Supabase JS, Convex, Firestore)                                 | Custom adapter - follow Part 2 of `llms.txt`; do NOT improvise |

**Auth** - pick one:

- App has real auth → use its **session cookie** in the hook. If REST calls use
  bearer tokens (Supabase/Clerk/Firebase), accept **either**: bearer first,
  cookie fallback (the cookie is what makes `/stream` work). Never put tokens
  in the `/stream` query string.
- No auth yet / demo → one demo cookie naming the user (Step 2), with the
  iframe-proof attributes.

**Deployment** - affects correctness, not just ops:

- One long-lived process (`node`/`Bun.serve`, `next start`, Railway/Fly/Render,
  AI-builder previews) → `/stream` SSE works; `memoryAdapter` OK for demos.
- Several long-lived processes behind a load balancer → shared database adapter
  **plus** `transport: redisTransport({ publisher, subscriber })` from
  `@chatpack/transport-redis` (two separate Redis clients; a subscriber-mode
  client can't `PUBLISH`). Without it, cross-node events are silently dropped.
  `presence()` stays per-node either way.
- Serverless/edge (Vercel, Lambda, Workers, **published** AI-builder apps) →
  `memoryAdapter` loses everything per-isolate: use a database adapter, and
  poll `GET /conversations/:id/messages` instead of `/stream` (function
  lifetime is the blocker, so no transport fixes it). Say this in the app's
  README.

## Step 2 - Install and create the ONE instance

```sh
npm install @chatpack/core @chatpack/adapter-memory   # or pnpm add / bun add
```

```ts
// chat.server.ts - the whole backend setup (lib/ or src/lib/)
import { chatpack, type ChatpackInstance } from "@chatpack/core";
import { typing, presence, receipts } from "@chatpack/core/plugins";
import { memoryAdapter } from "@chatpack/adapter-memory";

function demoAuth(request: Request) {
  const cookie = request.headers.get("cookie") ?? "";
  const id = /(?:^|;\s*)demo_user=([^;]+)/.exec(cookie)?.[1] ?? null;
  return id ? { id: decodeURIComponent(id) } : null;
}

const g = globalThis as typeof globalThis & { __chatpack__?: ChatpackInstance };
export const chat = (g.__chatpack__ ??= chatpack({
  storage: memoryAdapter(), // demo; Postgres for production
  plugins: [typing(), presence(), receipts()], // opt-in real-time trio
  auth: demoAuth,
}));
export const chatHandler = chat.handler(); // serves everything at /api/chat
```

Production storage swap: `drizzleAdapter(drizzle(process.env.DATABASE_URL!))`
from `@chatpack/adapter-drizzle`; run its migration first (`migrationSql`
export or drizzle-kit - see that package's README).

Optional `permissions: { canRead, canWrite }` hooks receive
`{ user, conversation }` (with `conversation.participantIds`); default is
participants-only, which is usually right.

Optional `hooks: { beforeMessageSend, afterMessageSend }` for content rules
and side-effects - both run on sends AND edits. `beforeMessageSend` can
throw to reject (sender gets 422 `MESSAGE_REJECTED`) or return
`{ body }`/`{ metadata }` to rewrite before persisting; `afterMessageSend`
runs post-persistence (queue AI replies here - it can't block or fail the
request). In-process functions, not webhooks.

## Step 3 - Mount the catch-all route (pick your framework)

**Next.js App Router** - the file MUST be a catch-all:

```ts
// app/api/chat/[...chatpack]/route.ts
import { toNextRouteHandlers } from "@chatpack/next"; // npm install @chatpack/next
import { chat } from "@/lib/chat.server";
export const { GET, POST, PATCH, DELETE } = toNextRouteHandlers(chat);
```

**TanStack Start** (Lovable's default stack) - the `$` catch-all segment is required:

```ts
// src/routes/api/chat.$.ts
import { createFileRoute } from "@tanstack/react-router";

async function handle({ request }: { request: Request }) {
  const { chatHandler } = await import("@/lib/chat.server");
  return chatHandler.fetch(request);
}

export const Route = createFileRoute("/api/chat/$")({
  server: { handlers: { GET: handle, POST: handle, PATCH: handle, DELETE: handle } },
});
```

**Bun / Deno / Cloudflare Workers:** `Bun.serve({ fetch: chatHandler.fetch })`

**Hono:** `app.all("/api/chat/*", (c) => chatHandler.fetch(c.req.raw))`
**Elysia:** `app.all("/api/chat/*", ({ request }) => chatHandler.fetch(request))`

**Express / plain Node:** needs a Node↔Web bridge that streams the response
body (that's what makes SSE work) - copy the recipe from `llms.txt`
("Mount recipes"), don't write it from memory.

## Step 4 - Frontend wiring

**Prefer the first-party client** when the frontend is browser JS/TS or React:
`npm install @chatpack/client` → `createChatClient()` (React apps import it
from `@chatpack/client/react` for hooks). It handles envelopes, the single
EventSource, reconnects, and dedupe for you, and keeps the conversations list
live (reorder + `unreadCount`) without any refetch-on-event code - see
"First-party client" in `llms.txt`. Pass the signed-in user's id as
`userId` (a cache hint, never auth) so their own messages don't count as
unread. The raw-fetch recipe below is the fallback for everything else:

```ts
// 1. demo sign-in: iframe-proof attributes (works on localhost too)
document.cookie = "demo_user=alice; Path=/; Max-Age=86400; SameSite=None; Secure; Partitioned";

// 2. open a conversation - the SERVER generates the id
const { conversation } = await fetch("/api/chat/conversations", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ otherUserId: "bob" }),
}).then((r) => r.json());

// 3. send a message - the text field is `body` (NOT text/content).
//    Add `replyToMessageId` to quote-reply an earlier message in the thread.
await fetch(`/api/chat/conversations/${conversation.id}/messages`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ body: "hey bob!" }),
});

// 4. react - POST to add, DELETE to remove; emoji goes in the BODY both times
await fetch(`/api/chat/messages/msg_1/reactions`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ emoji: "👍" }),
});

// 5. live updates - ONE EventSource; reconnect + gap-fill are automatic
const events = new EventSource("/api/chat/stream");
events.addEventListener("message.created", (e) => {
  const { message } = JSON.parse((e as MessageEvent).data);
  // dedupe by message.id (delivery is at-least-once), then render
});
events.addEventListener("reaction.added", (e) => {
  const { message } = JSON.parse((e as MessageEvent).data);
  // message.reactions is the COMPLETE set after the change - replace, don't merge
});
```

Client semantics that trip up generated code:

- HTTP responses are **enveloped**: `{ conversation }`, `{ message }`,
  `{ messages, nextCursor }` - unwrap them. (`chat.api.*` returns bare objects.)
- Message lists are **newest-first**; reverse for a transcript; paginate with
  `nextCursor` → `?cursor=`.
- Every conversation object carries the viewer's **`unreadCount`** (messages
  newer than their read-state, excluding their own) - read the badge from
  there, don't count client-side.
- Every message carries `reactions` (`[{ emoji, count, userIds }]`),
  `replyToMessageId`, and a read-only `replyTo` preview
  (`{ id, senderId, excerpt, deleted }`) hydrated per request - render the quote
  bar from `replyTo`, never store your own copy. Reaction routes are
  **idempotent** and always return the message's **complete** reaction set:
  replace that field, don't merge. `emoji` is any non-empty string ≤32 chars
  (`"👍"`, `":shipit:"`, `"custom_1234"`); `""` or longer is `INVALID_INPUT`.
  Replies are flat pointers, **not threads**; a reaction is not a message - no
  `seq`, no conversation reorder, no unread bump.
- **Reaction events aren't replayed.** `reaction.added`/`reaction.removed` are
  live-only: reactions have no `seq`, so their frames carry no `id:` and
  `Last-Event-ID` gap-fill skips them. Refetch the thread on stream reopen to
  pick up reactions applied while offline.
- Plugin events on the same stream: `typing.started/.stopped`,
  `presence.online/.offline`, `receipt.delivered/.read` - ephemeral, never
  replayed. Throttle typing POSTs to ~1 per 3s; expire indicators after ~5s.
- AI assistant = just a participant with a synthetic id (e.g. `"ai:assistant"`):
  persist the user message via `chat.api.sendMessage`, call your LLM in your
  backend, then `chat.api.sendMessage({ userId: "ai:assistant", ..., role: "assistant" })`.

## Step 5 - Verify BEFORE declaring success (mandatory)

Run these (adjust port/cookie names). All four must pass; do not report the
integration as working until they do.

```sh
# 1. auth + server-generated conversation id (expect 200, id like "conv_1")
curl -si -X POST localhost:3000/api/chat/conversations \
  -H 'cookie: demo_user=alice' -H 'content-type: application/json' \
  -d '{"otherUserId":"bob"}'

# 2. send + list (expect 201, then 200 newest-first)
curl -si -X POST localhost:3000/api/chat/conversations/conv_1/messages \
  -H 'cookie: demo_user=alice' -H 'content-type: application/json' -d '{"body":"hi"}'
curl -s 'localhost:3000/api/chat/conversations/conv_1/messages?limit=10' \
  -H 'cookie: demo_user=bob'

# 3. react twice (expect the SAME single reaction both times - it's idempotent)
curl -s -X POST localhost:3000/api/chat/messages/msg_1/reactions \
  -H 'cookie: demo_user=bob' -H 'content-type: application/json' -d '{"emoji":"👍"}'
curl -s -X POST localhost:3000/api/chat/messages/msg_1/reactions \
  -H 'cookie: demo_user=bob' -H 'content-type: application/json' -d '{"emoji":"👍"}'

# 4. live stream (expect ": connected", then events as messages are sent;
#    reaction.added frames arrive with no `id:` line - that is correct)
curl -sN localhost:3000/api/chat/stream -H 'cookie: demo_user=bob'
```

Browser check: after "sign in", `document.cookie` must contain the demo cookie
AND the Network tab must show it on `/api/chat/*` requests.

## Troubleshooting

| Symptom                                                    | Cause & fix                                                                                                                                                                            |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 401 on everything                                          | **Read the response body first** - it names the exact failure (bad hook return shape vs missing cookie vs unparsed cookie). Auth runs before routing, so fix auth before chasing 404s. |
| 401 only in the preview pane, works in a real tab          | Cross-site iframe dropped a `SameSite=Lax` cookie. Re-set it with `SameSite=None; Secure; Partitioned`.                                                                                |
| 404 `NOT_FOUND` after auth passes                          | Mount path/basePath mismatch, or the route file isn't a catch-all (`[...chatpack]` / `chat.$`).                                                                                        |
| `chat.api.getOrCreateDirectConversation is not a function` | Hallucinated method - the API method is `getOrCreateConversation` (Hard rule 2).                                                                                                       |
| Messages send but never appear live                        | Custom-written stream route, second `chatpack()` instance, or non-streaming Express bridge. One instance, one handler (Hard rules 1 & 4).                                              |
| `EventSource` closes and never retries                     | Fatal response (usually 401): browser won't reconnect on its own - re-auth, then create a new `EventSource`.                                                                           |
| Chat state vanishes between requests                       | `memoryAdapter` on serverless/multi-isolate, or HMR wiped an unguarded instance. Database adapter / `globalThis` guard.                                                                |
| Old package version right after a release (Bun)            | Bun's `minimumReleaseAge` guard - check `npm view @chatpack/core dist-tags`.                                                                                                           |

## Custom storage adapter (Supabase JS / Convex / Firestore / other)

Do NOT improvise: read **Part 2 of `llms.txt`** and follow it exactly - it
contains the 14-required-method `StorageAdapter` contract plus optional search,
the invariants (atomic
`pairKey` creation, atomic per-conversation `seq`, `Date` instances not ISO
strings, soft-delete as tombstone, newest-first vs oldest-first ordering,
batched exact unread counts, participant-scoped ranked search when supported,
idempotent reaction writes that never touch `lastSeq`/activity), the reference
Postgres schema, a skeleton, and a 14-point verification checklist.
The adapter must run server-side with privileged credentials; `chatpack_*`
tables must never be readable by browser/anon clients.
