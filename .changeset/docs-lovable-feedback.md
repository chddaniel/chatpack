---
"@chatpack/core": patch
"@chatpack/adapter-memory": patch
"@chatpack/adapter-drizzle": patch
"@chatpack/next": patch
---

Docs-only release — README improvements from external integration feedback:

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
