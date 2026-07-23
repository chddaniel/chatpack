# @chatpack/next

## 0.1.2

### Patch Changes

- 6133227: Docs-only release — README improvements from external integration feedback:

  - Install snippets now show npm/pnpm/bun variants and note that both
    `@chatpack/core` and a storage adapter are required.
  - Documented the `auth` hook return contract: `ChatpackUser | null`
    (an object with `id: string`); a bare string is treated as
    unauthenticated and produces `401`.
  - Full HTTP error status table including `401 UNAUTHENTICATED`,
    `404 NOT_FOUND` (unmatched route), and `500 INTERNAL_ERROR`.
  - Documented that `GET`/`POST`/`PATCH`/`DELETE`/`fetch` on the handler are
    all the same function, with generic mounting one-liners for Hono, Elysia,
    and Bun/Deno/Workers.
  - Explicit note that the API must be mounted on a catch-all route
    (`[...chatpack]` in Next.js) so sub-paths like `/stream` resolve.

  No code changes.

- Updated dependencies [6133227]
  - @chatpack/core@0.1.2

## 0.1.1

### Patch Changes

- Documentation: the quickstart and `@chatpack/core` README now include curl-able
  HTTP examples with real request/response JSON, and the REST route table
  documents request bodies, query params, and response envelopes for every
  endpoint (verified against the handler source). No code changes.
- Updated dependencies
  - @chatpack/core@0.1.1

## 0.1.0

### Minor Changes

- Initial public release — the complete Chatpack v0 MVP.

  - **`@chatpack/core`** — the chat engine: 1:1 conversations (find-or-create by
    pair key), text messages (send / list / edit / soft-delete), participant-only
    permissions with override hooks, durable read-state, a Web-standard HTTP
    handler (`chat.handler()`) exposing the whole REST API plus a `GET /stream`
    SSE endpoint with `Last-Event-ID` reconnect gap-fill, the `StorageAdapter`
    and `Transport` contracts, and anonymous opt-out telemetry
    (`telemetry: false` or `CHATPACK_TELEMETRY=0`).
  - **`@chatpack/adapter-memory`** — in-memory reference `StorageAdapter` for
    demos and tests.
  - **`@chatpack/adapter-drizzle`** — production Drizzle/Postgres adapter with
    atomic per-conversation `seq` assignment and race-safe conversation
    creation; tested against real Postgres (PGlite).
  - **`@chatpack/next`** — one-line Next.js App Router mounting via
    `toNextRouteHandlers(chat)`.

### Patch Changes

- Updated dependencies
  - @chatpack/core@0.1.0
