# @chatpack/adapter-mysql

First-party Chatpack storage adapter for MySQL 8 using Drizzle ORM and
`mysql2`. It implements conversations, messages, search, reactions, mentions,
replies, forwarding, read state, invites, public channels, and moderation.

## Install

```sh
pnpm add @chatpack/core @chatpack/adapter-mysql drizzle-orm mysql2
```

## Use

Create the database client in your server application. The adapter never reads
database credentials and must not be imported into browser code.

```ts
import mysql from "mysql2/promise";
import { drizzle } from "drizzle-orm/mysql2";
import { chatpack } from "@chatpack/core";
import { migrationStatements, mysqlAdapter } from "@chatpack/adapter-mysql";

const pool = mysql.createPool(process.env.DATABASE_URL!);
for (const statement of migrationStatements) await pool.query(statement);

export const chat = chatpack({
  storage: mysqlAdapter(drizzle(pool)),
  auth: async (request) => getSessionUser(request),
});
```

Use a transaction-capable server-side `mysql2` connection or pool. Message
sequence allocation locks its conversation row until transaction commit.
Connection pools must preserve one connection for each Drizzle transaction.

## Support boundary

This package targets MySQL 8 with Drizzle's `mysql2` driver. The repository's
verification covers that combination only. MariaDB, PlanetScale, Aurora,
serverless/HTTP MySQL drivers, replicas, and edge runtimes are not claimed
compatible by this package. Verify those environments separately before use.

The migration uses a binary UTF-8 collation so opaque IDs stay exact. MySQL's
nullable unique `pair_key` permits many `NULL` values, so groups can
always be distinct while non-NULL direct-conversation keys converge. Dates use
`DATETIME(3)` and are converted to real `Date` objects. Metadata and moderation
evidence use MySQL JSON columns.

## Migrations and backfill

`chatpackSchema`, each table, `migrationSql`, and `migrationStatements` are
exported. The statements create all twelve Chatpack tables and include indexes
inside `CREATE TABLE IF NOT EXISTS`, making reruns safe for a compatible schema.
They do not alter or validate an incompatible existing table; inspect and
migrate such a schema explicitly. Run `backfillMessageSearchTokens(drizzle(pool))`
after importing messages into a database that predates search tokens.

The adapter requires transactions for group creation, message sequence
allocation, invite consumption, mention replacement, and moderation ban
serialization. Run migrations before serving requests.
