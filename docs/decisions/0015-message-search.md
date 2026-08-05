# ADR 0015: Participant-scoped ranked message search

- **Status:** accepted
- **Date:** 2026-08-03
- **Milestone:** v0.next (message search)

## Context

Applications need to find message bodies across the user's conversations.
Search must be case-insensitive, useful at scale on Postgres, and safe for the
default participant-only access model.

## Decision

Add an optional `StorageAdapter.searchMessages` capability. It receives the
searching `userId`, searches non-tombstone message bodies only in conversations
where that user is a participant, and returns ranked pages with an opaque
cursor. The existing adapter contract remains fourteen required methods.

Core adds `chat.api.searchMessages` and still filters returned candidates
through the configured `canRead` hook. Non-participant access granted by a
custom `canRead` hook is explicitly deferred; search does not return those
conversations yet.

Search uses plain-text, case-insensitive whole-token terms with no stemming.
The first-party adapters align on these punctuation rules: `@` and `.` inside
an alphanumeric token stay part of that token, while hyphenated compounds
match both the compound and its component terms. The Drizzle adapter uses
PostgreSQL `to_tsvector('simple', body)` with `plainto_tsquery('simple', query)`
and `ts_rank`; the memory adapter uses equivalent lower-cased token matching
with a deterministic score. Custom adapters may use backend-specific matching
and relevance semantics, but must document them with their capability.

Results order by relevance descending, creation time descending, then message
id descending as a stable tie-break. Tombstones are excluded because their
content was deleted and must not reappear in search.

The Drizzle schema adds a GIN expression index on the simple body vector.
The HTTP surface is `GET /search/messages?q=&limit=&cursor=` and returns
`{ messages, nextCursor }`. No client hook is added in this milestone.

## Consequences

- Search is an optional capability, so existing custom adapters remain valid.
  Adapters that provide it must apply the participant scope supplied by
  `userId`.
- Core performs `canRead` checks on participant-scoped results.
- Core throws `SEARCH_UNSUPPORTED` when the configured adapter does not provide
  the capability; the HTTP handler maps this to `501`.
- Search cursors are adapter-defined and must survive URL query parameters.
- Existing Postgres deployments must apply the new idempotent search-index DDL.
- A future design is required for non-participant `canRead` search access.
