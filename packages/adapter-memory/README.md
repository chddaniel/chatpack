# @chatpack/adapter-memory

In-memory storage adapter for [Chatpack](https://github.com/chddaniel/chatpack).
Zero setup, backed by JavaScript Maps - perfect for demos, examples, and fast
deterministic tests.

> **Data is lost when the process exits.** Use a database adapter in
> production -
> [`@chatpack/adapter-drizzle`](https://github.com/chddaniel/chatpack/tree/main/packages/adapter-drizzle)
> (Postgres) is published and ready. On serverless/edge platforms each isolate
> has its own memory, so this adapter effectively stores nothing there.

This package is also the **reference implementation** of the `StorageAdapter`
contract - all nineteen required methods, including the five that groups added
(`createGroupConversation`, `addParticipants`, `removeParticipant`,
`setParticipantRole`, `updateConversation`) - plus **all four** optional
capabilities: search, the nine-method `invites` namespace behind invite links and
join requests, the one-method `channels` namespace behind the public channel
directory, and the `moderation` namespace behind blocks, mutes, reports and
bans. Writing your
own adapter? Start by reading [`src/index.ts`](./src/index.ts), then follow
Part 2 of [`llms.txt`](../../llms.txt) for the invariants it demonstrates.

## Install

```sh
# pick your package manager
npm  install @chatpack/core @chatpack/adapter-memory
pnpm add     @chatpack/core @chatpack/adapter-memory
bun  add     @chatpack/core @chatpack/adapter-memory
```

## Use

```ts
import { chatpack } from "@chatpack/core";
import { memoryAdapter } from "@chatpack/adapter-memory";

const chat = chatpack({ storage: memoryAdapter() });
```

## License

[MIT](../../LICENSE)
