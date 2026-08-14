# ADR 0023: Dual-mode init and host-owned user validation

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

- Next.js: application-owned direct-message UI, Neon/Drizzle, and Better Auth, Auth.js, or Auth0.
- Hono and Express: Neon/Drizzle backends with fail-closed host authentication.
- Web-standard: existing-project mode only.

Templates are reviewed assets published with the CLI. They pin compatible dependencies and do not execute a floating UI generator. Generation does not provision accounts, write secrets, run migrations, or deploy.

The production starter database uses the transaction-capable Neon WebSocket Pool with `drizzle-orm/neon-serverless`. The Neon HTTP driver is excluded because current Chatpack mutations use database transactions.

Core accepts an optional `userExists(userId)` hook. It validates new direct-message targets, initial group members, and newly added participants. A missing target returns `USER_NOT_FOUND`. Omitting the hook preserves previous behavior. The acting user continues to come from the authentication hook and is not revalidated.

## Consequences

- A new repository can become a complete, editable chat application with one command.
- Existing-project automation and safety rules stay compatible.
- Generated UI remains application source. Chatpack does not gain a reusable UI package.
- Host applications can prevent phantom conversation participants without giving Chatpack ownership of identity data.
- User validation can add identity-store queries. Hosts must make the hook efficient and reliable.
- External account creation, secret management, migrations, and deployment remain explicit operator steps.
