# @chatpack/adapter-sqlite

SQLite storage adapter for Chatpack, implemented with Drizzle ORM and
`better-sqlite3`. It provides durable local or single-node persistence while
preserving the full `StorageAdapter` contract.

This adapter requires Node.js 22 or newer because current `better-sqlite3`
releases use the supported Node native-API range.

## Install

```sh
npm  install @chatpack/core @chatpack/adapter-sqlite drizzle-orm better-sqlite3
pnpm add     @chatpack/core @chatpack/adapter-sqlite drizzle-orm better-sqlite3
bun  add     @chatpack/core @chatpack/adapter-sqlite drizzle-orm better-sqlite3
```

## Use

```ts
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { chatpack } from "@chatpack/core";
import { migrationSql, sqliteAdapter } from "@chatpack/adapter-sqlite";

const database = new Database("./chatpack.sqlite");
const db = drizzle(database);
database.exec(migrationSql);

export const chat = chatpack({
  storage: sqliteAdapter(db),
  auth: async (request) => getSessionUser(request),
});
```

`drizzle-orm` and `better-sqlite3` are peer dependencies. The adapter does not
create a database connection or run migrations for you. Apply the exported
`migrationSql` at startup, or run each `migrationStatements` entry with
`db.run(sql.raw(statement))` when your host accepts one statement per call.

SQLite stores dates as millisecond integers, JSON as text, and booleans as
integers. The adapter converts database rows back to real `Date` instances and
plain metadata objects before returning them to Chatpack.

SQLite write concurrency is serialized by SQLite's transaction and locking
model. Use a database-backed adapter with an appropriate deployment topology
for multi-process or multi-region workloads.
