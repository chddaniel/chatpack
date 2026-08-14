import { Pool, neonConfig } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-serverless";
import ws from "ws";

import * as schema from "@/db/schema.js";
import { env } from "@/lib/env.js";

neonConfig.webSocketConstructor = ws;

// Opt-in: run against a plain Postgres (Docker, Postgres.app, a managed box)
// instead of Neon. The Neon driver speaks Postgres over a WebSocket that Neon's
// own edge terminates, so a local server needs a small bridge in front of port
// 5432 - `db:proxy` starts one. Leave NEON_WS_PROXY unset and none of this runs,
// which is what you want in production.
if (process.env.NEON_WS_PROXY) {
  const proxy = process.env.NEON_WS_PROXY;
  neonConfig.wsProxy = () => `${proxy}/v2`;
  neonConfig.useSecureWebSocket = false;
  neonConfig.pipelineConnect = false;
  neonConfig.pipelineTLS = false;
}

const globalForDb = globalThis as typeof globalThis & { chatpackPool?: Pool };
export const pool = globalForDb.chatpackPool ?? new Pool({ connectionString: env.DATABASE_URL });
if (process.env.NODE_ENV !== "production") globalForDb.chatpackPool = pool;

export const db = drizzle({ client: pool, schema });
