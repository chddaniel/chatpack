import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { chat } from "@/lib/chatpack.js";

const app = new Hono();

app.get("/api/health", (context) => context.json({ ok: true }));
app.all("/api/chat/*", (context) => chat.handler().fetch(context.req.raw));

export default app;

if (!process.env.VERCEL) {
  serve({ fetch: app.fetch, port: Number(process.env.PORT ?? 3000) });
}
