# Contributing to Chatpack

Thanks for your interest in contributing! This document covers everything you
need to get productive in the repo.

## Repo layout

```
chatpack/
├── docs/                  # Project docs: vision, MVP scope, architecture, ADRs
│   └── decisions/         # Short ADRs — one file per non-obvious decision
├── packages/
│   ├── core/              # @chatpack/core — the chat engine + HTTP handler
│   ├── adapter-drizzle/   # @chatpack/adapter-drizzle — Drizzle/Postgres storage
│   ├── adapter-memory/    # @chatpack/adapter-memory — in-memory storage
│   └── next/              # @chatpack/next — Next.js App Router integration
├── examples/
│   └── node-server/       # Curl-able demo server (plain Node)
└── .github/workflows/     # CI
```

This is a **pnpm workspace** monorepo orchestrated with **Turborepo**.

## Prerequisites

- Node.js >= 18
- [pnpm](https://pnpm.io) >= 9

## Getting started

```sh
git clone https://github.com/chddaniel/chatpack.git
cd chatpack
pnpm install
pnpm build
pnpm test
```

## Common commands

| Command          | What it does                                |
| ---------------- | ------------------------------------------- |
| `pnpm build`     | Build all packages (tsup, ESM + CJS + d.ts) |
| `pnpm test`      | Run all tests (Vitest)                      |
| `pnpm typecheck` | Typecheck all packages                      |
| `pnpm lint`      | Lint all packages (ESLint)                  |
| `pnpm format`    | Format with Prettier                        |

To scope a command to one package:

```sh
pnpm --filter @chatpack/core test
```

## Architecture in 30 seconds

Two interfaces carry the whole design (see [docs/MVP.md](./docs/MVP.md) §6):

- **`StorageAdapter`** — durable reads/writes (conversations, messages,
  read-state). Core depends on the interface, never on a specific database.
- **`Transport`** — publish/subscribe of live message events to connected SSE
  clients. The engine publishes only _after_ the storage write succeeds
  (durable-first); v0 ships a single-node in-process transport, and the SSE
  endpoint recovers missed messages on reconnect from storage via
  `Last-Event-ID` (see [ADR 0006](./docs/decisions/0006-sse-gap-fill.md)).

The core engine (`@chatpack/core`) contains all domain logic: 1:1
conversations, permission checks, validation. Adapters contain **no** domain
logic — they only persist and retrieve.

### Writing a storage adapter

Implement the `StorageAdapter` interface exported from `@chatpack/core`. The
in-memory adapter ([packages/adapter-memory](./packages/adapter-memory)) is the
reference implementation and the easiest place to start reading; the Drizzle
adapter ([packages/adapter-drizzle](./packages/adapter-drizzle)) shows what the
contract looks like on a real database (atomic `seq` assignment, idempotent
pair-key creation — see [ADR 0007](./docs/decisions/0007-postgres-adapter.md)).

Rules of thumb:

- Adapters never enforce permissions — core does that before calling you.
- `getOrCreateDirectConversation` must be idempotent per user pair (core hands
  you a deterministic `pairKey`) — including under concurrency.
- `addMessage` must assign a strictly increasing per-conversation `seq` —
  including under concurrency.
- Message listing is **newest-first** with cursor pagination.

## Code style

- Strict TypeScript. No `any` in the public API.
- **No default exports** in public APIs (enforced by ESLint).
- Every exported symbol gets a TSDoc comment — docs are generated from source.
- Prettier formats everything; CI checks it.

## Documentation

Docs are a first-class deliverable:

- Public-API changes must update TSDoc and, if user-facing, the README.
- Non-obvious design decisions get a short ADR in `docs/decisions/`
  (copy the format of an existing one).

## Tests

- Vitest everywhere.
- Core is tested against the in-memory adapter — fast and deterministic.
- The Drizzle adapter is tested against **real Postgres via PGlite** (Postgres
  in WASM) — `pnpm test` needs no Docker or database setup.
- New features need tests; bug fixes need a regression test.

## Submitting changes

1. Fork and create a topic branch.
2. Make your change (+ tests + docs).
3. Add a changeset if you touched a published package: `pnpm changeset`.
4. Open a PR. CI runs typecheck, lint, tests, and build.

## Releases

We use [Changesets](https://github.com/changesets/changesets). Everything is
`0.x` until the public API stabilizes.

## Code of conduct

Be kind. See [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md).
