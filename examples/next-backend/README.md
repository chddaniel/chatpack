# example-next-backend

The Chatpack quickstart as a runnable Next.js App Router app: **two files** —
`lib/chat.ts` (create the instance) and
`app/api/chat/[...chatpack]/route.ts` (mount it) — give you the whole REST +
SSE chat backend.

> Auth here trusts an `x-user-id` header. **Demo only.** In a real app your
> `auth` hook verifies a session or JWT.

## Run

```sh
pnpm install
pnpm --filter example-next-backend dev
```

Then exercise it exactly like the [node-server example](../node-server) — same
API, same curl walkthrough, same SSE stream, just served by Next.js:

```sh
BASE=http://localhost:3000/api/chat

# find-or-create a conversation as alice
curl -s -X POST $BASE/conversations \
  -H 'x-user-id: alice' -H 'content-type: application/json' \
  -d '{"otherUserId":"bob"}'

# send a message as alice
curl -s -X POST $BASE/conversations/conv_1/messages \
  -H 'x-user-id: alice' -H 'content-type: application/json' \
  -d '{"body":"hello from next"}'

# listen live as bob (leave running in a second terminal)
curl -N $BASE/stream -H 'x-user-id: bob'
```

## The integration, in full

```ts
// lib/chat.ts
import { chatpack } from "@chatpack/core";
import { memoryAdapter } from "@chatpack/adapter-memory";

export const chat = chatpack({
  storage: memoryAdapter(),
  auth: (request) => {
    const userId = request.headers.get("x-user-id");
    return userId ? { id: userId } : null;
  },
});
```

```ts
// app/api/chat/[...chatpack]/route.ts
import { toNextRouteHandlers } from "@chatpack/next";
import { chat } from "@/lib/chat";

export const { GET, POST, PATCH, DELETE } = toNextRouteHandlers(chat);
```

That's the entire integration. For production, swap `memoryAdapter()` for
[`drizzleAdapter(db)`](../../packages/adapter-drizzle) and point it at your
Postgres.
