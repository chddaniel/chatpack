# ADR 0028: Prisma PostgreSQL storage adapter

## Status

Accepted for `@chatpack/adapter-prisma`.

## Decision

Ship a server-only first-party adapter for Prisma ORM 7's generated client API
and PostgreSQL. Support starts at Prisma 7 because Prisma 7 requires a caller
configured driver adapter and generated output path. Prisma 8 is not included:
its contract/query client is a different API and needs a separate adapter
design. Verified combination is Prisma 7.10.0, `@prisma/adapter-pg` 7.10.0,
and PostgreSQL 16.

The adapter accepts `prismaAdapter(client)`. The application creates,
configures, migrates, disconnects, and credentials-protects the client. User
ids remain opaque strings and Chatpack models map to the existing `chatpack_*`
tables without foreign keys to application users.

## Transactions and concurrency

Group creation inserts the conversation and initial participants in one
interactive transaction. Message writes increment `last_seq` and insert the
message in one transaction. PostgreSQL row locking makes the increment
strictly increasing; the unique `(conversation_id, seq)` index is a second
database guard. Sequence writes use `ReadCommitted`; other compound writes use
serializable transactions with bounded retry for Prisma `P2034` and PostgreSQL
serialization code `40001`.

Invite consumption uses a parameterized conditional `UPDATE ... RETURNING`
because Prisma model filters cannot compare `uses` with `max_uses`. Active bans
use `pg_advisory_xact_lock(hashtextextended(user_id, ...))`, then check and
insert inside the same transaction. A time-dependent PostgreSQL partial unique
index is not valid because index predicates must be immutable.

## Schema installation

Consumers copy the package Prisma models into their schema, run Prisma 7
format/validate/generate, and apply the supplied SQL through `prisma migrate
deploy`. The package does not generate or bundle a consumer client. Existing
incompatible tables require a consumer-authored migration.

## Consequences

The adapter provides the full current required contract and optional search,
invite, channel, and moderation capabilities. PostgreSQL is the only verified
provider. CLI generation and other providers remain separate follow-up work.
