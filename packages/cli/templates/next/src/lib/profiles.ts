/**
 * The bridge between Chatpack's opaque user ids and your users table.
 *
 * Chatpack stores ids and nothing else - no names, no avatars, no users table,
 * ever. So every screen that wants to show a person has to ask *your* database
 * who that id is. `/api/profiles` is this starter's answer: a search route for
 * finding people and a batch route for resolving ids you already hold.
 */

export interface PublicProfile {
  id: string;
  name: string;
  image: string | null;
}

/** Searches your user directory by name, or by exact email. */
export async function searchProfiles(
  query: string,
  signal?: AbortSignal,
): Promise<PublicProfile[]> {
  const response = await fetch(`/api/profiles?q=${encodeURIComponent(query)}`, {
    ...(signal === undefined ? {} : { signal }),
  });
  if (!response.ok) return [];
  const body = (await response.json()) as { profiles: PublicProfile[] };
  return body.profiles;
}

/** Resolves up to 100 user ids in one request. Unknown ids are simply absent. */
export async function resolveProfiles(
  userIds: readonly string[],
  signal?: AbortSignal,
): Promise<PublicProfile[]> {
  const response = await fetch("/api/profiles", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ids: userIds }),
    ...(signal === undefined ? {} : { signal }),
  });
  if (!response.ok) return [];
  const body = (await response.json()) as { profiles: PublicProfile[] };
  return body.profiles;
}

/**
 * What to render for an id nobody could resolve - a user who was deleted, or a
 * participant whose row your app never wrote. Showing a fragment of the real id
 * beats "Unknown" when you are debugging why a name is missing.
 */
export function shortenUserId(userId: string): string {
  return userId.length > 8 ? `${userId.slice(0, 6)}…` : userId;
}

/** Two-letter avatar fallback for a name, or for a bare id. */
export function initialsOf(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) return "?";
  const [first, second] = trimmed.split(/\s+/);
  const letters = second ? `${first.slice(0, 1)}${second.slice(0, 1)}` : trimmed.slice(0, 2);
  return letters.toUpperCase();
}
