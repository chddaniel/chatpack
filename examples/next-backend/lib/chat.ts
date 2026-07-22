/**
 * The Chatpack server instance — exactly the quickstart from the root README.
 *
 * In-memory storage keeps the example zero-setup; swap in
 * `drizzleAdapter(db)` from `@chatpack/adapter-drizzle` for Postgres.
 *
 * DEMO AUTH ONLY: we trust an `x-user-id` header so you can drive the API
 * with curl. In a real app, resolve your session/JWT here — this hook is the
 * single auth touchpoint in Chatpack.
 */
import { chatpack } from "@chatpack/core";
import { memoryAdapter } from "@chatpack/adapter-memory";

export const chat = chatpack({
  storage: memoryAdapter(),
  auth: (request) => {
    const userId = request.headers.get("x-user-id");
    return userId ? { id: userId } : null;
  },
});
