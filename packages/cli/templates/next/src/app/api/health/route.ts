import { sql } from "drizzle-orm";

import { db } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Readiness, not liveness: a health check that cannot fail tells a load
 * balancer nothing, so this actually reaches the database.
 */
export async function GET(): Promise<Response> {
  try {
    await db.execute(sql`select 1`);
    return Response.json({ ok: true, database: "reachable" });
  } catch (error) {
    return Response.json(
      { ok: false, database: "unreachable", message: (error as Error).message },
      { status: 503 },
    );
  }
}
