# @chatpack/adapter-drizzle

Drizzle ORM (Postgres) storage adapter for Chatpack — real persistence for
production. Works with any Drizzle Postgres driver: node-postgres,
postgres.js, PGlite, Neon, Vercel Postgres.

> Part of [Chatpack](https://github.com/chddaniel/chatpack) — open-source chat
> infrastructure for developers.

## Install

```sh
# pick your package manager
npm  install @chatpack/core @chatpack/adapter-drizzle drizzle-orm pg
pnpm add     @chatpack/core @chatpack/adapter-drizzle drizzle-orm pg
bun  add     @chatpack/core @chatpack/adapter-drizzle drizzle-orm pg
```

`drizzle-orm` is a peer dependency — the adapter plugs into the Drizzle
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

> The `auth` hook must return `ChatpackUser | null` — an object with at least
> `{ id: string }`, or `null` for unauthenticated requests (`401`). A bare
> string is treated as unauthenticated.

## Creating the tables

Chatpack needs three tables (`chatpack_conversations`,
`chatpack_conversation_participants`, `chatpack_messages`). Users are
referenced **by id only** — there is no foreign key into your users table.

**Option A — your `drizzle-kit` flow (recommended).** Re-export the schema and
generate a migration like any other table you own:

```ts
// db/schema.ts
export * from "@chatpack/adapter-drizzle"; // conversations, participants, messages
```

```sh
drizzle-kit generate && drizzle-kit migrate
```

**Option B — quick start.** Run the exported idempotent DDL once at boot:

```ts
import { migrationSql } from "@chatpack/adapter-drizzle";
await pool.query(migrationSql); // CREATE TABLE IF NOT EXISTS ...
```

## Correctness guarantees

The two things a chat backend must get right under concurrency, and how this
adapter does them (details in
[ADR 0007](../../docs/decisions/0007-postgres-adapter.md)):

- **Monotonic message ordering** — `seq` is assigned by an atomic
  `UPDATE ... SET last_seq = last_seq + 1 ... RETURNING`; Postgres row locking
  serializes concurrent sends. A unique index on `(conversation_id, seq)`
  enforces the invariant at the schema level too.
- **One conversation per user pair** — creation uses
  `ON CONFLICT (pair_key) DO NOTHING` + re-select against the unique
  `pair_key` index, so concurrent find-or-create calls converge.

## Testing

The integration suite runs the full Chatpack engine against this adapter on
[PGlite](https://pglite.dev) — real Postgres compiled to WASM — so
`pnpm test` needs no Docker or external database, locally or in CI.

## License

[MIT](../../LICENSE)
