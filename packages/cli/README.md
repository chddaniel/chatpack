# @chatpack/cli

Create a complete Chatpack starter in an empty repository, or add Chatpack to an existing application.

```sh
npx @chatpack/cli init
```

## New starters

Run `init` in an empty repository. The CLI accepts only `.git`, `.gitignore`, README, and LICENSE files before generation. It preserves README and LICENSE files. If a README exists, starter instructions go to `CHATPACK_SETUP.md`.

A Next.js starter includes TypeScript, App Router, Tailwind, reviewed shadcn Radix Nova source, a responsive direct-message UI, Neon Postgres, Drizzle migrations, explicit polling for Vercel, health and profile routes, and one authentication provider:

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

The CLI installs exact reviewed dependency versions. It does not run `shadcn@latest` during user setup.

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

The generated chat UI is application-owned source. It is not a reusable `@chatpack/ui` package.

## License

[MIT](./LICENSE). The bundled TypeScript compiler is distributed under the [Apache License 2.0](./LICENSE.typescript).
