# @chatpack/core

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
