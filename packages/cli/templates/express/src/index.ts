import express from "express";
import { chatpackExpress } from "@/lib/chatpack-express.js";

const app = express();

// Chatpack must receive the raw request stream before body parsers.
app.use("/api/chat", chatpackExpress);
app.use(express.json());

app.get("/api/health", (_request, response) => response.json({ ok: true }));

export default app;

if (!process.env.VERCEL) {
  app.listen(Number(process.env.PORT ?? 3000));
}
