"use client";

import { useEffect, useState } from "react";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Input } from "@/components/ui/input";
import { initialsOf, searchProfiles, type PublicProfile } from "@/lib/profiles";

/**
 * Inline "search your users table and pick someone" control.
 *
 * The ids come from your app, not from Chatpack - core has no users table to
 * search, so this talks to `/api/profiles` and hands back whatever your database
 * says.
 */
export function ProfilePicker({
  id,
  placeholder = "Search people",
  exclude = [],
  onPick,
}: {
  id?: string;
  placeholder?: string;
  /** Ids already chosen or already present, hidden from the results. */
  exclude?: readonly string[];
  onPick: (profile: PublicProfile) => void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<PublicProfile[]>([]);

  useEffect(() => {
    if (query.trim().length < 2) {
      setResults([]);
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void searchProfiles(query, controller.signal)
        // A response for a query the user has already changed must not overwrite
        // the current list, even if it arrived just before the abort landed.
        .then((found) => {
          if (!controller.signal.aborted) setResults(found);
        })
        // Aborting is how this effect cancels an in-flight search, so the
        // rejection it causes is the intended outcome, not an error to report.
        .catch(() => undefined);
    }, 250);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [query]);

  const visible = results.filter((profile) => !exclude.includes(profile.id));

  return (
    <div className="flex flex-col gap-2">
      <Input
        {...(id === undefined ? {} : { id })}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder={placeholder}
      />
      {visible.length > 0 && (
        <div className="max-h-40 overflow-y-auto rounded-lg border">
          {visible.map((profile) => (
            <button
              key={profile.id}
              onClick={() => {
                onPick(profile);
                setQuery("");
                setResults([]);
              }}
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-accent"
            >
              <Avatar size="sm">
                <AvatarImage src={profile.image ?? undefined} />
                <AvatarFallback>{initialsOf(profile.name)}</AvatarFallback>
              </Avatar>
              {profile.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
