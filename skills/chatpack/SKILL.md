---
name: chatpack
description: Integrate Chatpack (@chatpack/core) - an open-source TypeScript chat backend (1:1 and group conversations) with REST + real-time SSE - into any app. Use when adding chat, messaging, DMs, group chats, or an AI-assistant conversation to an app; when working with any @chatpack/* package, chatpack(), chat.handler(), or toNextRouteHandlers; or when debugging Chatpack integrations (401 UNAUTHENTICATED, 404 on /api/chat/*, EventSource /stream not receiving events, cookies dropped in preview iframes).
---

# Integrating Chatpack

Chatpack is a chat **backend** library: 1:1 and group conversations, messages,
permissions, read-state, and real-time SSE. You bring auth and the frontend;
Chatpack serves everything else from ONE handler. It has no UI components and no
AI features.

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
   `createGroupConversation`, `listConversations`, `getConversation`,
   `updateConversation`, `addParticipants`, `removeParticipant`,
   `setParticipantRole`, `sendMessage`, `listMessages`,
   `searchMessages`, `editMessage`, `deleteMessage`, `addReaction`, `removeReaction`, `markRead`,
   `listMessagesAfter`.
   `getOrCreateDirectConversation` is a storage-adapter method - never call the
   adapter directly. If a method name is not in this list, **it does not exist -
   do not invent it.**
3. **Conversation ids are server-generated opaque strings** (e.g. `conv_1`).
   Never construct ids like `"alice-bob"`.
4. **DMs and groups are one `Conversation` shape, told apart by `type`.**
   `"direct"` = exactly 2 participants, a `pairKey`, no `name`. `"group"` =
   1..256 participants, `pairKey: null`, optional `name`. **DMs are
   find-or-create; groups never are** - calling `createGroupConversation` twice
   with the same members makes two groups, so store the returned id. Group-only
   calls on a DM are 409 `NOT_GROUP_CONVERSATION`.
5. **Create exactly ONE `chatpack()` instance** in one module, guarded with
   `globalThis` for dev-server HMR, and import it everywhere (exact snippet in
   Step 2).
6. **The `auth` hook returns `{ id: string }` or `null`.** A bare string or
   `{ userId }` shape = unauthenticated = 401 on everything. The hook gets a raw
   WHATWG `Request` - there is no `request.cookies`; parse
   `request.headers.get("cookie")` yourself.
7. **Browser auth must be cookie-based** (`EventSource` can't send headers).
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
  `memoryAdapter` loses everything per-isolate: use a database adapter, and poll
  instead of `/stream` (function lifetime is the blocker, so no transport fixes
  it). With `@chatpack/client` this is automatic - `realtime: { mode: "poll" }`
  only skips the doomed attempt. Never hand-roll an interval. Say this in the
  app's README.

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

Optional `hooks: { beforeMessageSend, afterMessageMutation }` for content rules
and side-effects. `beforeMessageSend` can throw to reject (sender gets 422
`MESSAGE_REJECTED`) or return `{ body }`/`{ metadata }` to rewrite before
persisting. `afterMessageMutation` runs after persistence and internal
broadcast for `send`, `edit`, or `delete`; filter `ctx.action` for push or
queue work. It cannot block or fail the request. `afterMessageSend` remains a
deprecated send/edit-only compatibility hook. In-process functions, not
webhooks.

## Step 3 - Mount the catch-all route (pick your framework)

**Next.js App Router** - the file MUST be a catch-all:

```ts
// app/api/chat/[...chatpack]/route.ts
import { toNextRouteHandlers } from "@chatpack/next"; // npm install @chatpack/next
import { chat } from "@/lib/chat.server";
export const { GET, POST, PATCH, DELETE, PUT } = toNextRouteHandlers(chat);
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
  server: { handlers: { GET: handle, POST: handle, PATCH: handle, DELETE: handle, PUT: handle } },
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
unread. Where a stream can't be held (serverless, buffering proxies, React
Native) it falls back to interval refetch on its own - status `"polling"`,
typing/presence/receipts unavailable. The raw-fetch recipe below is the fallback
for everything else:

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

**Groups** reuse every messages/stream route above - only creation and membership
differ. The client package doesn't wrap these five yet, so use `fetch`:

```ts
// create - NOT find-or-create, so keep the id (creator becomes the first admin)
const { conversation: group } = await fetch("/api/chat/conversations/group", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ name: "Launch", userIds: ["bob", "carol"] }),
}).then((r) => r.json());

// add members / set a role / rename: admin only, all return the FULL conversation
await fetch(`/api/chat/conversations/${group.id}/participants`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ userIds: ["dave"] }),
});

// leave: DELETE your own id (no admin rights needed). Promote a successor first
// if you're the last admin, or it's 409 LAST_ADMIN_REMAINING.
await fetch(`/api/chat/conversations/${group.id}/participants`, {
  method: "DELETE",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ userId: me }),
});

// membership changes arrive on the same stream (no `id:` line, so no gap-fill)
events.addEventListener("participant.removed", (e) => {
  const { affectedUserIds, conversation } = JSON.parse((e as MessageEvent).data);
  // you get this even when YOU were removed - drop the conversation in that case
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
- **Reaction and membership events aren't replayed.**
  `reaction.added`/`.removed` and `participant.added`/`.removed` /
  `conversation.updated` are live-only: they have no `seq`, so their frames carry
  no `id:` and `Last-Event-ID` gap-fill skips them. Refetch the thread and the
  conversation list on stream reopen to pick up what changed while offline.
- **Group rules core enforces for you** (don't re-implement them): only admins
  add, remove others, rename, or change roles - otherwise 403
  `NOT_CONVERSATION_ADMIN`; anyone may remove _themselves_; a group always keeps
  at least one admin (409 `LAST_ADMIN_REMAINING`); 256 participants max (422
  `GROUP_LIMIT_EXCEEDED`); names are trimmed 1..200 chars, and omitting `name`
  in a rename leaves it unchanged rather than clearing it. Adding an existing
  member is a no-op, not an error.
- Plugin events on the same stream: `typing.started/.stopped`,
  `presence.online/.offline`, `receipt.delivered/.read` - ephemeral, never
  replayed. Throttle typing POSTs to ~1 per 3s; expire indicators after ~5s.
- AI assistant = just a participant with a synthetic id (e.g. `"ai:assistant"`):
  persist the user message via `chat.api.sendMessage`, call your LLM in your
  backend, then `chat.api.sendMessage({ userId: "ai:assistant", ..., role: "assistant" })`.
  The same id works in a group - pass it in `userIds`; gate on a mention before
  answering rather than replying to every message.

## Step 5 - Verify BEFORE declaring success (mandatory)

Run these (adjust port/cookie names). All must pass; do not report the
integration as working until they do. Skip #4 if the app has no group UI.

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

# 4. group (expect 201, type "group", pairKey null, alice admin + bob member)
curl -si -X POST localhost:3000/api/chat/conversations/group \
  -H 'cookie: demo_user=alice' -H 'content-type: application/json' \
  -d '{"name":"Launch","userIds":["bob"]}'

# 5. non-admin management is refused (expect 403 NOT_CONVERSATION_ADMIN)
curl -si -X POST localhost:3000/api/chat/conversations/conv_2/participants \
  -H 'cookie: demo_user=bob' -H 'content-type: application/json' \
  -d '{"userIds":["carol"]}'

# 6. live stream (expect ": connected", then events as messages are sent;
#    reaction.added and participant.* frames arrive with no `id:` line - correct)
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
| Messages send but never appear live                        | Custom-written stream route, second `chatpack()` instance, or non-streaming Express bridge. One instance, one handler (Hard rules 1 & 5).                                              |
| `EventSource` closes and never retries                     | Fatal response (usually 401): browser won't reconnect on its own - re-auth, then create a new `EventSource`.                                                                           |
| Chat state vanishes between requests                       | `memoryAdapter` on serverless/multi-isolate, or HMR wiped an unguarded instance. Database adapter / `globalThis` guard.                                                                |
| Old package version right after a release (Bun)            | Bun's `minimumReleaseAge` guard - check `npm view @chatpack/core dist-tags`.                                                                                                           |
| 409 `NOT_GROUP_CONVERSATION`                               | A group-only call (add/remove/role/rename) aimed at a DM. DM membership is fixed at creation.                                                                                          |
| 409 `LAST_ADMIN_REMAINING`                                 | Removing or demoting a group's only admin. Promote a successor first - Chatpack refuses rather than leave a group nobody can manage.                                                   |
| Duplicate groups piling up                                 | Treating `createGroupConversation` as find-or-create. It always creates; store the returned id (Hard rule 4).                                                                          |
| Second group insert fails on a unique-key error            | Custom adapter left the `pair_key` unique index total instead of partial (`WHERE pair_key IS NOT NULL`), so two `NULL` keys collide.                                                   |
| An admin silently becomes a `member`                       | Custom adapter used `ON CONFLICT DO UPDATE` for participant inserts. Re-adding an existing member must be `DO NOTHING`.                                                                |

## Custom storage adapter (Supabase JS / Convex / Firestore / other)

Do NOT improvise: read **Part 2 of `llms.txt`** and follow it exactly - it
contains the 19-required-method `StorageAdapter` contract plus optional search,
the invariants (atomic
`pairKey` creation, atomic per-conversation `seq`, `Date` instances not ISO
strings, soft-delete as tombstone, newest-first vs oldest-first ordering,
batched exact unread counts, participant-scoped ranked search when supported,
idempotent reaction writes that never touch `lastSeq`/activity), the reference
Postgres schema, a skeleton, and a 17-point verification checklist.
The adapter must run server-side with privileged credentials; `chatpack_*`
tables must never be readable by browser/anon clients.

The five group methods (`createGroupConversation`, `addParticipants`,
`removeParticipant`, `setParticipantRole`, `updateConversation`) are **required,
not optional** like `searchMessages` - an adapter written before groups won't
typecheck until it has them. Two traps that only bite in production: `pair_key`
must become **nullable with a PARTIAL unique index** (`WHERE pair_key IS NOT
NULL`) or the second group collides on `NULL`, and Postgres only matches a
partial index in `ON CONFLICT` when the insert **repeats the same predicate** -
so the DM upsert needs `WHERE pair_key IS NOT NULL` too. Membership inserts use
`ON CONFLICT DO NOTHING`, never `DO UPDATE`: an update would demote an admin to
`member` when someone re-adds them.
