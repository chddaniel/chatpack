import { sql } from "drizzle-orm";
import express from "express";
import { chatpackExpress } from "@/lib/chatpack-express.js";
import { db } from "@/lib/db.js";

const app = express();

// Chatpack must receive the raw request stream before body parsers.
app.use("/api/chat", chatpackExpress);
app.use(express.json());

// Readiness, not liveness - a health check that cannot fail tells a load
// balancer nothing, so this actually reaches the database.
app.get("/api/health", async (_request, response) => {
  try {
    await db.execute(sql`select 1`);
    response.json({ ok: true, database: "reachable" });
  } catch (error) {
    response
      .status(503)
      .json({ ok: false, database: "unreachable", message: (error as Error).message });
  }
});

export default app;

if (!process.env.VERCEL) {
  app.listen(Number(process.env.PORT ?? 3000));
}
