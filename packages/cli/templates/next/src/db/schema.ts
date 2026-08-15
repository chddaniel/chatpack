export * from "@chatpack/adapter-drizzle";
export * from "@/db/auth-schema";

// Filepack's four attachment tables are deliberately NOT re-exported here, and
// that is load-bearing rather than an oversight.
//
// `@filepack/adapter-drizzle` is ESM-only: its `exports` map has an `import`
// condition and no `require` one, and no `main`. drizzle-kit loads this file
// through CJS, so importing that package here makes it fail to read the schema
// at all - and it reports that failure by printing a stack trace and then
// **exiting 0**, so `db:generate` looks like it worked while emitting no
// migration whatsoever. A starter that silently creates no tables is worse than
// one that refuses to generate.
//
// Filepack owns that schema anyway. It ships the ordered, idempotent DDL as
// `migrationStatements`, which `scripts/filepack-migrate.ts` applies and
// `db:migrate` runs right after drizzle-kit. Keeping the tables out of this file
// is also what stops drizzle-kit from trying to manage them: it diffs this file
// against its own snapshot under `drizzle/meta`, so tables it has never seen are
// none of its business.
