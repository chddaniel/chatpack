---
"@chatpack/adapter-drizzle": minor
---

Add `migrationStatements` export — the quick-start DDL as individual statements for drivers that execute one statement per call (Neon HTTP, Vercel Postgres, Cloudflare D1). `migrationSql` is unchanged and now derived from the same array, so the two can never drift.
