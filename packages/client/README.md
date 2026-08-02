# @chatpack/client

Framework-agnostic Chatpack client with an optional React integration.

```sh
pnpm add @chatpack/client
```

```ts
import { createChatClient } from "@chatpack/client";

const chatClient = createChatClient({
  // Omit when the API is on the same origin.
  baseURL: "http://localhost:3000",
  credentials: "include",
});

const conversation = await chatClient.conversations.create({ otherUserId: "bob" });
if (conversation.error === null) {
  await chatClient.messages.send({
    conversationId: conversation.data.id,
    body: "Hello",
  });
}
```

Methods return `{ data, error }`. Expected HTTP and network failures do not
throw. The client uses the server's existing authentication. It never reads
cookies, manages sessions, or puts tokens in an SSE URL. Browser cookie
authentication is the recommended model because native `EventSource` cannot
send custom headers.

## React

React is optional:

```sh
pnpm add @chatpack/client react
```

```tsx
"use client";

import { createChatClient } from "@chatpack/client/react";

const chatClient = createChatClient();

export function ConversationList() {
  const { data, isPending } = chatClient.useConversations();
  if (isPending) return <p>Loading…</p>;
  return (
    <ul>
      {data?.conversations.map((item) => (
        <li key={item.id}>{item.id}</li>
      ))}
    </ul>
  );
}
```

The React adapter uses `useSyncExternalStore`, shares one per-client cache and
one lazy SSE connection, and has no state-library dependency.

## API

The framework-agnostic client mirrors the server routes from `@chatpack/core`:

| Client surface           | Core route or behavior                                |
| ------------------------ | ----------------------------------------------------- |
| `conversations.create`   | `POST /conversations`                                 |
| `conversations.list`     | `GET /conversations`                                  |
| `conversations.get`      | `GET /conversations/:id`                              |
| `conversations.markRead` | `POST /conversations/:id/read`                        |
| `messages.list`          | `GET /conversations/:id/messages`                     |
| `messages.send`          | `POST /conversations/:id/messages`                    |
| `messages.edit`          | `PATCH /messages/:id`                                 |
| `messages.delete`        | `DELETE /messages/:id`                                |
| `realtime`               | `GET /stream` with native reconnect and deduplication |

Every request returns `{ data, error }`. The client passes browser credentials
to the server; it does not replace the server's auth hook or accept a user id.

## Plugins

First-party client counterparts are available from `@chatpack/client/plugins`:

```ts
import { typingClient, presenceClient, receiptsClient } from "@chatpack/client/plugins";
import { createChatClient } from "@chatpack/client";

const chatClient = createChatClient({
  plugins: [typingClient(), presenceClient(), receiptsClient()],
});

await chatClient.typing.start({ conversationId: "c1" });
```

Client plugins add namespaced actions and per-client state. Authentication and
server plugin route discovery remain outside this package.

## Scope

The package covers the public 1:1 REST API, SSE message reconciliation,
ephemeral event subscriptions, and React hooks. It does not provide auth,
uploads, groups, polling fallback, optimistic state, persistence, or WebSocket
transport.

## Source layout

- `src/index.ts` exports the framework-agnostic public API.
- `src/config.ts` defines fetch, headers, credentials, and EventSource injection.
- `src/client.ts` composes the public client and core resource methods.
- `src/request.ts` builds URLs, sends JSON, and maps response envelopes/errors.
- `src/errors.ts` defines the `{ data, error }` result and stable client errors.
- `src/wire.ts` defines the JSON-facing domain types used by REST and SSE.
- `src/realtime.ts` owns the lazy EventSource and event dispatch.
- `src/store.ts` provides the small platform-only observable store.
- `src/store-cache.ts` reconciles REST and durable SSE data per client.
- `src/plugin.ts` composes typed plugin actions and state.
- `src/plugins/` contains first-party typing, presence, and receipts adapters.
- `src/react/` exposes `useSyncExternalStore` hooks without a state dependency.
