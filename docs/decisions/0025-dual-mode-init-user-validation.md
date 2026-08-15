# ADR 0025: Dual-mode init and host-owned user validation

- **Status:** accepted
- **Date:** 2026-08-13
- **Milestone:** v1.next (starter templates)

## Context

The original `chatpack init` adds focused wiring to an application that already has a package manifest. A new user still has to choose a framework, database driver, authentication provider, deployment model, and UI before the first production-shaped chat works.

Chatpack stores host user ids but does not own a users table. Before this decision, core could accept a direct-message target or group member id that did not exist in the host identity system.

## Decision

`chatpack init` has two modes.

When `package.json` exists, it keeps the existing-project behavior. When no package manifest exists, the requested directory is a starter target. Only Git metadata, `.gitignore`, README, and LICENSE files are allowed before generation. README and LICENSE files are preserved.

Starter targets are:

- Next.js: application-owned UI, Neon/Drizzle, and Better Auth, Auth.js, or Auth0.
- Hono and Express: Neon/Drizzle backends with fail-closed host authentication.
- Web-standard: existing-project mode only.

Templates are reviewed assets published with the CLI. They pin compatible dependencies and do not execute a floating UI generator. Generation does not provision accounts, write secrets, run migrations, or deploy.

A starter covers **every** Chatpack feature, not the subset a demo needs. The first version shipped directs and send/list only, and readers reasonably concluded the rest of the library did not exist - a starter that omits a feature is an argument that the feature is not ready. So the Next.js starter carries directs, groups and public channels, reactions, quote-replies, edits, soft deletes, mentions, forwarding, search, attachments, typing/presence/receipts, unread counts, roles and member management, invite links, join requests, mutes, blocks and the moderation queue, across `/`, `/channels`, `/invite/[code]` and `/moderation`; the Hono and Express starters mount the same route surface without UI. `packages/cli/test/starter.test.ts` asserts one call site per feature, so deleting one fails CI rather than quietly shrinking what the starter teaches.

Three of those features need an external resource, and a starter has to run on a fresh clone with none of them. They are therefore **environment-gated, defaulting to the local option**: attachments write to `.chatpack-files` on disk until `S3_BUCKET` is set, realtime fan-out is in-process until `REDIS_URL` is set, and nobody passes `moderation.canModerate` until `MODERATOR_EMAILS` or `MODERATOR_USER_IDS` is set. All three are listed, commented out, in `.env.example` and warned about after generation. None of them go in `src/lib/env.ts`, which throws on a missing value at import time - putting an optional variable there would break the first `dev`.

The `@chatpack/*` versions a starter installs are **not literals in the template manifests**. Template `package.json` files carry `{{CHATPACK_CORE_VERSION}}`-style tokens, and `packages/cli/src/versions.ts` is the single place those resolve from. A test asserts each constant equals the corresponding workspace `package.json` version, so a Changesets release that bumps core without bumping the constant fails CI instead of publishing a CLI that generates an uninstallable app.

Core and `@chatpack/adapter-drizzle` must be pinned as a matched pair. The required `StorageAdapter` contract grows across minors (19 methods at 0.11, 21 with mentions), so a core newer than its adapter does not merely go untested - it throws at runtime.

The production starter database uses the transaction-capable Neon WebSocket Pool with `drizzle-orm/neon-serverless`. The Neon HTTP driver is excluded because current Chatpack mutations use database transactions.

Core accepts an optional `userExists(userId)` hook. It validates new direct-message targets, initial group members, and newly added participants. A missing target returns `USER_NOT_FOUND`, mapped to HTTP 404. Omitting the hook preserves previous behavior. The acting user continues to come from the authentication hook and is not revalidated.

The hook takes one id at a time, and core calls it in **bounded batches of eight** rather than one id after another. Creating a fifty-member group therefore costs a handful of round trips instead of fifty, while a 256-member group still cannot open 256 simultaneous queries against a host pool that is usually much smaller. The batch size is deliberately not configurable: a host that wants a single query for many ids should batch inside its own hook. The error always names the first missing id in request order, never the first query to settle, so the same request always produces the same error. Ids the caller repeats, and the acting user's own id, are never asked about twice.

## Consequences

- A new repository can become a complete, editable chat application with one command, and that application demonstrates the whole library.
- The starter is now a second consumer of every public API, so a breaking change to one shows up as a failing starter test. That is the point, and it is also a maintenance cost: the templates have to move with the API.
- Existing-project automation and safety rules stay compatible.
- Generated UI remains application source. Chatpack does not gain a reusable UI package.
- Host applications can prevent phantom conversation participants without giving Chatpack ownership of identity data.
- User validation adds identity-store queries on conversation and membership writes. Hosts must make the hook reliable; core bounds how hard it hits them but cannot make a slow query fast.
- Every release must keep `packages/cli/src/versions.ts` in step with the packages it pins. The test is the enforcement, and it is the only thing standing between a release and a starter that cannot install.
- External account creation, secret management, migrations, and deployment remain explicit operator steps.
