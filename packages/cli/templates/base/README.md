# {{PACKAGE_NAME}}

A production-oriented Chatpack {{FRAMEWORK}} starter with Neon Postgres, Drizzle, and {{AUTH_PROVIDER}} authentication.

## Set up

1. Create a Neon database.
2. Copy `.env.example` to `{{ENV_FILE}}`.
3. Add the required secrets described in the environment example.
4. Run `{{PACKAGE_MANAGER}} run db:generate`, `{{PACKAGE_MANAGER}} run db:migrate`, and `{{PACKAGE_MANAGER}} run setup:check`.
   `db:migrate` runs drizzle-kit and then `scripts/filepack-migrate.ts`, which creates the four attachment tables Filepack owns. Those are not in `src/db/schema.ts` on purpose - the comment there says why - so drizzle-kit alone leaves them out.
5. Run `{{PACKAGE_MANAGER}} run dev`.

The generated source is application-owned. Edit it to fit your product. It is not a reusable `@chatpack/ui` package.

`{{PACKAGE_MANAGER}} run build` needs the same environment variables to be **set**, because `src/lib/env.ts` checks them when the module is first imported. It does not need a reachable database - no connection is opened at build time - so a placeholder value is enough in CI. Vercel supplies the real values to both the build and the running app.

## Run against a local Postgres instead of Neon

Optional, for developing without a Neon account. The Neon driver speaks Postgres over a WebSocket that Neon's own edge terminates; a plain Postgres has nothing listening for that, so `{{PACKAGE_MANAGER}} run db:proxy` starts a small local bridge in front of port 5432.

```sh
docker run -d --name chat-pg -e POSTGRES_PASSWORD=postgres -p 5432:5432 postgres:17
{{PACKAGE_MANAGER}} run db:proxy
```

Then put both of these in `{{ENV_FILE}}`:

```sh
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/postgres?sslmode=disable
NEON_WS_PROXY=127.0.0.1:5480
```

Create the tables with `psql` instead of `db:migrate`, because drizzle-kit opens its own Neon connection and does not read `NEON_WS_PROXY`:

```sh
{{PACKAGE_MANAGER}} run db:generate
docker exec -i chat-pg psql -U postgres -d postgres < drizzle/0000_*.sql
{{PACKAGE_MANAGER}} run db:filepack
```

The last line is the attachment tables. It is a plain script rather than drizzle-kit, so it goes through `src/lib/db.ts` and does honour the proxy - no `psql` needed. If you would rather apply everything by hand, `{{PACKAGE_MANAGER}} run db:filepack -- --print` writes that SQL to stdout instead of running it.

The proxy reads `{{ENV_FILE}}` as well, so if your Postgres is not on 5432 put `WSPROXY_PG_PORT` there rather than on the command line.

Leave `NEON_WS_PROXY` unset and none of that code path runs. Never deploy the proxy - production talks to Neon directly over TLS.

{{STARTER_NOTES}}

## Deploy

Chatpack uses transactions for message ordering, so do not replace the Neon Pool with the Neon HTTP driver.

Generation does not create external accounts, write secrets, run migrations, or deploy this app.
