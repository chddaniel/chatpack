import { profiles } from "@/db/auth-schema";
import { auth0 } from "@/lib/auth0";
import { db } from "@/lib/db";

export async function currentUser() {
  const session = await auth0.getSession();
  const user = session?.user;
  if (!user?.sub) return null;
  const profile = {
    id: user.sub,
    name: user.name ?? user.nickname ?? "User",
    email: user.email ?? "",
    image: user.picture ?? null,
    updatedAt: new Date(),
  };
  await db
    .insert(profiles)
    .values(profile)
    .onConflictDoUpdate({
      target: profiles.id,
      set: {
        name: profile.name,
        email: profile.email,
        image: profile.image,
        updatedAt: profile.updatedAt,
      },
    });
  return profile;
}
