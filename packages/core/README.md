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

## Writing a storage adapter

Implement the exported `StorageAdapter` interface. The
[in-memory adapter](../adapter-memory) is the reference implementation.
See the [contributing guide](../../CONTRIBUTING.md) for the contract rules.

## License

[MIT](../../LICENSE)
