import { config } from "dotenv";
import { sql } from "drizzle-orm";

config({ path: process.env.NODE_ENV === "production" ? ".env" : ".env.local" });
config();

const { db, pool } = await import("../src/lib/db.js");

try {
  await db.execute(sql`select 1`);
  console.log("Setup check passed: environment and Neon connection are ready.");
} finally {
  await pool.end();
}
