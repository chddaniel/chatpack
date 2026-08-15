"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { resolveProfiles, shortenUserId, type PublicProfile } from "@/lib/profiles";

export interface ProfileDirectory {
  /** Everything resolved so far, keyed by user id. */
  profiles: Record<string, PublicProfile>;
  /**
   * Ask for these ids. Safe to call on every render with the same list:
   * duplicates and already-requested ids cost nothing.
   */
  ensure: (userIds: readonly string[]) => void;
  /** Seed a profile you already hold, e.g. the person you just searched for. */
  put: (profile: PublicProfile) => void;
  /** Display name for an id, falling back to a fragment of the id itself. */
  nameOf: (userId: string) => string;
}

/**
 * Resolves Chatpack user ids to names and avatars, batched and cached.
 *
 * Every id is requested at most once per mount, and ids that arrive in the same
 * tick go out in one request - a conversation list rendering fifty rows should
 * not produce fifty round trips.
 */
export function useProfileDirectory(viewer: PublicProfile): ProfileDirectory {
  const [profiles, setProfiles] = useState<Record<string, PublicProfile>>(() => ({
    [viewer.id]: viewer,
  }));
  // Guards `setProfiles` after unmount, since a batch can still be in flight.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const resolver = useMemo(() => {
    const requested = new Set<string>([viewer.id]);
    const queue = new Set<string>();
    let scheduled: ReturnType<typeof setTimeout> | null = null;

    function schedule(): void {
      if (scheduled !== null) return;
      scheduled = setTimeout(() => void flush(), 0);
    }

    async function flush(): Promise<void> {
      scheduled = null;
      // The route accepts at most 100 ids; the rest go out on the next pass.
      const batch = [...queue].slice(0, 100);
      for (const userId of batch) queue.delete(userId);
      if (batch.length === 0) return;
      try {
        const resolved = await resolveProfiles(batch);
        if (mounted.current && resolved.length > 0) {
          setProfiles((current) => ({
            ...current,
            ...Object.fromEntries(resolved.map((profile) => [profile.id, profile])),
          }));
        }
      } catch {
        // Offline, or the tab navigated away mid-request. The ids stay
        // unresolved and render as shortened ids rather than blocking a screen.
      }
      if (queue.size > 0) schedule();
    }

    return {
      ensure(userIds: readonly string[]): void {
        let added = false;
        for (const userId of userIds) {
          if (userId.length === 0 || requested.has(userId)) continue;
          requested.add(userId);
          queue.add(userId);
          added = true;
        }
        if (added) schedule();
      },
      put(profile: PublicProfile): void {
        requested.add(profile.id);
        if (mounted.current) {
          setProfiles((current) => ({ ...current, [profile.id]: profile }));
        }
      },
    };
  }, [viewer.id]);

  const nameOf = useCallback(
    (userId: string) => profiles[userId]?.name ?? shortenUserId(userId),
    [profiles],
  );

  return useMemo(
    () => ({ profiles, ensure: resolver.ensure, put: resolver.put, nameOf }),
    [nameOf, profiles, resolver],
  );
}
