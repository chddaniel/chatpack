---
name: chatpack
description: Integrate Chatpack (@chatpack/core) - an open-source TypeScript chat backend (1:1 and group conversations) with REST + real-time SSE - into any app. Use when adding chat, messaging, DMs, group chats, invite links, join requests, public channels, blocking/muting/reporting/banning, or an AI-assistant conversation to an app; when working with any @chatpack/* package, chatpack(), chat.handler(), or toNextRouteHandlers; or when debugging Chatpack integrations (401 UNAUTHENTICATED, 404 on /api/chat/*, EventSource /stream not receiving events, cookies dropped in preview iframes, 403 USER_BANNED, 501 INVITES_UNSUPPORTED, 501 CHANNELS_UNSUPPORTED, 501 MODERATION_UNSUPPORTED).
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
   `searchMessages`, `editMessage`, `deleteMessage`, `forwardMessage`,
   `addReaction`, `removeReaction`, `markRead`,
   `listMessagesAfter`, `createInvite`, `listInvites`, `revokeInvite`,
   `getInvitePreview`, `acceptInvite`, `requestToJoin`, `listJoinRequests`,
   `resolveJoinRequest`, `listPublicConversations`, `joinConversation` - plus the
   `chat.api.moderation.*` namespace (`blockUser`, `unblockUser`,
   `listBlockedUsers`, `muteConversation`, `unmuteConversation`,
   `listMutedConversations`, `report`, `listReports`, `getReport`,
   `updateReport`, `listBans`, `banUser`, `unbanUser`).
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
  For cross-node `presence()`, also pass
  `presence({ store: redisPresenceStore({ client: publisher }) })` - otherwise
  it counts connections per process and reports users on other nodes offline.
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

Optional `userExists: (userId) => boolean | Promise<boolean>` asks your identity
store whether a user is real before creating a DM, seeding a group, or adding
participants - `false` becomes 404 `USER_NOT_FOUND`. Omit it and user ids stay
fully opaque and unchecked (Chatpack never owns a users table). Core never asks
about the acting user, never asks twice about the same id, and batches the
lookups, so a 50-member group costs a handful of queries rather than 50. This
checks existence only - "is Alice allowed to message Bob" is `permissions`.

Optional `moderation: { canModerate, enforceBans }` turns on the report queue and
bans. `canModerate` receives `{ user, action, targetUserId?, reportId?, banId? }`
where `action` is one of `"reports.read"`, `"reports.update"`, `"bans.read"`,
`"bans.create"`, `"bans.revoke"` - return `true` for your staff. Omit the whole
option and Chatpack runs zero ban lookups per request; see the moderation part of
Step 4 for `enforceBans`.

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
//    `mentions` is an array of user IDS YOU SUPPLY - core never parses the text,
//    so build it from your @-picker, and every id must be a current participant.
await fetch(`/api/chat/conversations/${conversation.id}/messages`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ body: "hey @bob!", mentions: ["bob"] }),
});

// 4. forward - a COPY into another conversation, you as sender, its own id/seq.
//    The field naming the destination is `conversationId`.
await fetch(`/api/chat/messages/msg_1/forward`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ conversationId: "conv_2" }),
});

// 5. react - POST to add, DELETE to remove; emoji goes in the BODY both times
await fetch(`/api/chat/messages/msg_1/reactions`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ emoji: "👍" }),
});

// 6. live updates - ONE EventSource; reconnect + gap-fill are automatic
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
differ. Since `@chatpack/client` 0.5.0 all five are wrapped, so use the client
methods (hand-rolled `fetch` is only for integrations without the client):

```ts
// create - NOT find-or-create, so keep the id (creator becomes the first admin)
const group = await chatClient.conversations.createGroup({
  name: "Launch",
  userIds: ["bob", "carol"],
});

// add members / set a role / rename: admin only, all return the FULL conversation
await chatClient.conversations.addParticipants({
  conversationId: group.data.id,
  userIds: ["dave"],
});
await chatClient.conversations.setParticipantRole({
  conversationId: group.data.id,
  userId: "bob",
  role: "admin",
});
await chatClient.conversations.update({ conversationId: group.data.id, name: "Launch v2" });

// leave: removeParticipant with your own id (no admin rights needed). Promote a
// successor first if you're the last admin, or it's 409 LAST_ADMIN_REMAINING.
await chatClient.conversations.removeParticipant({
  conversationId: group.data.id,
  userId: me,
});
```

Membership changes update the client cache automatically - including being
added (the group appears in the list) and being removed (the conversation is
dropped; your own `participant.removed` is the only signal you get). These
events carry no `id:` line, so they are not gap-filled after a reconnect.

**Invite links and join requests** are the way in when you don't have someone's
user id. Eight routes, wrapped since `@chatpack/client` 0.7.0 - use the client
methods (hand-rolled `fetch` is only for integrations without the client). They
need an optional storage capability: both first-party adapters have it, a custom
adapter may not, and all eight then answer `501 INVITES_UNSUPPORTED` (check once
at startup, not per call).

```ts
// mint a link (admin by default; `canInvite` can loosen it to any member).
// Every field optional - no expiry and unlimited uses when you pass none.
const { data: invite } = await chatClient.invites.create({
  conversationId: groupId,
  expiresInSeconds: 86400,
  maxUses: 5,
});
// invite.code is 43 URL-safe chars - build your own /join/:code page from it

// the landing page. An InvitePreview, NOT a conversation: a participant COUNT and
// no user ids, because a non-member may call this.
const preview = await chatClient.invites.preview({ code });
// { conversationId, name, participantCount, requiresApproval, invitedBy, alreadyParticipant }

// redeem. Branch on `status`, never on which field came back null.
const result = await chatClient.invites.accept({ code });
if (result.data?.status === "joined")
  result.data.conversation; // in - members get participant.added
else result.data?.joinRequest; // requiresApproval: true - an admin must resolve it

// the other direction: ask to join a group you know the id of. No permission
// needed. 409 ALREADY_PARTICIPANT if you're already in.
await chatClient.joinRequests.create({
  conversationId: groupId,
  message: "I'm on the design team",
});

// the admin queue. NO event fires when a request arrives - poll this.
const queue = await chatClient.joinRequests.list({ conversationId: groupId });
// defaults to status: "pending"

// resolve by USER id, not request id
await chatClient.joinRequests.resolve({
  conversationId: groupId,
  userId: "erin",
  decision: "approve", // or "deny"
});
```

Invite rules core enforces (don't re-implement):

- **The code is a capability URL, not a credential** - possession is the
  permission, like a document share link. It rides in the path, so it lands in
  access logs; bound it with `expiresInSeconds` / `maxUses` / revocation. 50
  invites per group max (422 `INVITE_LIMIT_EXCEEDED`).
- **Redeeming is idempotent and never over-charges the link.** Someone already in
  gets the conversation back and consumes no use - even after the link is spent,
  so a double-clicked one-use link still answers the person it admitted. A
  redemption that would exceed 256 participants is 422 with the link intact.
- **404 vs 410.** Unknown _or revoked_ code → 404 `INVITE_NOT_FOUND`. Expired or
  out of uses → **410** `INVITE_EXPIRED`, meaning "ask for a new link".
- **Joining publishes the existing `participant.added` event** - no new SSE types
  to subscribe to. Creating a join request publishes nothing.
- **One request per user per group**, resolved by user id. Re-asking replaces the
  row, so **denial is not a block** - a ban (moderation, below) is what stops
  someone re-asking; a user block only covers DMs. Resolving twice is 404
  `JOIN_REQUEST_NOT_FOUND`.

**Public channels** are for the other shape of "let people in": a directory
anyone signed in can browse, no link and no user ids needed. A channel is **not a
new conversation type** - it's a group with `visibility: "public"`. Two routes,
wrapped since client 0.7.0, and a second optional capability (`501
CHANNELS_UNSUPPORTED`, independent of invites).

```ts
// publish an existing group, or set the fields at creation. Admin-only
// (canManage, NOT canInvite). Defaults are "private" + "approval".
await chatClient.conversations.update({
  conversationId: groupId,
  visibility: "public",
  joinPolicy: "open",
});
// PATCH is a real patch: sending only `visibility` keeps the name. An empty
// update is 400 - it's a mistake, not a no-op.

// browse. No permission needed. Thin previews, cursor-paginated.
const directory = await chatClient.channels.list({ limit: 20 });
// each: { conversationId, name, participantCount, joinPolicy, lastActivityAt,
//         alreadyParticipant, requestPending } - a COUNT, never member ids

// join. Same discriminated union as accepting an invite.
const result = await chatClient.channels.join({ conversationId: id });
if (result.data?.status === "joined")
  result.data.conversation; // "open" - in immediately
else result.data?.joinRequest; // "approval" - an admin resolves it, inviteCode is null
```

Channel rules core enforces:

- **Discoverable is not readable.** Browsing gives you a preview; `GET
/conversations/:id` and the messages routes still 403 `FORBIDDEN_READ` for a
  non-member. Build the UI as browse → join → read, and don't try to preload a
  transcript for a channel the user hasn't joined.
- **A public group defaults to `"approval"`**, and joining a private group is 403
  `NOT_PUBLIC_CONVERSATION` (not 404 - you can't probe for private groups anyway,
  since you'd need the id).
- **An invite still overrides the policy** in both directions: a link into an
  `"approval"` channel admits instantly, and one into an `"open"` channel is
  still a valid link. The admin who minted it already decided.
- **No new SSE events.** Joining publishes `participant.added` with the joiner as
  their own `actorId`; flipping the fields publishes `conversation.updated`.

**Moderation** is the other half of letting strangers in: blocks and mutes any
user can set for themselves, plus a report queue and bans that only your
moderators can touch. Thirteen routes under `/moderation/*`, all wrapped as
`chatClient.moderation.*`, behind a third optional storage capability (`501
MODERATION_UNSUPPORTED`, independent of invites and channels).

```ts
// self-service, no permission needed. Both creates are idempotent.
await chatClient.moderation.blockUser({ targetUserId: "bob" });
await chatClient.moderation.unblockUser({ targetUserId: "bob" });
await chatClient.moderation.listBlockedUsers({ limit: 20 }); // { blocks, nextCursor }
await chatClient.moderation.muteConversation({ conversationId });
await chatClient.moderation.unmuteConversation({ conversationId });
await chatClient.moderation.listMutedConversations();

// anyone can report a "user" | "message" | "conversation"
await chatClient.moderation.report({
  targetType: "message",
  targetId: messageId,
  reason: "harassment",
});

// moderators only - 403 NOT_MODERATOR for everyone else
const queue = await chatClient.moderation.listReports({ status: "open" });
await chatClient.moderation.getReport({ reportId });
await chatClient.moderation.updateReport({
  reportId,
  status: "triaged", // "open" | "triaged" | "resolved" | "dismissed"
  moderatorNote: "watching this one",
});
await chatClient.moderation.banUser({
  targetUserId: "troll",
  reason: "spam",
  expiresAt: null, // ISO string for a timed ban, null/omitted for permanent
});
await chatClient.moderation.listBans({ activeOnly: true });
await chatClient.moderation.unbanUser({ banId });
```

Moderation rules core enforces:

- **Who is a moderator is your call**, through a fifth hook:
  `chatpack({ moderation: { canModerate: ({ user }) => user.role === "staff" } })`.
  Without it the report queue and every ban route are 403 `NOT_MODERATOR` -
  blocks, mutes and filing a report still work.
- **Ban enforcement follows your config, not your adapter.** Bans are checked
  before routing on every request and on every SSE heartbeat, but only when
  `moderation` is configured - by default whenever `canModerate` is set, since
  `banUser` is the only way to mint a ban. An app with no `moderation` option
  pays no ban lookups at all. Pass `moderation: { enforceBans: true }` when ban
  rows are written outside Chatpack (an admin dashboard writing straight to the
  table), or `false` to keep the moderator tools without per-request
  enforcement.
- **A banned user is 403 `USER_BANNED` on everything**, including `/stream`. The
  client surfaces it as an error result, not an exception; a live EventSource is
  cut at the next heartbeat rather than instantly. Sign them out or show a
  blocked screen on that code - retrying is pointless until the ban is revoked.
- **A block is not a ban.** It stops _new_ direct conversations and direct
  message mutations both ways (403 `DIRECT_INTERACTION_BLOCKED`), but existing
  direct history stays readable, and it does nothing inside a shared group. Don't
  reach for `blockUser` to kick someone out of a channel - that's `removeParticipant`.
- **A mute is a hint for your UI.** It changes nothing server-side: unread counts
  still climb and SSE still delivers. Read the mute list and suppress your own
  notifications.
- **Reports dedupe per reporter + target** while one is still open or triaged, so
  a double-tapped report button returns the same report. Each carries immutable
  `evidence` (the message body and sender at filing time) so a later edit or
  delete can't launder it - render the report from `evidence`, not by re-fetching
  the message.
- **Revoked and expired bans stay in history.** `listBans({ activeOnly: false })`
  is the audit trail; two moderators banning the same person at the same moment
  leave exactly one active row.

Client semantics that trip up generated code:

- HTTP responses are **enveloped**: `{ conversation }`, `{ message }`,
  `{ messages, nextCursor }` - unwrap them. (`chat.api.*` returns bare objects.)
- Search with `messages.search({ query, limit, cursor })` or React's
  `useMessageSearch({ query, limit })`. Results cover only conversations the
  signed-in user participates in and are whole-token, case-insensitive,
  AND-matched, ranked snapshots. `SEARCH_UNSUPPORTED` is a structured 501, not
  a thrown exception. Debounce hook input; call `refetch()` to recompute rank.
  Edits and tombstones patch existing hits, and access loss removes them, but
  new messages are not inserted into a loaded search page.
- Message lists are **newest-first**; reverse for a transcript; paginate with
  `nextCursor` → `?cursor=`.
- `body` must be a **non-empty string after trimming**, on send and on edit.
  There are no body-less messages: an attachment-only or sticker-only composer
  must synthesize one (the file name, say), and whitespace won't pass.
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
- **`mentions` are ids you supply, not text Chatpack parsed.** Send or edit with
  `mentions: ["bob"]`; core never reads the body, so `"@bob"` in the text with an
  empty array (or the reverse) is legal and your composer owns keeping them
  aligned. Every id must be a **current participant** or the whole call is 400
  `MENTION_NOT_PARTICIPANT` - Chatpack won't silently drop one, because a drop
  nobody sees looks exactly like a notification that fired. Self-mentions are
  allowed, the cap is 256, and the array reads back **sorted, not in the order you
  passed it**: it's a set. On edit, omitting `mentions` leaves the stored set
  alone while `[]` clears it, and an id that's already stored stays valid even
  after that person leaves the conversation, so fixing a typo doesn't fail. A
  mention is not a message either (no `seq`, no unread bump, no SSE event of its
  own) and Chatpack keeps **no mention inbox** - notifying people is your job,
  from `mentions` on `afterMessageMutation`.
- **Forwarding is a copy, never a live pointer.** `POST
/messages/:id/forward` with `{ conversationId }` writes a NEW message into that
  conversation: your id as sender, the body verbatim, its own `seq`, counted in
  unread there. Edit or delete the original afterwards and the copy is unchanged -
  that's the point. You need **read** on the source and **write** on the target
  (403 `FORBIDDEN_READ` / `FORBIDDEN_WRITE`), and a deleted message is 409
  `MESSAGE_DELETED`. The copy carries `forwardedFrom` (`{ messageId,
conversationId, senderId }`) naming only the **immediate** source - one hop, no
  chains, and deliberately no excerpt and no source conversation _name_, since
  whoever reads the copy may have no access to where it came from. Reactions, the
  reply pointer, mentions, metadata and `role` do **not** travel; pass fresh ones
  in the forward body if you want them (`mentions` is validated against the
  **target**).
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
integration as working until they do. Skip #5-#7 if the app has no group UI.

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

# 4. mention a non-participant (expect 400 MENTION_NOT_PARTICIPANT, message NOT stored)
curl -si -X POST localhost:3000/api/chat/conversations/conv_1/messages \
  -H 'cookie: demo_user=alice' -H 'content-type: application/json' \
  -d '{"body":"hi @zed","mentions":["zed"]}'

# 5. group (expect 201, type "group", pairKey null, alice admin + bob member)
curl -si -X POST localhost:3000/api/chat/conversations/group \
  -H 'cookie: demo_user=alice' -H 'content-type: application/json' \
  -d '{"name":"Launch","userIds":["bob"]}'

# 6. forward into the group, then edit the ORIGINAL (expect the copy unchanged:
#    new id, seq 1 in conv_2, alice as sender, forwardedFrom naming msg_1)
curl -si -X POST localhost:3000/api/chat/messages/msg_1/forward \
  -H 'cookie: demo_user=alice' -H 'content-type: application/json' \
  -d '{"conversationId":"conv_2"}'

# 7. non-admin management is refused (expect 403 NOT_CONVERSATION_ADMIN)
curl -si -X POST localhost:3000/api/chat/conversations/conv_2/participants \
  -H 'cookie: demo_user=bob' -H 'content-type: application/json' \
  -d '{"userIds":["carol"]}'

# 8. live stream (expect ": connected", then events as messages are sent;
#    reaction.added and participant.* frames arrive with no `id:` line - correct)
curl -sN localhost:3000/api/chat/stream -H 'cookie: demo_user=bob'

# 7. invites, if the app has an invite UI (expect 201 with a 43-char code, then a
#    preview carrying participantCount and NO user ids, then 200 status "joined").
#    A 501 INVITES_UNSUPPORTED means the storage adapter lacks the capability.
curl -si -X POST localhost:3000/api/chat/conversations/conv_2/invites \
  -H 'cookie: demo_user=alice' -H 'content-type: application/json' -d '{"maxUses":1}'
curl -s localhost:3000/api/chat/invites/THE_CODE -H 'cookie: demo_user=carol'
curl -si -X POST localhost:3000/api/chat/invites/THE_CODE/accept -H 'cookie: demo_user=carol'
# accept AGAIN as carol: still 200 "joined" (idempotent), NOT 410 - the link is
# spent but she is already in. A third user now gets 410 INVITE_EXPIRED.

# 8. channels, if the app has a directory (expect 200 with the group listed,
#    previews carrying participantCount and NO user ids, then 200 "joined").
#    A 501 CHANNELS_UNSUPPORTED means the storage adapter lacks the capability.
curl -si -X PATCH localhost:3000/api/chat/conversations/conv_2 \
  -H 'cookie: demo_user=alice' -H 'content-type: application/json' \
  -d '{"visibility":"public","joinPolicy":"open"}'
curl -s 'localhost:3000/api/chat/channels?limit=20' -H 'cookie: demo_user=dave'
curl -si -X POST localhost:3000/api/chat/conversations/conv_2/join -H 'cookie: demo_user=dave'
# and the check that proves the boundary: GET a public channel as a user who has
# only browsed it - still 403 FORBIDDEN_READ, because discoverable isn't readable.
curl -si localhost:3000/api/chat/conversations/conv_2 -H 'cookie: demo_user=erin'

# 9. moderation, if the app has block/report/ban UI (expect 201, then 403s).
#    A 501 MODERATION_UNSUPPORTED means the adapter lacks the capability.
curl -si -X POST localhost:3000/api/chat/moderation/blocks \
  -H 'cookie: demo_user=alice' -H 'content-type: application/json' \
  -d '{"targetUserId":"bob"}'
# bob may still READ the old DM, but any write is 403 DIRECT_INTERACTION_BLOCKED
curl -si -X POST localhost:3000/api/chat/conversations/conv_1/messages \
  -H 'cookie: demo_user=bob' -H 'content-type: application/json' -d '{"body":"hi"}'
# the queue is staff-only (expect 403 NOT_MODERATOR without canModerate)
curl -si 'localhost:3000/api/chat/moderation/reports?status=open' -H 'cookie: demo_user=alice'
# ban, then prove enforcement: EVERY route, including /stream, is 403 USER_BANNED
curl -si -X POST localhost:3000/api/chat/moderation/bans \
  -H 'cookie: demo_user=staff' -H 'content-type: application/json' \
  -d '{"targetUserId":"troll","reason":"spam"}'
curl -si localhost:3000/api/chat/conversations -H 'cookie: demo_user=troll'
# 200 here instead means `moderation` isn't configured on the instance, so bans
# aren't enforced - add moderation.canModerate, or enforceBans: true.
```

Browser check: after "sign in", `document.cookie` must contain the demo cookie
AND the Network tab must show it on `/api/chat/*` requests.

## Troubleshooting

| Symptom                                                                          | Cause & fix                                                                                                                                                                                                |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 401 on everything                                                                | **Read the response body first** - it names the exact failure (bad hook return shape vs missing cookie vs unparsed cookie). Auth runs before routing, so fix auth before chasing 404s.                     |
| 401 only in the preview pane, works in a real tab                                | Cross-site iframe dropped a `SameSite=Lax` cookie. Re-set it with `SameSite=None; Secure; Partitioned`.                                                                                                    |
| 404 `NOT_FOUND` after auth passes                                                | Mount path/basePath mismatch, or the route file isn't a catch-all (`[...chatpack]` / `chat.$`).                                                                                                            |
| `chat.api.getOrCreateDirectConversation is not a function`                       | Hallucinated method - the API method is `getOrCreateConversation` (Hard rule 2).                                                                                                                           |
| Messages send but never appear live                                              | Custom-written stream route, second `chatpack()` instance, or non-streaming Express bridge. One instance, one handler (Hard rules 1 & 5).                                                                  |
| `EventSource` closes and never retries                                           | Fatal response (usually 401): browser won't reconnect on its own - re-auth, then create a new `EventSource`.                                                                                               |
| Chat state vanishes between requests                                             | `memoryAdapter` on serverless/multi-isolate, or HMR wiped an unguarded instance. Database adapter / `globalThis` guard.                                                                                    |
| Old package version right after a release (Bun)                                  | Bun's `minimumReleaseAge` guard - check `npm view @chatpack/core dist-tags`.                                                                                                                               |
| 409 `NOT_GROUP_CONVERSATION`                                                     | A group-only call (add/remove/role/rename) aimed at a DM. DM membership is fixed at creation.                                                                                                              |
| 409 `LAST_ADMIN_REMAINING`                                                       | Removing or demoting a group's only admin. Promote a successor first - Chatpack refuses rather than leave a group nobody can manage.                                                                       |
| Duplicate groups piling up                                                       | Treating `createGroupConversation` as find-or-create. It always creates; store the returned id (Hard rule 4).                                                                                              |
| Second group insert fails on a unique-key error                                  | Custom adapter left the `pair_key` unique index total instead of partial (`WHERE pair_key IS NOT NULL`), so two `NULL` keys collide.                                                                       |
| An admin silently becomes a `member`                                             | Custom adapter used `ON CONFLICT DO UPDATE` for participant inserts. Re-adding an existing member must be `DO NOTHING`.                                                                                    |
| 501 `INVITES_UNSUPPORTED`                                                        | The storage adapter has no `invites` capability. Both first-party adapters do; a custom one needs the whole nine-method namespace (all or nothing).                                                        |
| 410 `INVITE_EXPIRED` on a fresh-looking link                                     | Past `expiresAt`, or `maxUses` is spent. Mint a new one - the code is permanently done. A 404 instead means unknown _or revoked_.                                                                          |
| A one-use invite let in two people                                               | Custom adapter did `SELECT`-then-`UPDATE` in `consumeInvite`. It must be one atomic statement, same rule as `seq`.                                                                                         |
| A denied user can't re-request                                                   | Custom adapter used `DO NOTHING` in `createJoinRequest`. Join requests are the one place that needs `DO UPDATE` - reset `status` to `pending` and clear the resolution.                                    |
| 501 `CHANNELS_UNSUPPORTED`                                                       | The storage adapter has no `channels` capability - and it also blocks _setting_ `visibility`/`joinPolicy`, so a `POST /conversations/group` with `visibility: "public"` fails too.                         |
| 403 `NOT_PUBLIC_CONVERSATION` on join                                            | The group is still `visibility: "private"`. An admin must PATCH it public first; joining is only ever self-service for channels.                                                                           |
| A channel was published but the directory is empty                               | Custom adapter stored `visibility` nowhere (the columns are part of the **required** contract, not the `channels` namespace), or its query filters on `visibility` without `type`.                         |
| Renaming happened by accident when flipping visibility                           | Custom adapter tried to write only the field it thought changed. Core sends all three already resolved against the current row - write all three.                                                          |
| A user can browse a channel but gets 403 reading it                              | Working as designed: discoverable is not readable. Call the join route first; there is no read-without-membership mode.                                                                                    |
| 501 `MODERATION_UNSUPPORTED`                                                     | The storage adapter has no `moderation` capability. Both first-party adapters do; a custom one needs the whole namespace (blocks, mutes, reports, bans - all or nothing).                                  |
| 403 `NOT_MODERATOR` for your admin                                               | `moderation.canModerate` is missing or returned false. It's your hook, not a Chatpack role - check `ctx.action` (`bans.create` etc.) if you're gating per action.                                          |
| A ban was created but the user keeps chatting                                    | Bans are only enforced when `moderation` is configured. If the row was written outside Chatpack (an admin dashboard), pass `moderation: { enforceBans: true }`.                                            |
| 403 `USER_BANNED` on a user you already unbanned                                 | A timed ban that hasn't expired, or a duplicate active row from a custom adapter whose `createBan` reads-then-inserts. Check `listBans({ activeOnly: true })`.                                             |
| 403 `DIRECT_INTERACTION_BLOCKED`                                                 | Either side blocked the other - it's symmetric. Existing DM history still reads fine, and groups are unaffected; this only stops direct writes and new DMs.                                                |
| 400 `MENTION_NOT_PARTICIPANT` on a name the picker offered                       | The picker listed org members, not conversation participants. Populate it from `conversation.participants`, and refetch after a membership change - core validates every id and rejects the whole message. |
| Nobody got notified about a mention                                              | Expected: Chatpack stores mentions and stops. Wire your own push/email in `afterMessageMutation` using `ctx.mentions`, which is a subset of `ctx.recipientIds`.                                            |
| Mentions come back in a different order than they were sent                      | Correct, not a bug: mentions are a **set**, read back sorted by `(createdAt, userId)`. Don't encode meaning in the position - render them from the body instead.                                           |
| An edit dropped the mentions                                                     | The PATCH sent `mentions: []` (or a re-serialized empty composer state). Omit the field entirely to leave the stored set untouched.                                                                        |
| A forwarded message shows the wrong sender                                       | Working as designed - the forwarder is the sender, because they're the one speaking in the destination. The original author is in `forwardedFrom.senderId`; render "Forwarded" from there.                 |
| Editing the original didn't update the forward                                   | Forwarding **copies**. There is no live link, by design; if the copy must track the source you want a quote-reply in the same conversation, not a forward.                                                 |
| 409 `MESSAGE_DELETED` forwarding a message that's still on screen                | It's a tombstone - someone deleted it since the list was fetched. Refetch the thread; tombstones are never forwardable.                                                                                    |
| 400 `INVALID_INPUT` sending an image with no caption                             | `body` is required and non-empty after trimming; attachments never substitute for it. Synthesize a body (a space won't do - it's trimmed).                                                                 |
| Chrome uploads fail as `CLIENT_NETWORK_ERROR` with no request in the Network tab | `@filepack/client` ≤ 0.1.1 calls an unbound `globalThis.fetch` ("Illegal invocation"). Pass `controlFetch: (input, init) => fetch(input, init)` to `createChatpackFileClient`.                             |

Symptom not listed here, or the docs said something that turned out to be wrong?
Tell the maintainers - Discord <https://discord.gg/gY3GCTRv5Y> is the fastest,
[Discussions](https://github.com/chddaniel/chatpack/discussions) and
[issues](https://github.com/chddaniel/chatpack/issues/new/choose) also work.
Friction reports are wanted, not tolerated.

## Custom storage adapter (Supabase JS / Convex / Firestore / other)

Do NOT improvise: read **Part 2 of `llms.txt`** and follow it exactly - it
contains the 21-required-method `StorageAdapter` contract plus four optional
capabilities (search, the nine-method `invites` namespace, the one-method
`channels` namespace, and the `moderation` namespace),
the invariants (atomic
`pairKey` creation, atomic per-conversation `seq`, `Date` instances not ISO
strings, soft-delete as tombstone, newest-first vs oldest-first ordering,
batched exact unread counts, participant-scoped ranked search when supported,
idempotent reaction writes that never touch `lastSeq`/activity, single-statement
invite consumption, single-statement `createBan`,
`visibility`/`joinPolicy` round-tripping with coercion on
read, total mention replacement that preserves survivors' `createdAt`), the
reference Postgres schema, a skeleton, and a 22-point verification checklist.
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

Channels split across both halves of the contract, which is the one thing to get
right: the `visibility` and `join_policy` **columns are required** (add them with
`NOT NULL DEFAULT 'private'` / `'approval'` - no backfill needed), while only the
directory query lives in the optional `channels` namespace. Omitting the namespace
makes core refuse to set a non-default value, so a pre-channels adapter reports a
clean 501 instead of quietly storing a "public" channel nobody can find.

Mentions add the other two **required** methods, `setMessageMentions` and
`listMentionsByMessageIds` - one table, but two invariants that are easy to miss.
`setMessageMentions` is a **total replace**, so an empty array must delete every
row rather than no-op, and it must not re-stamp the `created_at` of an id that
survives the replace (do it as `ON CONFLICT DO NOTHING` plus a delete of the
complement, in one transaction). `listMentionsByMessageIds` is batched - one call
per page, never one per message - and must sort by `(created_at, user_id)`: a set
written in a single call shares a timestamp, and the id tiebreak is the only
reason two adapters return the same array.

Forwarding needs **no new method**. Three nullable columns on `chatpack_messages`
hold the provenance, written by the same `addMessage` you already have. Give them
**no foreign key**: the source can be hard-deleted or sit in a conversation this
reader can't open, and a cascade would rewrite history inside the copy.

Moderation is entirely optional and entirely self-contained: four tables (blocks,
mutes, reports with immutable evidence JSON, bans with expiry + revocation) and no
change to any existing one. Make block and mute creates idempotent, reuse an open
or triaged report for the same reporter and target, and keep revoked or expired
bans in history rather than deleting them. The one concurrency trap is `createBan`:
decide **in one statement** whether the user already has an active ban and return
that ban instead of inserting a second - otherwise two moderators acting at the
same moment leave two active rows, and revoking the one they can see leaves the
other still enforcing.
