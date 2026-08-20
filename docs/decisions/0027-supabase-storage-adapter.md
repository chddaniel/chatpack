# ADR 0027: Supabase storage adapter

- **Status:** accepted
- **Date:** 2026-08-20
- **Milestone:** v1.next

## Context

Supabase exposes Postgres through PostgREST and `supabase-js`, but that client
does not provide the transaction and row-lock semantics required by
`StorageAdapter`. A Drizzle adapter also cannot accept a Supabase client
without a direct connection string.

## Decision

Ship `@chatpack/adapter-supabase` as a first-party, server-only adapter. It
accepts an already-created privileged Supabase client and uses ordinary
PostgREST calls for simple reads and writes. Operations that need atomicity,
sequence allocation, conflict updates, or database-side pagination use SQL
RPCs in `supabase/migrations/0001_chatpack.sql`.

The migration follows the Drizzle table contract, is safe to re-apply to an
existing Chatpack schema, enables RLS on every `chatpack_` table, and grants
table/RPC access only to `service_role`. Chatpack core remains responsible for
application permissions; RLS is the database boundary that prevents public
Data API access.

Batch hydration also uses RPC request bodies rather than large PostgREST
`in (...)` URL filters. New Chatpack tables and functions are discovered by
prefix in the migration's privilege loop so the server-only boundary stays
consistent as the schema grows.

## Consequences

- Supabase users get a supported adapter instead of a custom-adapter fork.
- The service-role key must remain in trusted server infrastructure.
- Supabase migration changes must preserve the shared `StorageAdapter`
  contract and be tested against an isolated project as well as deterministic
  adapter tests.
- Host applications own Supabase project migrations and must apply the
  Chatpack migration before starting the adapter.
