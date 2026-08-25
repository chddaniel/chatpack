# @chatpack/app

A production-oriented Chatpack next starter with Neon Postgres, Drizzle, and better-auth authentication.

## Set up

1. Create a Neon database.
2. Copy `.env.example` to `.env.local`.
3. Add the required secrets described in the environment example.
4. Run `pnpm run db:generate`, `pnpm run db:migrate`, and `pnpm run setup:check`.
   `db:migrate` runs drizzle-kit and then `scripts/filepack-migrate.ts`, which creates the four attachment tables Filepack owns. Those are not in `src/db/schema.ts` on purpose - the comment there says why - so drizzle-kit alone leaves them out.
5. Run `pnpm run dev`.

The generated source is application-owned. Edit it to fit your product. It is not a reusable `@chatpack/ui` package.

`pnpm run build` needs the same environment variables to be **set**, because `src/lib/env.ts` checks them when the module is first imported. It does not need a reachable database - no connection is opened at build time - so a placeholder value is enough in CI. Vercel supplies the real values to both the build and the running app.

## Run against a local Postgres instead of Neon

Optional, for developing without a Neon account. The Neon driver speaks Postgres over a WebSocket that Neon's own edge terminates; a plain Postgres has nothing listening for that, so `pnpm run db:proxy` starts a small local bridge in front of port 5432.

```sh
docker run -d --name chat-pg -e POSTGRES_PASSWORD=postgres -p 5432:5432 postgres:17
pnpm run db:proxy
```

Then put both of these in `.env.local`:

```sh
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/postgres?sslmode=disable
NEON_WS_PROXY=127.0.0.1:5480
```

Create the tables with `psql` instead of `db:migrate`, because drizzle-kit opens its own Neon connection and does not read `NEON_WS_PROXY`:

```sh
pnpm run db:generate
docker exec -i chat-pg psql -U postgres -d postgres < drizzle/0000_*.sql
pnpm run db:filepack
```

The last line is the attachment tables. It is a plain script rather than drizzle-kit, so it goes through `src/lib/db.ts` and does honour the proxy - no `psql` needed. If you would rather apply everything by hand, `pnpm run db:filepack -- --print` writes that SQL to stdout instead of running it.

The proxy reads `.env.local` as well, so if your Postgres is not on 5432 put `WSPROXY_PG_PORT` there rather than on the command line.

Leave `NEON_WS_PROXY` unset and none of that code path runs. Never deploy the proxy - production talks to Neon directly over TLS.

## What is wired up

Every Chatpack feature is in this app, not just the ones a demo needs:

| Page             | Features                                                                                                                                                                                                             |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/`              | directs, groups and channels; reactions, quote-replies, edit, delete, forward, report; mentions, attachments, typing signals, presence dots, unread counts, members and roles, invites, the join queue, mute, search |
| `/channels`      | the public channel directory, with open joins and approval requests                                                                                                                                                  |
| `/invite/[code]` | invite-link preview and accept                                                                                                                                                                                       |
| `/moderation`    | the report queue, bans, and the people you have blocked                                                                                                                                                              |

`src/lib/chatpack.server.ts` is the only file that decides anything: permissions,
who counts as a moderator, the message-length cap, the file plugin and the
transport all live there, and one handler on a catch-all route serves every route
above plus `/stream`. Read the server file first.

The UI is application-owned React. Nothing under `src/components` is a Chatpack
API - delete whatever your product does not need.

## Authentication

Sign-in is wired with better-auth. `src/lib/chatpack.server.ts` passes the
signed-in user id to Chatpack and validates ids against the `profiles` table, so a
conversation can never be opened with someone who does not exist.

Email verification is **disabled** so the starter runs immediately. Turn it on in
`src/lib/auth.ts` before accepting untrusted public sign-ups.

Google and GitHub sign-in are also available. Add each provider's client ID and
secret to `.env.local` to enable it:

```sh
GOOGLE_CLIENT_ID=your-google-client-id
GOOGLE_CLIENT_SECRET=your-google-client-secret
GITHUB_CLIENT_ID=your-github-client-id
GITHUB_CLIENT_SECRET=your-github-client-secret
```

Register these callback URLs with the providers:

- `http://localhost:3000/api/auth/callback/google`
- `http://localhost:3000/api/auth/callback/github`

Use your deployed `BETTER_AUTH_URL` when configuring production callback URLs.

## Appearance

Use the palette button in the conversation sidebar to choose system, light, or
dark mode. The same menu includes Default, Ocean, Sunset, Forest, and Violet
color schemes. The selected color scheme is stored in the browser and applies
across sessions.

## Optional features

Three things stay off until you set an environment variable (all of them are
listed, commented out, in `.env.example`):

- **Moderation queue** - `MODERATOR_EMAILS` or `MODERATOR_USER_IDS`. With both
  empty nobody is a moderator, so `/moderation` answers with a refusal.
  Reporting and blocking need no configuration; reviewing reports and banning do.
- **File attachments** - uploads go to `.chatpack-files` on local disk. Set
  `S3_BUCKET` and the other `S3_*` values to store them in any S3-compatible
  bucket (AWS, R2, B2, MinIO) instead. Do that before you deploy: a serverless
  filesystem is not shared between invocations and does not outlive one.
- **Multi-node realtime** - `REDIS_URL`. A single process fans events out in
  memory. Two or more need Redis, or a message sent on server A never reaches a
  listener on server B. Presence needs one more step: this starter uses the
  per-process default, so pass `presence({ store: redisPresenceStore({ client })
})` to report users connected to another node as online
  (`docs/decisions/0025`).

## Deploy to Vercel

Import the repository, add the same environment variables, and deploy. The Neon Pool
is registered with the Vercel Functions lifecycle helper in `src/lib/db.ts`.

## Deploy

Chatpack uses transactions for message ordering, so do not replace the Neon Pool with the Neon HTTP driver.

Generation does not create external accounts, write secrets, run migrations, or deploy this app.
