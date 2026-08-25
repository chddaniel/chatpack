import { headers } from "next/headers";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";

import { accounts, sessions, users, verifications } from "@/db/auth-schema";
import { db } from "@/lib/db";

function socialProviderCredentials(
  provider: "Google" | "GitHub",
): { clientId: string; clientSecret: string } | undefined {
  const prefix = provider.toUpperCase();
  const clientId = process.env[`${prefix}_CLIENT_ID`];
  const clientSecret = process.env[`${prefix}_CLIENT_SECRET`];
  if (!clientId && !clientSecret) return undefined;
  if (!clientId || !clientSecret) {
    throw new Error(
      `${prefix}_CLIENT_ID and ${prefix}_CLIENT_SECRET must both be set to enable ${provider} sign-in.`,
    );
  }
  return { clientId, clientSecret };
}

const google = socialProviderCredentials("Google");
const github = socialProviderCredentials("GitHub");

export const auth = betterAuth({
  database: drizzleAdapter(db, {
    provider: "pg",
    schema: {
      user: users,
      session: sessions,
      account: accounts,
      verification: verifications,
    },
  }),
  emailAndPassword: {
    enabled: true,
    requireEmailVerification: false,
  },
  socialProviders: {
    ...(google ? { google } : {}),
    ...(github ? { github } : {}),
  },
});

export async function currentUser() {
  const session = await auth.api.getSession({ headers: await headers() });
  return session?.user ?? null;
}
