# Chatpack — v0 MVP Plan

> Status: planning. No implementation yet.
> Scope principle: **v0 is backend-only, 1:1-only, and as minimal as possible.** When in doubt, cut it.

## 1. What v0 is

v0's single job is to prove that the **backend core API for one-to-one chat is so pleasant that developers happily build their own frontend on top of it.**

Developers bring their own **auth** and their own **frontend**. We give them a small, well-designed HTTP + SSE API and a clean server-side integration. A frontend is easy to generate once the API is simple and predictable, so we deliberately do not ship one in v0.

**v0 supports 1:1 (direct) conversations only** — exactly two participants. Groups come later. Restricting _who can talk_ simplifies the domain; it does **not** require shipping every consumer-chat polish feature (typing, presence, attachment uploads, etc.). Those are a separate scope axis.

We still include the genuinely hard part — **real-time delivery** — because a chat backend without it is just CRUD. Real-time in v0 means the **server** exposes an SSE stream endpoint; clients (which developers build) consume it. SSE is a backend feature; no React client is required.

## 2. In scope for v0

Core backend (`@chatpack/core`) — the irreducible, durable domain:

- **1:1 conversations** — find-or-create by a pair of user ids; exactly two members; list/fetch for the current user
- **Text messages** — send, list/paginate, edit, soft-delete
- **Permissions** — only the two participants can read/write (simple default; overridable via hook)
- **Durable read-state** — `last_read_message_id` per participant (survives reconnect; answers “have they seen up to X?”)
- **Auth/identity hook** — developers bring the authenticated user; we never do auth and never own a users table
- **Server-side SSE stream endpoint** — live delivery of new/edited/deleted messages
- **Framework handler** — mounts the whole API on one route (Web-standard `Request`/`Response`; Next.js App Router as the first documented target)

Reference adapters shipped with v0:

- **Storage adapter interface** + a **Drizzle/Postgres** reference implementation
- **In-memory storage adapter** (zero-setup demos + fast, deterministic tests)

Product / trust (small, but decide early):

- **Anonymous opt-out telemetry** — aggregate usage counters only (e.g. messages sent per month) for social proof. See §12. Counter hooks land with core; the flush + docs land in launch polish (M5).

That's the entire surface. Everything else is deferred.

## 3. Why 1:1 does _not_ pull in polish features

Two different scope axes — do not collapse them:

| Axis                                     | Question                              | v0 choice         |
| ---------------------------------------- | ------------------------------------- | ----------------- |
| **Who can talk?**                        | 1:1 vs groups                         | **1:1 only**      |
| **What ambient / media features exist?** | typing, presence, live ticks, uploads | **none of these** |

WhatsApp-style extras feel related to 1:1 because consumer apps bundle them. Chatpack is infrastructure, not WhatsApp. Many real products (marketplace DMs, support threads, coaching) need reliable 1:1 text + live delivery and nothing more.

| Feature                       | Verdict for v0 | Why                                                              |
| ----------------------------- | -------------- | ---------------------------------------------------------------- |
| Typing indicators             | Defer          | Ephemeral UX polish; not required for messaging to work          |
| Presence (online / last seen) | Defer          | Product + privacy opinion; many apps deliberately omit it        |
| Live delivery/read _pings_    | Defer          | Durable `last_read` + SSE message events cover most of the value |
| File / media attachments      | Non-goal       | A second product (blob storage, signed uploads, MIME/size, CDN)  |
| Groups                        | Defer          | Domain complexity we are explicitly cutting                      |

**Escape hatch (not a feature):** `metadata` on messages so a developer _can_ store something like `{ attachmentUrl: "..." }` they uploaded outside Chatpack. We do not upload or host files.

## 4. Deferred to the next release (v0.next)

Explicitly **not** in v0:

- **Group conversations** (N members, roles, invites)
- **Typing indicators** (`@chatpack/plugin-typing`)
- **Presence** (`@chatpack/plugin-presence`)
- **Live delivery/read receipt pings** (`@chatpack/plugin-receipts`) — ephemeral ticks only; durable last-read stays in core
- **React client + hooks** (`@chatpack/react`)
- **Generic ephemeral-event primitive** on the transport (exists to serve the plugins above; deferred with them)

## 5. Explicit non-goals (say no loudly)

