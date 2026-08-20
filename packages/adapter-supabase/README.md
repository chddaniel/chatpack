# @chatpack/adapter-supabase

Server-side Supabase storage for Chatpack. It uses the Supabase PostgREST client
for reads and ordinary writes, and PostgreSQL RPCs for operations that need one
transaction or one row lock.

## Install

```sh
pnpm add @chatpack/core @chatpack/adapter-supabase @supabase/supabase-js
```

Apply [`supabase/migrations/0001_chatpack.sql`](./supabase/migrations/0001_chatpack.sql)
with the Supabase CLI:

```sh
supabase link --project-ref "$SUPABASE_PROJECT_REF"
supabase db push
```

Or run the SQL file in Supabase SQL Editor. Run it before starting Chatpack.
The adapter does not apply migrations automatically. If the migration is kept
inside a package workspace, run the CLI from that directory or copy the file
into the Supabase project's migration directory first.

## Server-only setup

Create one privileged client in server code. Do not use a browser client, do
not expose the service-role/server-secret key, and do not bundle this package
into client code. Disable session persistence so a user session cannot replace
the privileged client credentials.

```ts
import { createClient } from "@supabase/supabase-js";
import { chatpack } from "@chatpack/core";
import { supabaseAdapter } from "@chatpack/adapter-supabase";

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
});

export const chat = chatpack({
  storage: supabaseAdapter(supabase),
  auth: resolveAppUser,
});
```

The migration enables Row Level Security on every Chatpack table and creates
no public policies. Supabase service-role keys bypass RLS, so keep them only in
trusted server infrastructure. The migration also grants table and RPC access
only to `service_role`, which is required for server-side PostgREST access on
new Supabase projects. Chatpack core still owns application permission checks;
RLS is a second boundary against accidental public table access.

## Capabilities

This adapter implements the complete current `StorageAdapter` contract,
participant-scoped search, invite links and join requests, public channels,
and durable moderation. Direct conversation creation, group creation, message
sequence allocation, message search-token maintenance, mention replacement,
invite consumption, and active-ban creation use migration-provided RPCs.

The default tests are deterministic and do not require a hosted Supabase
project. An external integration suite can use `SUPABASE_URL` and
`SUPABASE_SERVICE_ROLE_KEY` against an isolated test project. Never point such
a suite at production data.

## Source layout

- `src/index.ts` contains the public adapter and StorageAdapter method wiring.
- `src/types.ts` contains table names, RPC names, and database row contracts.
- `src/utils.ts` contains conversion-safe dates, cursors, IDs, token rows, and
  Supabase error guards.
- `src/converters.ts` maps database rows to Chatpack domain values.
- `supabase/migrations/0001_chatpack.sql` owns schema, indexes, RLS, and the
  transaction-sensitive RPCs.

The exported API is intentionally small: `supabaseAdapter(client, options?)`
and `SupabaseAdapterOptions`. The remaining modules are implementation details.
