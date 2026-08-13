import { drizzleAdapter } from "@chatpack/adapter-drizzle";
import { chatpack } from "@chatpack/core";

import { db } from "@/lib/db.js";

// Replace this fail-closed resolver with your host application's verified session.
export const chat = chatpack({
  storage: drizzleAdapter(db),
  auth: async () => null,
});
