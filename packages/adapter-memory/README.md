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
contract: writing your own adapter? Start by reading
[`src/index.ts`](./src/index.ts).

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