- **Attachments / file uploads** as a first-class API — storage/CDN opinions; huge scope
- **Push / email notifications**
- **AI features** — leave `metadata` / `role` escape hatches only; do not design for AI
- **Threads, reactions, search, moderation, multi-tenant admin**
- **Horizontal multi-node fan-out** — single-node is correct for v0; transport is shaped so a Redis/pub-sub adapter can drop in later **without public API changes**

## 6. Architecture (backend-only, adapter-driven)

```
Developer's client (their code)
   │  HTTP: POST send / GET history   +   SSE: GET stream
   ▼
Framework handler  (@chatpack/next + a generic Web-standard handler)
   │  runs the auth hook, maps Request → core
   ▼
Core engine  (@chatpack/core)
   │  1:1 domain logic, permission checks, validation
   ├── Storage Adapter   → Drizzle/Postgres  (+ in-memory)
   └── Transport         → single-node in-process emitter → SSE fan-out
```

Two interfaces carry the whole design:

- **StorageAdapter** — durable reads/writes. Reference: Drizzle + Postgres. Interface-based, so Prisma/MySQL/SQLite/community adapters need no core changes.
- **Transport** — publish/subscribe of live message events to connected SSE clients. v0 ships a single-node in-process implementation; shaped so multi-node can come later with no public API change.

Durable data and live events stay separate: different reliability requirements; coupling them is how chat backends rot.

### Teaching note — adapters & core domain

- **Core domain** = chat concepts and rules (conversation, message, “only participants can write”), independent of Postgres or Next.js.
- **Adapter** = a plug that implements a contract for a specific tool (e.g. Drizzle writes rows; in-memory uses maps).
- **Interface** = the contract both sides agree on (`addMessage`, `listMessages`, …) without saying _how_.

The core depends on the interface, not on Postgres. That keeps tests fast and backends swappable.

## 7. Public API sketch (illustrative, not final)

Server setup — one object, sensible defaults:

```ts
// lib/chat.ts
import { chatpack } from "@chatpack/core";
import { drizzleAdapter } from "@chatpack/adapter-drizzle";
import { db } from "./db";

export const chat = chatpack({
  storage: drizzleAdapter(db),
  // resolve the current user from a request — the ONLY auth touchpoint
  auth: async (req) => getSessionUser(req),
  // optional; default = only the two participants
  permissions: {
    canRead: ({ user, conversation }) => conversation.participantIds.includes(user.id),
    canWrite: ({ user, conversation }) => conversation.participantIds.includes(user.id),
  },
});
```

Mount it — one route, handler does the rest:

```ts
// app/api/chat/[...chatpack]/route.ts   (Next.js App Router)
import { chat } from "@/lib/chat";
export const { GET, POST } = chat.handler();
```

Likely 1:1-shaped endpoints (names not final):

- find-or-create a direct conversation with another user
- list the current user’s conversations
- send / list / edit / soft-delete messages
- update last-read
- open the SSE stream

The developer builds any frontend against those REST + SSE endpoints.

## 8. Data model (1:1-minimal, with escape hatches)

Designed for exactly two participants. `metadata` JSON columns keep AI/custom use cases possible without designing for them.

- **conversations**: `id`, `created_at`, `metadata`  
  — no `type` field required in v0 (everything is direct). A `type` column can be added later when groups land without breaking the 1:1 path.
- **conversation_participants**: `conversation_id`, `user_id`, `joined_at`, `last_read_message_id`  
  — always two rows per conversation; uniqueness on `(conversation_id, user_id)`; a deterministic pair key (e.g. sorted `userA:userB`) prevents duplicate DMs between the same two users.
- **messages**: `id`, `conversation_id`, `sender_id`, `body`, `role` (defaults `user` — AI escape hatch), `created_at`, `edited_at`, `deleted_at` (soft delete), `metadata`
- Users are **referenced by id only** — we never own the users table.

Messages carry a monotonic sort key (`created_at` + tiebreaker, or a sequence) so a client can reconcile SSE events against fetched history deterministically.

## 9. Real-time contract

- **Send:** `POST` → core validates + permission-checks → writes to storage → publishes on the transport. Durable-first: the message exists before anyone is told about it.
- **Receive:** one **SSE connection per client**; server fans out events for that user’s 1:1 conversations.
- **Reconnection / gap-fill:** SSE `Last-Event-ID`; on reconnect the client sends its last-seen message id and the server replays anything missed from storage. At-least-once for durable messages; no message broker required.
- **Auth on the stream:** the same `auth` hook runs on the SSE connection; participation is re-checked server-side on every publish, never trusted from the client.

