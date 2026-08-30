# ADR 0028: UI block and integration boundaries

## Status

Accepted

## Decision

`@chatpack/ui` owns React rendering, local interaction state, loading/error/
empty states, accessibility semantics, and calls to the public
`@chatpack/client` surface. It must not write direct Chatpack HTTP requests or
invent user, avatar, last-message, or conversation-summary fields.

Authentication, profile rendering, routing, and host authorization policy stay
outside the package. The host supplies `renderUser` and success/navigation
callbacks where needed.

`@chatpack/file` owns Filepack upload and authorized target resolution. UI media
components consume stable `{ id, name, contentType, size }` references and a
resolver. They do not trust URLs embedded in message metadata.

## Consequences

Connected blocks stay consistent with cache, SSE, polling fallback, and server
authorization behavior. Consumers must configure the matching client plugins
for typing, presence, and receipts, and must provide a Filepack resolver for
media rendering. Missing integrations render explicit unavailable or disabled
states instead of silently using fake data.
