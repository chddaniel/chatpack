# @chatpack/adapter-drizzle

Drizzle ORM (Postgres) storage adapter for Chatpack - real persistence for
production. Works with any Drizzle Postgres driver: node-postgres,
postgres.js, PGlite, Neon, Vercel Postgres.

> Part of [Chatpack](https://github.com/chddaniel/chatpack) - open-source chat
> infrastructure for developers.

## Install

```sh
# pick your package manager
npm  install @chatpack/core @chatpack/adapter-drizzle drizzle-orm pg
pnpm add     @chatpack/core @chatpack/adapter-drizzle drizzle-orm pg
bun  add     @chatpack/core @chatpack/adapter-drizzle drizzle-orm pg
```

`drizzle-orm` is a peer dependency - the adapter plugs into the Drizzle
instance your app already has.

## Use

```ts
import { drizzle } from "drizzle-orm/node-postgres";
import { chatpack } from "@chatpack/core";
import { drizzleAdapter } from "@chatpack/adapter-drizzle";

const db = drizzle(process.env.DATABASE_URL!);

export const chat = chatpack({
  storage: drizzleAdapter(db),
  auth: async (req) => getSessionUser(req),
});
```

> The `auth` hook must return `ChatpackUser | null` - an object with at least
> `{ id: string }`, or `null` for unauthenticated requests (`401`). A bare
> string is treated as unauthenticated. Prefer cookie-based sessions -
> `EventSource` (the SSE stream) cannot send custom headers.

## Creating the tables

Chatpack needs eleven tables (`chatpack_conversations`,
`chatpack_conversation_participants`, `chatpack_messages`,
`chatpack_message_search_tokens`, `chatpack_message_reactions`,
`chatpack_conversation_invites`, `chatpack_join_requests`,
`chatpack_user_blocks`, `chatpack_conversation_mutes`,
`chatpack_moderation_reports`, `chatpack_user_bans`). Users are
referenced **by id only** - there is no foreign key into your users table.

> **⚠️ Upgrading an existing database?** Group conversations added `type` and
> `name` columns on `chatpack_conversations`, a `role` column on
> `chatpack_conversation_participants`, made `pair_key` nullable, and **replaced
> the total unique index on `pair_key` with a partial one**
> (`WHERE pair_key IS NOT NULL`) so unlimited null-keyed groups can coexist.
> Reactions and
> quote-replies added the `chatpack_message_reactions` table plus a
> `reply_to_message_id` column on `chatpack_messages`. **Re-run the migration
> before deploying the upgrade.** Every statement is `IF NOT EXISTS` /
> `ADD COLUMN IF NOT EXISTS`, so re-running the whole script is safe and
> preserves your data and `seq` counters. Existing rows need no backfill of their
> own: every pre-group conversation is a DM, which is what the `type` default
> encodes, and the migration promotes their participants to `admin` to match how
> DMs are created now.
>
> Invite links and join requests are gentler: `chatpack_conversation_invites` and
> `chatpack_join_requests` are **pure table additions** - no column changes and no
> index swaps on existing tables - so that part is safe to apply before deploying
> the new code.
>
> Public channels are gentle too: `visibility` and `join_policy` are added to
> `chatpack_conversations` as `NOT NULL` columns with the closed defaults
> (`'private'` / `'approval'`), so every existing conversation is correct without a
> backfill and old code that never selects them keeps working. The migration also
> adds `chatpack_conversations_public_idx`, a **partial** index
> (`WHERE visibility = 'public'`) so the directory query doesn't index every
> private conversation in the database.
>
> Moderation is gentle as well: `chatpack_user_blocks`,
> `chatpack_conversation_mutes`, `chatpack_moderation_reports` and
> `chatpack_user_bans` are **pure table additions** with no changes to existing
> tables, so they are safe to apply before deploying the new code.

**Option A - your `drizzle-kit` flow (recommended).** Re-export the schema and
generate a migration like any other table you own:

```ts
// db/schema.ts
export * from "@chatpack/adapter-drizzle"; // conversations, participants, messages, search tokens, reactions, invites, join requests, moderation
```

```sh
drizzle-kit generate && drizzle-kit migrate
```

**Option B - quick start.** Run the exported idempotent DDL once at boot
(`CREATE TABLE IF NOT EXISTS ...`):

```ts
import { migrationSql } from "@chatpack/adapter-drizzle";
await pool.query(migrationSql); // node-postgres, postgres.js, PGlite
```

If the database already contains messages, rebuild the canonical search token
table once after the migration:

```ts
import { backfillMessageSearchTokens } from "@chatpack/adapter-drizzle";
await backfillMessageSearchTokens(db);
```

Search uses the same case-insensitive, punctuation-separated token contract as
the memory adapter. Results require every query term and rank by term
occurrences, creation time, then message id. Tombstones are excluded.

> **One-statement-per-call drivers** (Neon HTTP, Vercel Postgres, Cloudflare
> D1) reject multi-statement queries - use `migrationStatements` instead,
> which is the same DDL split into individual statements:
>
> ```ts
> import { neon } from "@neondatabase/serverless";
> import { migrationStatements } from "@chatpack/adapter-drizzle";
>
> const sql = neon(process.env.DATABASE_URL!);
> for (const statement of migrationStatements) await sql(statement);
> ```

## Serverless / edge runtimes (Cloudflare Workers, Vercel Edge)

TCP-based drivers like `pg` (node-postgres) don't run on edge runtimes - use
an HTTP/WebSocket driver instead. The adapter itself is driver-agnostic, so
only the `drizzle()` line changes. Neon on Workers:

```ts
import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import { chatpack } from "@chatpack/core";
import { drizzleAdapter } from "@chatpack/adapter-drizzle";

const db = drizzle(neon(env.DATABASE_URL));

export const chat = chatpack({
  storage: drizzleAdapter(db),
  auth: async (req) => getSessionUser(req),
});

export default { fetch: chat.handler().fetch };
```

The same pattern works with `drizzle-orm/vercel-postgres` on Vercel Edge.

> **Real-time on serverless:** the default SSE transport is in-process, so on
> Workers/Lambda-style platforms poll instead of `/stream` -
> [`@chatpack/client`](../client#polling-fallback) falls back automatically. See
> the [deployment reality check](../core#real-time-sse) in `@chatpack/core`.

## Correctness guarantees

The things a chat backend must get right under concurrency, and how this
adapter does them (details in
[ADR 0007](../../docs/decisions/0007-postgres-adapter.md)):

- **Monotonic message ordering** - `seq` is assigned by an atomic
  `UPDATE ... SET last_seq = last_seq + 1 ... RETURNING`; Postgres row locking
  serializes concurrent sends. A unique index on `(conversation_id, seq)`
  enforces the invariant at the schema level too.
- **One conversation per user pair** - DM creation uses
  `ON CONFLICT (pair_key) WHERE pair_key IS NOT NULL DO NOTHING` + re-select
  against the unique `pair_key` index, so concurrent find-or-create calls
  converge. The `WHERE` clause is not optional: the index is partial, and
  Postgres only matches a partial index in `ON CONFLICT` when the statement
  repeats its predicate.
- **Groups are always new, and created atomically** - the conversation row and
  every participant row go in one transaction, so a group with no members can't
  exist. Adding members uses
  `ON CONFLICT (conversation_id, user_id) DO NOTHING` - never `DO UPDATE`, which
  would demote an admin to `member` when someone re-adds them
  ([ADR 0017](../../docs/decisions/0017-group-conversations.md)).
- **Idempotent reactions** - the same shape:
  `ON CONFLICT (message_id, user_id, emoji) DO NOTHING` against a unique index
  on the triple, so five concurrent identical reactions collapse to one row.
  Reacting deliberately issues **no** `UPDATE` on the conversation, so it can't
  advance `last_seq` / `last_activity_at` or reorder the conversation list
  ([ADR 0013](../../docs/decisions/0013-reactions-and-replies.md)).
- **A use cap that actually caps** - `consumeInvite` checks usability and
  increments in one statement
  (`UPDATE ... SET uses = uses + 1 WHERE code = $1 AND (max_uses IS NULL OR uses < max_uses) AND (expires_at IS NULL OR expires_at > now()) RETURNING *`),
  so five simultaneous redemptions of a `maxUses: 1` link admit exactly one
  person. Zero rows back means "spent", which core turns into `410`. Join
  requests are the one place that **does** use `DO UPDATE` - a re-ask has to
  replace a stale denial with a fresh `pending` row
  ([ADR 0019](../../docs/decisions/0019-invites-and-join-requests.md)).
- **Channels reuse that idempotency, and never trust the stored string** - a
  self-join into an `"open"` channel goes through `addParticipants`, so eight
  concurrent joins by one user leave one participant row. The directory query
  filters on `type = 'group' AND visibility = 'public'` (both, so a hand-edited DM
  row can't surface), and reads both columns through a narrowing coercion, so a
  legacy `NULL` or an out-of-union value comes back as `"private"` / `"approval"`
  instead of leaking to clients
  ([ADR 0020](../../docs/decisions/0020-public-channels.md)).
- **One active ban, whoever gets there first** - `createBan` is an
  `INSERT ... SELECT ... WHERE NOT EXISTS (an active ban for this user)`, so two
  moderators banning the same person at the same moment leave exactly one active
  row and both get it back. A read-then-insert would leave a second row that
  keeps enforcing after the visible one is revoked. Blocks and mutes are plain
  `DO NOTHING` upserts, and revoked or expired bans are kept for audit history
  ([ADR 0021](../../docs/decisions/0021-moderation-suite.md)).

## Testing

The integration suite runs the full Chatpack engine against this adapter on
[PGlite](https://pglite.dev) - real Postgres compiled to WASM - so
`pnpm test` needs no Docker or external database, locally or in CI.

## License

[MIT](../../LICENSE)
