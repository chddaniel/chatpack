# ADR 0005 - One Web-standard handler; framework packages are thin wrappers

- Status: accepted
- Date: 2026-07-22

## Context

MVP §2 requires a "framework handler [that] mounts the whole API on one route
(Web-standard `Request`/`Response`; Next.js App Router as the first documented
target)". The tempting shortcut is to build a Next.js handler directly - but
that couples the HTTP surface to one framework and forces a rewrite for Bun,
Deno, Workers, Express, etc.

## Decision

The HTTP layer lives in core as `createHandler()`
(`packages/core/src/handler.ts`), speaking only WHATWG `Request`/`Response`.
`chat.handler()` returns the same function under several names:

- `GET` / `POST` / `PATCH` / `DELETE` - re-exportable verbatim from a Next.js
  App Router route file;
- `fetch` - the generic entry point for `Bun.serve`, Deno, and Workers.

Framework packages stay thin: `@chatpack/next` is a one-function wrapper
(`toNextRouteHandlers`). Node's `http` module needs a ~20-line bridge, shown
in `examples/node-server` rather than shipped as a package until demand exists.

Error mapping is part of the contract: every `ChatpackError.code` has a fixed
HTTP status (`INVALID_INPUT`→400, `FORBIDDEN_*`→403, `*_NOT_FOUND`→404,
`MESSAGE_DELETED`→409), unauthenticated requests get 401, and unexpected
failures return an opaque 500 (details are logged server-side, never leaked).

The auth hook runs once per request before any routing logic; handlers cannot
be constructed without one (fail-fast at `chat.handler()` time, not at first
request).

## Consequences

- New runtimes need zero core changes - SSE (M3) will follow the same shape.
- The REST surface is testable with plain `Request` objects; no framework
  test harness required.
- `@chatpack/next` looks almost too small to exist. That is the point: it
  encodes the documented, conventional mounting pattern and gives Next.js
  users an obvious front door.
