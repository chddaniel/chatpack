# @chatpack/cli

Create a complete Chatpack starter in an empty repository, or add Chatpack to an existing application.

```sh
npx @chatpack/cli init
```

## New starters

Run `init` in an empty repository. Before generation the CLI accepts Git metadata, README, LICENSE, CHANGELOG/CONTRIBUTING-style docs, and editor, CI or OS clutter (`.github/`, `.vscode/`, `.editorconfig`, `.DS_Store`); anything else is reported rather than merged into. It preserves README and LICENSE files. If a README exists, starter instructions go to `CHATPACK_SETUP.md`.

A Next.js starter includes TypeScript, App Router, Tailwind, reviewed shadcn Radix Nova source, a responsive chat UI, Neon Postgres, Drizzle migrations, health and profile routes, and one authentication provider. Its chat client runs in `realtime: { mode: "auto" }`, so it opens the SSE stream and falls back to polling by itself - the same code works on a long-lived server and on Vercel functions:

```sh
npx @chatpack/cli init \
  --framework next \
  --auth-provider better-auth \
  --package-manager pnpm \
  --name my-chat-app \
  --yes
```

Authentication choices are `better-auth`, `authjs`, and `auth0`. Better Auth uses email and password without email verification. Enable verification before public launch. Auth.js uses GitHub OAuth. Auth0 uses Universal Login and synchronizes signed-in profiles.

The UI covers the whole library rather than a demo subset. `/` carries directs, groups and channels with reactions, quote-replies, edit, delete, forward, report, mentions, attachments, typing signals, presence dots, unread counts, members and roles, invites, the join queue, mute and search; `/channels` is the public channel directory, `/invite/[code]` previews and accepts an invite link, and `/moderation` is the report queue, bans and your own blocks. `src/lib/chatpack.server.ts` is the one file that decides anything - permissions, who counts as a moderator, the message-length cap, the file plugin and the transport.

Hono and Express starters are backend-only. They mount the same complete route surface, minus the UI:

```sh
npx @chatpack/cli init --framework hono --package-manager npm --yes
npx @chatpack/cli init --framework express --package-manager bun --yes
```

They include Neon/Drizzle, a health route, and a Vercel entrypoint. Their generic auth resolver fails closed: health works, but Chatpack routes return 401 until the host application implements verified authentication.

The CLI installs exact reviewed dependency versions. It does not run `shadcn@latest` during user setup. The `@chatpack/*` versions come from `src/versions.ts`, which a test keeps equal to the versions in this repo, so a release cannot ship a CLI that generates an app pinned to a package that does not exist yet. Core and `@chatpack/adapter-drizzle` are always pinned as a matched pair: core's required storage contract grows across minors, so a newer core with an older adapter throws at runtime.

Three starter features stay off until an environment variable turns them on, so a fresh clone runs with no extra services. All three are listed, commented out, in the generated `.env.example`. Without `MODERATOR_EMAILS` or `MODERATOR_USER_IDS` nobody passes `moderation.canModerate`, so the report queue answers `NOT_MODERATOR` - reporting and blocking still work for everyone. Without `S3_BUCKET` attachments are written to `.chatpack-files` on local disk, which is fine in development and wrong on serverless, where that filesystem does not outlive one invocation. Without `REDIS_URL` realtime fan-out is in-process, which is correct for exactly one server process and silently lossy for two.

pnpm projects also get a `pnpm-workspace.yaml` that pre-approves the install scripts the starter needs (esbuild, plus sharp and unrs-resolver for Next.js). Without it, pnpm 10+ leaves those builds unapproved and exits non-zero, which the CLI can only report as a failed install. npm, Yarn and Bun projects do not get that file.

## Existing applications

When `package.json` exists, current project detection and integration behavior remains available:

```sh
npx @chatpack/cli init \
  --framework next \
  --adapter drizzle \
  --db-path src/lib/db.ts \
  --db-export db \
  --package-manager pnpm \
  --yes
```

The CLI detects the framework, package manager, language, aliases, existing Chatpack setup, database hints, and authentication hints. Next.js receives a catch-all route. Hono and Express receive focused handler integrations. Use `--client` to generate client wiring.

## Safety

Use `--dry-run` to see exact actions without package installation or file changes. Existing files are never silently overwritten. Starter generation is retry-safe and reports conflicts before mutation.

Generation does not provision Neon or an authentication account. It does not write secrets, run migrations, or deploy. Use the generated `db:generate`, `db:migrate`, and `setup:check` scripts after configuring the environment.

`db:migrate` runs drizzle-kit and then `scripts/filepack-migrate.ts`, which creates the four attachment tables Filepack owns. They are not in `src/db/schema.ts` on purpose - drizzle-kit reads that file through CJS and `@filepack/adapter-drizzle` is ESM-only, so importing it there makes drizzle-kit emit no migration at all while still exiting `0`. Filepack publishes its own idempotent DDL for hosts to apply; `db:filepack` runs just that step, and `db:filepack -- --print` writes the SQL to stdout.

A generated app's `build` script needs its environment variables to be **set**, because `src/lib/env.ts` validates them the first time it is imported. It does not need a reachable database - nothing connects at build time - so a placeholder value is enough in CI.

That same file loads them locally: `.env.local` then `.env` (only `.env` under `NODE_ENV=production`), with real environment variables winning over both. `next dev` already does this for the Next starter, but the hono and express starters run under `tsx`, which reads no env file, and their entrypoint could not do it either - ESM evaluates imports before the importing module's statements, so the validation would throw first.

Starters also ship a `db:proxy` script for developing without a Neon account. The Neon driver speaks Postgres over a WebSocket that Neon's edge terminates, so a plain Postgres has nothing listening for it; `db:proxy` runs a local bridge in front of port 5432 and `NEON_WS_PROXY` points the driver at it. Leave that variable unset and the code path never runs. The generated README has the commands, including why migrations need `psql` in that mode.

The generated chat UI is application-owned source. It is not a reusable `@chatpack/ui` package.

## Community

- **[Discord](https://discord.gg/gY3GCTRv5Y)** — chat with the team and other developers
- **[X](https://x.com/chatpackdev)** — releases and updates
- **[Docs](https://docs.chatpack.dev)** — the full documentation site
- **[GitHub Discussions](https://github.com/chddaniel/chatpack/discussions)** — questions, show-and-tell, and feedback

## License

[MIT](./LICENSE). The bundled TypeScript compiler is distributed under the [Apache License 2.0](./LICENSE.typescript).
