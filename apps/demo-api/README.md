# @chatpack/demo-api

The public demo Chatpack backend behind **https://demo-api.chatpack.dev** —
a real, running chat server that people designing UI in AI builders (Lovable,
v0, Shipper, Bolt) can point components at without installing anything.

Not published to npm, not part of the library. It exists so
`docs/ui-blocks-brief.md` can say "connect to this URL" instead of "clone the
repo and run a dev server".

## The one design decision that matters

AI-builder previews render inside a **cross-site iframe**, where browsers drop
or partition third-party cookies. Chatpack's usual `demo_user` cookie recipe
silently fails there — this was the diagnosed cause of the Lovable demo
failure (2026-07-30).

So this backend takes the demo identity from the **URL path** instead:

```
https://demo-api.chatpack.dev/api/chat/u/<sandbox>/<userId>/conversations
```

- `<userId>` — the demo identity (`alice`, `bob`, `carol`, or anything else)
- `<sandbox>` — scopes storage so unrelated builders never share data

No cookies, no `Access-Control-Allow-Credentials`, no `SameSite` puzzle, and
`EventSource` works (it can't set headers, but it can fetch a URL). Consumers
set the client's `baseURL` + `basePath` once and everything else is stock
Chatpack:

```ts
createChatClient({
  baseURL: "https://demo-api.chatpack.dev",
  basePath: "/api/chat/u/my-sandbox/alice",
  plugins: [typingClient(), presenceClient(), receiptsClient()],
});
```

This works because `chat.handler({ basePath })` accepts a per-request prefix —
core needed no changes.

**Demo-only:** anyone with the URL can act as that user. Real apps resolve a
session or JWT in the `auth` hook.

## How it's put together

| File                              | Role                                                                            |
| --------------------------------- | ------------------------------------------------------------------------------- |
| `lib/chat.ts`                     | Identity parsing, one Chatpack instance per sandbox, seed script, 2000-char cap |
| `lib/cors.ts`                     | Wildcard CORS (safe only because there are no credentials)                      |
| `app/api/chat/[...path]/route.ts` | Per-request dispatch into the right sandbox                                     |
| `app/page.tsx`                    | The landing page, which is also the docs for this backend                       |
| `app/api/health/route.ts`         | Liveness probe / quick CORS check                                               |

Depends on the **published** npm versions (core 0.4.0, adapter-memory 0.2.1),
not workspace links, so it proves the setup a reader can install today. The
message-length cap uses `beforeMessageSend` (ADR 0011), which turns a thrown
error into a 422 `MESSAGE_REJECTED` carrying the message text.

## Seed data

A fresh sandbox is populated on first touch, because a vibe coder who hits an
empty backend assumes they wired it wrong:

- **alice ↔ bob** — 4-message exchange, plus one **edited** message and one
  **deleted** message (tombstone), so those states are reachable without
  having to produce them by hand
- **alice ↔ carol** — a second conversation, so list components have more than
  one row
- **Design team** — a three-person group with Alice as admin, Bob and Carol as
  members, and messages from all three participants

Storage is in-memory: data resets on cold start and reseeds automatically.

## Local development

```sh
pnpm --filter @chatpack/demo-api dev     # http://localhost:3344
```

Verify a few things at once:

```sh
curl http://localhost:3344/api/health
curl http://localhost:3344/api/chat/u/test/alice/conversations
curl -N http://localhost:3344/api/chat/u/test/bob/stream    # live events
```

## Deployment

Vercel project `chatpack-demo-api` (team "Yeabsra's projects"), deployed from
this directory with `vercel deploy --prod` — same CLI-only flow as
`apps/docs`, not git-connected, so redeploys are manual.

Because storage is in-memory and SSE is single-node, this only behaves while
one warm instance serves the traffic — the documented demo tradeoff
(`llms.txt` deployment table). Fine for UI work; a production deploy would use
`@chatpack/adapter-drizzle`.