Documented v0 limitations: single-node fan-out only; SSE is server→client (sending is via POST); at-least-once with idempotent client-side dedupe by message id (no exactly-once).

## 10. Repo, tooling & release

- **Monorepo** (pnpm workspaces + Turborepo). v0 packages:
  - `@chatpack/core`, `@chatpack/adapter-drizzle`, `@chatpack/adapter-memory`, `@chatpack/next`
- **Build:** `tsup` (dual ESM/CJS + `.d.ts`), strict TS, `exports` maps, no default exports in the public API.
- **Testing:** Vitest. Core tested against the in-memory adapter; one Postgres integration suite (Testcontainers / docker-compose) in CI.
- **Example:** `examples/next-backend` — minimal Next.js app that mounts the handler and exercises REST + SSE (getting-started + e2e bed). No UI beyond proving endpoints.
- **Docs:** README with a 5-minute quickstart is the primary adoption artifact.
- **Release:** Changesets; everything `0.x`. CI on PRs (typecheck, lint, test, build).
- **License:** MIT. Add `CONTRIBUTING.md` + code of conduct.

## 11. Milestones (each independently shippable/demoable)

1. **M1 — Core + in-memory, no real-time.** 1:1 data model, storage adapter interface, in-memory adapter, find-or-create DM, send/list messages, permissions, last-read, unit tests. _DoD: two users get a conversation and exchange messages via the core API in a test._
2. **M2 — Framework handler + REST + auth hook.** `chat.handler()`, Next.js route, validation, permissions enforced. _DoD: curl can find-or-create, send, and list over HTTP with auth enforced._
3. **M3 — Server-side SSE.** One SSE connection per client, live delivery, reconnection/gap-fill. _DoD: two SSE clients see each other’s messages live; drop the connection, messages backfill on reconnect._
4. **M4 — Drizzle/Postgres adapter.** Real persistence + integration tests. _DoD: example app runs on Postgres._
5. **M5 — Launch polish.** README quickstart (including telemetry + how to opt out), anonymous telemetry flush endpoint + docs, `examples/next-backend`, Changesets, CI, publish `0.1.0` to npm.

## 12. Anonymous telemetry (opt-out) — decide early

**Why:** social proof for the project (“X messages sent last month”), not surveillance. Note it now so core can expose counter hooks before we publish; retrofitting telemetry into a “finished” public API is painful and trust-sensitive.

**What we collect (aggregates only):**

| Metric                        | Purpose                                                   |
| ----------------------------- | --------------------------------------------------------- |
| Messages sent (count)         | Headline social proof                                     |
| Conversations created (count) | Adoption signal                                           |
| Library version               | Know which releases are live                              |
| Anonymous install id          | Deduplicate / avoid double-counting the same app instance |

**What we never collect:** message bodies, user ids, conversation ids, emails, IP addresses used as identity, app URLs/hostnames that identify a customer, auth tokens, or any PII.

**Defaults & opt-out:**

- **On by default** (anonymous aggregates only).
- Opt out via config `telemetry: false` and/or env `CHATPACK_TELEMETRY=0` (exact names TBD; document both in README).
- README states clearly what is sent and how to turn it off.

**How it works (v0 shape):**

1. Core increments **in-process counters** on successful domain actions (e.g. after a message is persisted) — zero network on the send path.
2. A lightweight flusher (timer or process lifecycle) POSTs a small JSON payload to Chatpack’s telemetry endpoint: `{ installId, version, period, messagesSent, conversationsCreated }`.
3. Flush is **fire-and-forget**: timeouts, errors, and offline do not affect chat. No retries that could amplify load.
4. `installId` is a random UUID generated once per deployment (e.g. stored beside process state or a tiny local file) — not derived from user data or hostname.

**API sketch (illustrative):**

```ts
export const chat = chatpack({
  storage: drizzleAdapter(db),
  auth: async (req) => getSessionUser(req),
  // default true; set false or CHATPACK_TELEMETRY=0 to disable
  telemetry: true,
});
```

**Non-goals for telemetry:** product analytics dashboards for developers’ end users, per-tenant reporting, or anything that requires reading message content. If we ever need richer stats, that is a separate, explicitly scoped product — not this.
