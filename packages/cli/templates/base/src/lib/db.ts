import { Pool, neonConfig } from "@neondatabase/serverless";
import { attachDatabasePool } from "@vercel/functions";
import { drizzle } from "drizzle-orm/neon-serverless";
import ws from "ws";

import * as schema from "@/db/schema.js";
import { env } from "@/lib/env.js";

neonConfig.webSocketConstructor = ws;

const globalForDb = globalThis as typeof globalThis & { chatpackPool?: Pool };
export const pool = globalForDb.chatpackPool ?? new Pool({ connectionString: env.DATABASE_URL });
if (process.env.NODE_ENV !== "production") globalForDb.chatpackPool = pool;
attachDatabasePool(pool);

export const db = drizzle({ client: pool, schema });
