# ADR 0001 — Storage is an interface; core never touches a database

- Status: accepted
- Date: 2026-07-22

## Context

Chatpack must work with whatever database a developer already runs (Postgres,
MySQL, SQLite, ...), and its core domain logic must be testable without any
database at all. BetterAuth's adapter pattern proved this shape works for
infrastructure libraries.

## Decision

`@chatpack/core` depends only on the `StorageAdapter` interface
(`packages/core/src/storage.ts`). Concrete persistence lives in separate
adapter packages (`@chatpack/adapter-memory` now, `@chatpack/adapter-drizzle`
in M4).

Division of responsibility:

- **Core** owns all domain rules: validation, permissions, "only the sender
  can edit", pair-key computation, telemetry counting.
- **Adapters** own persistence mechanics only: uniqueness on `pairKey`,
  monotonic `seq` assignment, cursor pagination. They never enforce
  permissions.

## Consequences

- Core tests run against the in-memory adapter — fast and deterministic.
- Community adapters (Prisma, MySQL, ...) need no changes to core.
- The interface is part of the public API: changes to it are breaking changes
  and go through changesets like any other public-surface change.
