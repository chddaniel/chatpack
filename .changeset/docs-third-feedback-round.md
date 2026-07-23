---
"@chatpack/core": patch
"@chatpack/adapter-memory": patch
"@chatpack/adapter-drizzle": patch
"@chatpack/next": patch
---

Docs-only release — third round of README improvements from external
integration feedback:

- Concrete cookie-based `auth` example replacing the `getSessionUser`
  pseudocode, with an explicit recommendation to use cookies (EventSource
  cannot send custom headers).
- SSE browser examples are now TypeScript-correct (`MessageEvent` cast for
  custom event names) and include `onerror` handling for fatal vs
  retryable failures.
- New note: `otherUserId` is not validated to exist (Chatpack has no users
  table) — validate recipient ids yourself.
- New note: timestamps are `Date` server-side but ISO strings over HTTP.
- `StorageAdapter` contract summarized as a method table in the core README.

No code changes.
