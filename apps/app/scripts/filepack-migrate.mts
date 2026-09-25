/**
 * Create Filepack's attachment tables.
 *
 * These four tables are not part of `src/db/schema.ts`, so `db:generate` never
 * emits them and `drizzle-kit migrate` never applies them - see the comment in
 * that file for why. Filepack publishes the DDL itself as an ordered list of
 * statements and leaves applying it to the host, which is this script's whole
 * job. `db:migrate` runs it straight after drizzle-kit.
 *
 * Every statement is idempotent (`IF NOT EXISTS`, guarded `DO` blocks, backfills
 * that filter on `IS NULL`), so running this repeatedly is safe and is the
 * intended way to pick up a Filepack upgrade.
 *
 * Two connection notes:
 *
 * - It reuses `src/lib/db.ts`, so unlike drizzle-kit it **does** honour
 *   `NEON_WS_PROXY` and works against a local Postgres.
 * - `--print` writes the SQL to stdout instead of connecting, for the case where
 *   you apply schema changes with `psql` rather than from the app.
 */
import { config } from "dotenv";
import { sql } from "drizzle-orm";
import { migrationSql, migrationStatements } from "@filepack/adapter-drizzle";

config({ path: process.env.NODE_ENV === "production" ? ".env" : ".env.local" });
config();

if (process.argv.includes("--print")) {
  console.log(migrationSql);
  process.exit(0);
}

const { db, pool } = await import("../src/lib/db.js");

try {
  for (const statement of migrationStatements) {
    await db.execute(sql.raw(statement));
  }
  console.log(`Filepack schema is up to date (${migrationStatements.length} statements applied).`);
} finally {
  await pool.end();
}
