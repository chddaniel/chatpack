# @chatpack/cli

Create a complete Chatpack starter in an empty repository, or add Chatpack to an existing application.

```sh
npx @chatpack/cli init
```

## New starters

Run `init` in an empty repository. Before generation the CLI accepts Git metadata, README, LICENSE, CHANGELOG/CONTRIBUTING-style docs, and editor, CI or OS clutter (`.github/`, `.vscode/`, `.editorconfig`, `.DS_Store`); anything else is reported rather than merged into. It preserves README and LICENSE files. If a README exists, starter instructions go to `CHATPACK_SETUP.md`.

A Next.js starter includes TypeScript, App Router, Tailwind, reviewed shadcn Radix Nova source, a responsive direct-message UI, Neon Postgres, Drizzle migrations, health and profile routes, and one authentication provider. Its chat client runs in `realtime: { mode: "auto" }`, so it opens the SSE stream and falls back to polling by itself - the same code works on a long-lived server and on Vercel functions:

```sh
npx @chatpack/cli init \
  --framework next \
  --auth-provider better-auth \
  --package-manager pnpm \
  --name my-chat-app \
  --yes
```

Authentication choices are `better-auth`, `authjs`, and `auth0`. Better Auth uses email and password without email verification. Enable verification before public launch. Auth.js uses GitHub OAuth. Auth0 uses Universal Login and synchronizes signed-in profiles.

Hono and Express starters are backend-only:

```sh
npx @chatpack/cli init --framework hono --package-manager npm --yes
npx @chatpack/cli init --framework express --package-manager bun --yes
```

They include Neon/Drizzle, a health route, and a Vercel entrypoint. Their generic auth resolver fails closed: health works, but Chatpack routes return 401 until the host application implements verified authentication.

The CLI installs exact reviewed dependency versions. It does not run `shadcn@latest` during user setup. The `@chatpack/*` versions come from `src/versions.ts`, which a test keeps equal to the versions in this repo, so a release cannot ship a CLI that generates an app pinned to a package that does not exist yet. Core and `@chatpack/adapter-drizzle` are always pinned as a matched pair: core's required storage contract grows across minors, so a newer core with an older adapter throws at runtime.

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

A generated app's `build` script needs its environment variables to be **set**, because `src/lib/env.ts` validates them the first time it is imported. It does not need a reachable database - nothing connects at build time - so a placeholder value is enough in CI.

Starters also ship a `db:proxy` script for developing without a Neon account. The Neon driver speaks Postgres over a WebSocket that Neon's edge terminates, so a plain Postgres has nothing listening for it; `db:proxy` runs a local bridge in front of port 5432 and `NEON_WS_PROXY` points the driver at it. Leave that variable unset and the code path never runs. The generated README has the commands, including why migrations need `psql` in that mode.

The generated chat UI is application-owned source. It is not a reusable `@chatpack/ui` package.

## Community

- **[Discord](https://discord.gg/gY3GCTRv5Y)** — chat with the team and other developers
- **[X](https://x.com/chatpackdev)** — releases and updates
- **[Docs](https://docs.chatpack.dev)** — the full documentation site
- **[GitHub Discussions](https://github.com/chddaniel/chatpack/discussions)** — questions, show-and-tell, and feedback

## License

[MIT](./LICENSE). The bundled TypeScript compiler is distributed under the [Apache License 2.0](./LICENSE.typescript).
