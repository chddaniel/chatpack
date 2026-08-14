# @chatpack/cli

Initialize Chatpack in an existing application.

```sh
npx @chatpack/cli init
```

The CLI detects the project framework, package manager, language, aliases,
existing Chatpack setup, database hints, and authentication hints. It asks for
uncertain choices, prints a plan, and refuses conflicting file changes.

## Non-interactive setup

Supply every important decision when using `--yes`:

```sh
npx @chatpack/cli init \
  --framework next \
  --adapter memory \
  --package-manager pnpm \
  --yes
```

For Drizzle, also supply the database module and export:

```sh
npx @chatpack/cli init \
  --framework next \
  --adapter drizzle \
  --db-path src/lib/db.ts \
  --db-export db \
  --package-manager pnpm \
  --yes
```

Use `--dry-run` to inspect the plan without installing packages or changing
files. The CLI never runs database migrations.

## Generated setup

Next.js projects receive one server instance and one catch-all route. Hono and
Express projects receive a server module plus a framework integration. If the
CLI cannot identify one safe application entrypoint, it generates the
integration module and prints the mount snippet instead of editing user code.

Chatpack does not own authentication. The generated resolver returns `null`
until the application connects its own session or token verification. A
confirmed resolver must accept a Web-standard `Request` and expose a user id.

With `--client`, Next.js projects import the React client entrypoint. Other
frameworks import the framework-agnostic client. The generated client supports
direct and group conversations, message search, reactions, and automatic
polling when a realtime connection is unavailable. No polling option is needed
for the default fallback.

Memory storage is suitable for demos and tests only. Drizzle setup generates
the Chatpack schema export, but migration remains under the application's
normal Drizzle workflow.

## Scope

The v1 command is `init`. Client setup is optional with `--client`. Provider-
specific authentication, custom storage adapters, migration execution, plugin
generation, and diagnostics are deferred.

## Community

- **[Discord](https://discord.gg/gY3GCTRv5Y)** — chat with the team and other developers
- **[X](https://x.com/chatpackdev)** — releases and updates
- **[Docs](https://docs.chatpack.dev)** — the full documentation site
- **[GitHub Discussions](https://github.com/chddaniel/chatpack/discussions)** — questions, show-and-tell, and feedback

## License

[MIT](./LICENSE). The bundled TypeScript compiler is distributed under the
[Apache License 2.0](./LICENSE.typescript).
