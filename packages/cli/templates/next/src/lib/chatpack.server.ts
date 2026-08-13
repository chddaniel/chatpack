import { drizzleAdapter } from "@chatpack/adapter-drizzle";
import { chatpack } from "@chatpack/core";
import { eq } from "drizzle-orm";

import { profiles } from "@/db/schema";
import { currentUser } from "@/lib/auth";
import { db } from "@/lib/db";

export const chat = chatpack({
  storage: drizzleAdapter(db),
  auth: async () => {
    const user = await currentUser();
    return user ? { id: user.id } : null;
  },
  userExists: async (userId: string) => {
    const [profile] = await db
      .select({ id: profiles.id })
      .from(profiles)
      .where(eq(profiles.id, userId))
      .limit(1);
    return Boolean(profile);
  },
});
