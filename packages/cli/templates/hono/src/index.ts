import { serve } from "@hono/node-server";
import { sql } from "drizzle-orm";
import { Hono } from "hono";
import { chat } from "@/lib/chatpack.js";
import { db } from "@/lib/db.js";

const app = new Hono();

// Built once at startup rather than per request: handler() rebuilds the whole
// route table and its closures on every call.
const handler = chat.handler();

// Readiness, not liveness - a health check that cannot fail tells a load
// balancer nothing, so this actually reaches the database.
app.get("/api/health", async (context) => {
  try {
    await db.execute(sql`select 1`);
    return context.json({ ok: true, database: "reachable" });
  } catch (error) {
    return context.json(
      { ok: false, database: "unreachable", message: (error as Error).message },
      503,
    );
  }
});

app.all("/api/chat/*", (context) => handler.fetch(context.req.raw));

export default app;

if (!process.env.VERCEL) {
  serve({ fetch: app.fetch, port: Number(process.env.PORT ?? 3000) });
}
