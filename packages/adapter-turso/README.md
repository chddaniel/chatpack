# @chatpack/adapter-turso

Drizzle ORM storage adapter for Chatpack backed by Turso/libSQL.

```sh
pnpm add @chatpack/core @chatpack/adapter-turso @libsql/client drizzle-orm
```

```ts
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { chatpack } from "@chatpack/core";
import { migrationStatements, tursoAdapter } from "@chatpack/adapter-turso";

const client = createClient({
  url: process.env.TURSO_DATABASE_URL!,
  authToken: process.env.TURSO_AUTH_TOKEN!,
});
for (const statement of migrationStatements) await client.execute(statement);

const chat = chatpack({
  storage: tursoAdapter(drizzle({ client })),
  auth,
});
```

Migration statements are safe to run repeatedly. The package also exports
migrationSql for clients that support multi-statement SQL.

The adapter uses async Drizzle/libSQL transactions for atomic message
sequencing, direct-conversation creation, mention replacement, invite
consumption, and moderation writes.
