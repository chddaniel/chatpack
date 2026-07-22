# @chatpack/core

The Chatpack engine: 1:1 conversations, messages, permissions, durable
read-state, and the `StorageAdapter` contract. Backend-only and
framework-agnostic — you bring auth, storage, and a frontend.

> Part of [Chatpack](https://github.com/chddaniel/chatpack) — open-source chat
> infrastructure for developers.

## Install

```sh
pnpm add @chatpack/core @chatpack/adapter-memory
```

## Use

```ts
import { chatpack } from "@chatpack/core";
import { memoryAdapter } from "@chatpack/adapter-memory";

const chat = chatpack({
  storage: memoryAdapter(),
  auth: async (req) => getSessionUser(req), // your auth, your users
});

const conversation = await chat.api.getOrCreateConversation({
  userId: "alice",
  otherUserId: "bob",
});

await chat.api.sendMessage({
  userId: "alice",
  conversationId: conversation.id,
  body: "hey bob!",
});
```

## API surface

| Method                        | What it does                                        |
| ----------------------------- | --------------------------------------------------- |
| `api.getOrCreateConversation` | Find or create the 1:1 conversation for a user pair |
| `api.listConversations`       | List a user's conversations, most recent first      |
| `api.getConversation`         | Fetch one conversation (read-permission checked)    |
| `api.sendMessage`             | Send a text message (write-permission checked)      |
| `api.listMessages`            | Paginate history, newest-first                      |
| `api.editMessage`             | Edit your own message                               |
| `api.deleteMessage`           | Soft-delete your own message                        |
| `api.markRead`                | Update durable read-state (`last_read`)             |

All failures throw `ChatpackError` with a stable `code`
(`FORBIDDEN_READ`, `MESSAGE_NOT_FOUND`, `INVALID_INPUT`, ...).

## REST API

`chat.handler()` mounts everything on one route using Web-standard
`Request`/`Response` — works on Next.js App Router
(see [`@chatpack/next`](../next)), Bun, Deno, Workers, or Node via a tiny
bridge (see [`examples/node-server`](../../examples/node-server)).

```ts
// app/api/chat/[...chatpack]/route.ts  (Next.js App Router)
import { chat } from "@/lib/chat";
export const { GET, POST, PATCH, DELETE } = chat.handler();
```

Routes (relative to `basePath`, default `/api/chat`):

| Method | Path                          | Action                  |
| ------ | ----------------------------- | ----------------------- |
| POST   | `/conversations`              | find-or-create a 1:1 DM |
| GET    | `/conversations`              | list my conversations   |
| GET    | `/conversations/:id`          | fetch one conversation  |
| POST   | `/conversations/:id/messages` | send a message          |
| GET    | `/conversations/:id/messages` | list messages           |
| POST   | `/conversations/:id/read`     | update my last-read     |
| PATCH  | `/messages/:id`               | edit my message         |
| DELETE | `/messages/:id`               | soft-delete my message  |

The `auth` hook runs on every request; unauthenticated requests get `401`.
Errors are JSON — `{ "error": { "code", "message" } }` — with statuses mapped
from the error code (`INVALID_INPUT` 400, `FORBIDDEN_*` 403, `*_NOT_FOUND`
404, `MESSAGE_DELETED` 409).

## Writing a storage adapter

Implement the exported `StorageAdapter` interface. The
[in-memory adapter](../adapter-memory) is the reference implementation.
See the [contributing guide](../../CONTRIBUTING.md) for the contract rules.

## License

[MIT](../../LICENSE)
