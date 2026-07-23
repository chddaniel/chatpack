---
"@chatpack/core": patch
"@chatpack/adapter-memory": patch
"@chatpack/adapter-drizzle": patch
"@chatpack/next": patch
---

Docs-only release — second round of README improvements from external
integration feedback:

- Documented allowed `role` values (`"user" | "assistant" | "system"`,
  default `"user"`; anything else is a 400).
- Message ordering (newest first) is now stated in the REST response column
  and as an explicit note, not just the query column.
- New deployment warning: the default in-process transport and
  `memoryAdapter` require one long-lived process — on serverless/edge
  (Workers, Lambda) use a database adapter and poll instead of `/stream`.
- New browser-auth note: `EventSource` cannot send custom headers, so SSE
  auth must be cookie-based.
- Install note about Bun's `minimumReleaseAge` supply-chain guard resolving
  older versions right after a release.

No code changes.
