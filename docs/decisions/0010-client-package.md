# ADR 0010: First-party Chatpack client package

- **Status:** accepted
- **Date:** 2026-08-01
- **Milestone:** client package

## Context

Chatpack already exposes a stable Web-standard REST handler and SSE stream.
Applications otherwise repeat URL construction, response-envelope parsing,
message deduplication, and stream lifecycle code. The client must improve this
developer experience without moving authentication or browser policy into
core.

## Decision

1. Publish `@chatpack/client` for framework-agnostic REST, SSE, cache, and
   plugin composition. Publish `@chatpack/client/react` as a separate React
   entry point with React as an optional peer dependency.
2. Use resource namespaces (`conversations`, `messages`, `realtime`) and a
   discriminated `{ data, error }` result. Expected HTTP, malformed-response,
   and network failures do not throw.
3. Default to relative `/api/chat` requests and `same-origin` credentials.
   Allow `baseURL`, `basePath`, headers, fetch, and EventSource injection.
   The client never reads cookies or implements authentication.
4. Keep one lazy EventSource per client. Browser reconnect behavior owns
   `Last-Event-ID`; the client reconciles durable events by message id and seq.
   Ephemeral events are dispatched but never cached as message history.
5. Use a small per-client external store based on platform APIs. React hooks
   use `useSyncExternalStore`; no cache or state-library dependency ships.
6. Client plugins have stable ids, namespaced actions, typed event names,
   per-client state, and cleanup. First-party typing, presence, and receipts
   adapters mirror the existing server plugin routes and events.

## Consequences

- Same-origin cookie sessions work naturally for REST and SSE. Cross-origin
  cookie sessions must opt into `credentials: "include"`.
- Bearer tokens can be supplied to REST through custom headers, but cannot be
  sent by native EventSource and are never copied into the stream URL.
- Cache behavior remains intentionally small: no optimistic mutations,
  polling, persistence, retries, or offline synchronization in this release.
- Framework integrations stay separate. Future Vue, Svelte, Solid, or vanilla
  helpers can consume the same client core without changing the protocol.

## Deferred

SSR hydration, optimistic rollback, offline persistence, cross-tab sync,
polling fallback, abort/retry policies, generated server-plugin clients,
groups, attachments, and WebSockets are explicitly out of scope.

> **Amended by [ADR 0016](./0016-client-polling-fallback.md) (client 0.4.0):**
> the polling fallback is no longer deferred. It shipped because "no polling"
> meant "no client at all on serverless, buffering proxies, or React Native" -
> the deferral cost the platforms Chatpack most wanted to reach. Everything else
> on this list still stands.

> **Amended (client 0.5.0):** groups are no longer deferred. Once
> [ADR 0017](./0017-group-conversations.md) shipped them server-side, the
> client gap meant every group app had to hand-roll `fetch` calls and membership
> event handling - the exact protocol duplication this package exists to
> prevent. The client wraps the five group mutations and applies
> `participant.*` / `conversation.updated` to its cache. Attachments and
> WebSockets remain deferred, as does the rest of the list above.
