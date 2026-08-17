# @chatpack/cli

## 0.3.0

### Minor Changes

- df5bed6: Add empty-repository Next.js, Hono, and Express starters with Neon, Drizzle, authentication choices, production setup checks, and application-owned chat UI source.

  The starters cover the whole library rather than a demo subset. The Next.js app carries directs, groups and public channels, reactions, quote-replies, edits, soft deletes, mentions, forwarding, search, attachments, typing/presence/receipts, unread counts, roles and member management, invite links, join requests, mutes, blocks and the moderation queue across `/`, `/channels`, `/invite/[code]` and `/moderation`. The Hono and Express starters mount the same route surface without UI.

  Three features are environment-gated so a fresh clone runs with no extra services: attachments write to `.chatpack-files` on local disk until `S3_BUCKET` is set, realtime fan-out is in-process until `REDIS_URL` is set, and nobody passes `moderation.canModerate` until `MODERATOR_EMAILS` or `MODERATOR_USER_IDS` is set. All three are listed, commented out, in `.env.example` and warned about after generation.

  Starters pin `@chatpack/*` from a release-guarded version table, pre-approve the install scripts pnpm needs, and ship an opt-in `db:proxy` bridge so a generated app can run against a local Postgres without a Neon account. `db:migrate` is drizzle-kit followed by `scripts/filepack-migrate.ts`, which applies the four attachment tables Filepack owns and deliberately keeps out of drizzle-kit's schema, and `src/lib/env.ts` reads `.env.local` then `.env` itself, so the backend starters boot from the file their README asks for even though nothing else in a `tsx` process reads one.

## 0.2.3

### Patch Changes

- 5d6f1c8: Add the community links (Discord, X, docs, Discussions) to every package README and to
  `llms.txt`, so the fastest way to reach the maintainers is on the npm page of whichever
  package you installed. No code changes.

## 0.2.2

### Patch Changes

- Credit the project's co-owners by name rather than GitHub handle in package
  `contributors` metadata and the credits surfaces: DanielCH and DavidCH.

## 0.2.1

### Patch Changes

- Fill in the `author` and `contributors` metadata, which was empty on every
  published package. Yeabsra Habtu is credited as author (principal author of the
  library), with chddaniel, Ikem Peter and chhddavid as contributors. Registry
  maintainers and publish rights are unchanged. No runtime or API changes —
  package metadata only, so authorship shows up on npm and in registry mirrors.

## 0.2.0

### Minor Changes

- db082b7: Add participant-scoped message search actions and React hooks to the client.

  Bundle TypeScript in the CLI and refresh generated clients for the current Chatpack API. The
  compiler bundle raises the package tarball from about 93 KB to 2.1 MB while avoiding the roughly
  40 MB TypeScript runtime install.

## 0.1.0

### Minor Changes

- 21a6d35: Add the initial `chatpack init` CLI for safe Chatpack setup in Next.js, Hono,
  and Express projects.
