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

First-party adapters use one canonical search contract exported from core:
normalize text with Unicode NFKC, lowercase it, and split on every character
that is not a Unicode letter or number. A query matches only when every unique
term is present. The score is the sum of the occurrences of those terms. There
is no stemming, prefix matching, or backend-specific punctuation behavior, so
queries match consistently for URLs, paths, email addresses, phone numbers,
versions, and underscored identifiers. Repeated query terms do not increase the
score because query terms are deduplicated.

Memory computes these tokens at search time. Drizzle stores token occurrence
counts in `chatpack_message_search_tokens`, indexed by `(token, message_id)`,
and maintains them when messages are added, edited, or tombstoned. Existing
Postgres deployments must run `backfillMessageSearchTokens` once after the
migration so old messages become searchable.

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
- Custom adapters may omit search. Custom adapters that implement it should use
  the exported core tokenizer and score to preserve the first-party contract.
- Existing Postgres deployments must apply the new token-table DDL and run the
  one-time token backfill before serving search.
- A future design is required for non-participant `canRead` search access.
