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

Chatpack needs four tables (`chatpack_conversations`,
`chatpack_conversation_participants`, `chatpack_messages`,
`chatpack_message_reactions`). Users are referenced **by id only** - there is no
foreign key into your users table.

> **⚠️ Upgrading an existing database?** Reactions and quote-replies added the
> `chatpack_message_reactions` table plus a `reply_to_message_id` column on
> `chatpack_messages`. **Re-run the migration before deploying the upgrade.**
> Every statement is `IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS`, so re-running
> the whole script is safe and preserves your data and `seq` counters.

**Option A - your `drizzle-kit` flow (recommended).** Re-export the schema and
generate a migration like any other table you own:

```ts
// db/schema.ts
export * from "@chatpack/adapter-drizzle"; // conversations, participants, messages, reactions
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
- **One conversation per user pair** - creation uses
  `ON CONFLICT (pair_key) DO NOTHING` + re-select against the unique
  `pair_key` index, so concurrent find-or-create calls converge.
- **Idempotent reactions** - the same shape:
  `ON CONFLICT (message_id, user_id, emoji) DO NOTHING` against a unique index
  on the triple, so five concurrent identical reactions collapse to one row.
  Reacting deliberately issues **no** `UPDATE` on the conversation, so it can't
  advance `last_seq` / `last_activity_at` or reorder the conversation list
  ([ADR 0013](../../docs/decisions/0013-reactions-and-replies.md)).

## Testing

The integration suite runs the full Chatpack engine against this adapter on
[PGlite](https://pglite.dev) - real Postgres compiled to WASM - so
`pnpm test` needs no Docker or external database, locally or in CI.

## License

[MIT](../../LICENSE)
