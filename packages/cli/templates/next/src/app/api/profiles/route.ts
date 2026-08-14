import { and, eq, ilike, inArray, ne, or } from "drizzle-orm";

import { profiles } from "@/db/schema";
import { currentUser } from "@/lib/auth";
import { db } from "@/lib/db";

export const runtime = "nodejs";

const publicProfile = { id: profiles.id, name: profiles.name, image: profiles.image };

/** Matches Chatpack's own error shape so one client error path handles both. */
function unauthenticated(): Response {
  return Response.json(
    {
      error: {
        code: "UNAUTHENTICATED",
        message: "No authenticated user for this request.",
      },
    },
    { status: 401 },
  );
}

/**
 * `%` and `_` are ILIKE wildcards, so a search for "%" would otherwise return
 * the first twenty rows of the user directory to anyone signed in.
 */
function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

export async function GET(request: Request): Promise<Response> {
  const viewer = await currentUser();
  if (!viewer) return unauthenticated();
  const query = new URL(request.url).searchParams.get("q")?.trim() ?? "";
  // This is a directory lookup, not discovery: require enough of a name that a
  // caller has to know who they are looking for.
  if (query.length < 2) return Response.json({ profiles: [] });
  const matches = await db
    .select(publicProfile)
    .from(profiles)
    .where(
      and(
        ne(profiles.id, viewer.id),
        or(ilike(profiles.name, `%${escapeLikePattern(query)}%`), eq(profiles.email, query)),
      ),
    )
    .limit(20);
  return Response.json({ profiles: matches });
}

export async function POST(request: Request): Promise<Response> {
  const viewer = await currentUser();
  if (!viewer) return unauthenticated();
  const body = (await request.json()) as { ids?: string[] };
  const ids = [...new Set(body.ids ?? [])].slice(0, 100);
  if (ids.length === 0) return Response.json({ profiles: [] });
  return Response.json({
    profiles: await db.select(publicProfile).from(profiles).where(inArray(profiles.id, ids)),
  });
}
