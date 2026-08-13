import { and, eq, ilike, inArray, ne, or } from "drizzle-orm";

import { profiles } from "@/db/schema";
import { currentUser } from "@/lib/auth";
import { db } from "@/lib/db";

export const runtime = "nodejs";

const publicProfile = { id: profiles.id, name: profiles.name, image: profiles.image };

export async function GET(request: Request): Promise<Response> {
  const viewer = await currentUser();
  if (!viewer) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const query = new URL(request.url).searchParams.get("q")?.trim() ?? "";
  if (!query) return Response.json([]);
  const matches = await db
    .select(publicProfile)
    .from(profiles)
    .where(
      and(
        ne(profiles.id, viewer.id),
        or(ilike(profiles.name, `%${query}%`), eq(profiles.email, query)),
      ),
    )
    .limit(20);
  return Response.json(matches);
}

export async function POST(request: Request): Promise<Response> {
  const viewer = await currentUser();
  if (!viewer) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const body = (await request.json()) as { ids?: string[] };
  const ids = [...new Set(body.ids ?? [])].slice(0, 100);
  if (ids.length === 0) return Response.json([]);
  return Response.json(
    await db.select(publicProfile).from(profiles).where(inArray(profiles.id, ids)),
  );
}
