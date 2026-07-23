# @chatpack/next

Next.js App Router integration for
[Chatpack](https://github.com/chddaniel/chatpack) — mount the whole chat API
on one catch-all route.

The Chatpack handler is already Web-standard (`Request` → `Response`), which is
exactly what App Router route handlers expect, so this package is a thin,
readable convenience wrapper.

## Install

```sh
# pick your package manager
npm  install @chatpack/core @chatpack/adapter-memory @chatpack/next
pnpm add     @chatpack/core @chatpack/adapter-memory @chatpack/next
bun  add     @chatpack/core @chatpack/adapter-memory @chatpack/next
```

## Use

```ts
// lib/chat.ts
import { chatpack } from "@chatpack/core";
import { memoryAdapter } from "@chatpack/adapter-memory";

export const chat = chatpack({
  storage: memoryAdapter(),
  auth: async (req) => getSessionUser(req), // your auth
});
```

> The `auth` hook must return `ChatpackUser | null` — an object with at least
> `{ id: string }`, or `null` for unauthenticated requests (`401`). A bare
> string is treated as unauthenticated. Prefer cookie-based sessions —
> `EventSource` (the SSE stream) cannot send custom headers.

```ts
// app/api/chat/[...chatpack]/route.ts
import { toNextRouteHandlers } from "@chatpack/next";
import { chat } from "@/lib/chat";

export const { GET, POST, PATCH, DELETE } = toNextRouteHandlers(chat);
```

> The route file must be a **catch-all** (`[...chatpack]`) so every sub-path
> under `/api/chat` — including `/api/chat/stream` — reaches the handler.

Mounting somewhere other than `/api/chat`? Pass the base path:

```ts
export const { GET, POST, PATCH, DELETE } = toNextRouteHandlers(chat, {
  basePath: "/api/messaging",
});
```

See the [REST API reference](../core/README.md#rest-api) for all routes.

## License

[MIT](../../LICENSE)
