---
"@chatpack/cli": minor
---

Add empty-repository Next.js, Hono, and Express starters with Neon, Drizzle, authentication choices, production setup checks, and application-owned chat UI source.

The starters cover the whole library rather than a demo subset. The Next.js app carries directs, groups and public channels, reactions, quote-replies, edits, soft deletes, mentions, forwarding, search, attachments, typing/presence/receipts, unread counts, roles and member management, invite links, join requests, mutes, blocks and the moderation queue across `/`, `/channels`, `/invite/[code]` and `/moderation`. The Hono and Express starters mount the same route surface without UI.

Three features are environment-gated so a fresh clone runs with no extra services: attachments write to `.chatpack-files` on local disk until `S3_BUCKET` is set, realtime fan-out is in-process until `REDIS_URL` is set, and nobody passes `moderation.canModerate` until `MODERATOR_EMAILS` or `MODERATOR_USER_IDS` is set. All three are listed, commented out, in `.env.example` and warned about after generation.

Starters pin `@chatpack/*` from a release-guarded version table, pre-approve the install scripts pnpm needs, and ship an opt-in `db:proxy` bridge so a generated app can run against a local Postgres without a Neon account. `db:migrate` is drizzle-kit followed by `scripts/filepack-migrate.ts`, which applies the four attachment tables Filepack owns and deliberately keeps out of drizzle-kit's schema, and `src/lib/env.ts` reads `.env.local` then `.env` itself, so the backend starters boot from the file their README asks for even though nothing else in a `tsx` process reads one.
