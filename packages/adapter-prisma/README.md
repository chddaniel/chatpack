# @chatpack/adapter-prisma

First-party Chatpack storage adapter for Prisma ORM 7 and PostgreSQL. It
implements conversations, messages, search, reactions, mentions, replies,
forwarding, read state, invites, public channels, and moderation.

## Install

```sh
pnpm add @chatpack/core @chatpack/adapter-prisma @prisma/client @prisma/adapter-pg pg
pnpm add -D prisma
```

Prisma ORM 7 requires Node.js 20.19 or newer. Prisma 8 is the current Prisma
release, but it uses a different contract/query client and is not supported by
this adapter. Prisma 7 is the supported generated-client API.

## Schema and migrations

Copy the models from [`prisma/schema.prisma`](./prisma/schema.prisma) into your
application schema. Keep your own datasource and generator configuration. With
Prisma 7, put the database URL in `prisma.config.ts`:

```ts
import { defineConfig, env } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  datasource: { url: env("DATABASE_URL") },
});
```

Copy this package's `prisma/migrations/0001_chatpack/migration.sql` into your
application migrations directory. Then run `prisma format`, `prisma validate`,
`prisma migrate deploy`, and `prisma generate`. The migration is PostgreSQL
DDL and creates twelve `chatpack_*` tables. It never creates or references an
application-owned users table. For an existing Chatpack database, inspect the
current schema and write an explicit migration; `CREATE TABLE IF NOT EXISTS`
does not alter incompatible tables.

## Server-only setup

Create the Prisma client in trusted server code. The adapter accepts that
caller-created client and never reads credentials, creates a pool, or owns the
client lifecycle.

```ts
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./generated/client/client.js";
import { chatpack } from "@chatpack/core";
import { prismaAdapter } from "@chatpack/adapter-prisma";

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
});

export const chat = chatpack({
  storage: prismaAdapter(prisma),
  auth: resolveAppUser,
});
```

Never import this adapter, Prisma client, connection string, or database
credentials into browser code. Generate the client from the consumer's schema;
this package does not bundle a replacement generated client.

## Correctness boundary

Conversation pair uniqueness and message `(conversation_id, seq)` uniqueness
are database-enforced. Group creation and message sequence allocation use
interactive transactions. Sequence allocation increments the conversation row
under PostgreSQL row locking at `ReadCommitted`, then inserts the message in
the same transaction. Serializable transactions retry bounded `P2034` and
`40001` conflicts. Invite use caps use one parameterized conditional
`UPDATE ... RETURNING`; active bans serialize with a PostgreSQL transaction
advisory lock because Prisma schemas cannot express a time-dependent partial
unique index.

Run `backfillMessageSearchTokens(prisma)` after importing messages from a
database that predates the search-token table or has incomplete tokens.

## Support

Verified support is Prisma ORM 7.10.0 with `@prisma/adapter-pg` 7.10.0 and
PostgreSQL 16. The adapter does not claim MySQL, SQLite, CockroachDB, SQL
Server, MongoDB, Prisma 8, Accelerate, serverless drivers, edge runtimes, or
other Prisma versions. Test those combinations separately before use.
