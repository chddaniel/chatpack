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
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (query.trim().length < 2) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setLoading(true);
      setError(false);
      void searchProfiles(query, controller.signal)
        // A response for a query the user has already changed must not overwrite
        // the current list, even if it arrived just before the abort landed.
        .then((found) => {
          if (!controller.signal.aborted) {
            setResults(found);
            setLoading(false);
          }
        })
        // Aborting is how this effect cancels an in-flight search, so the
        // rejection it causes is the intended outcome, not an error to report.
        .catch(() => {
          if (!controller.signal.aborted) {
            setLoading(false);
            setError(true);
          }
        });
    }, 250);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [query]);

  const visible = results.filter((profile) => !exclude.includes(profile.id));

  return (
    <div className="app-profile-picker flex flex-col gap-2">
      <Input
        {...(id === undefined ? {} : { id })}
        className="app-profile-picker-input"
        value={query}
        onChange={(event) => {
          const nextQuery = event.target.value;
          setQuery(nextQuery);
          if (nextQuery.trim().length < 2) {
            setResults([]);
            setLoading(false);
            setError(false);
          }
        }}
        placeholder={placeholder}
      />
      {loading ? (
        <div className="app-profile-picker-state" role="status">
          Searching…
        </div>
      ) : error ? (
        <div className="app-profile-picker-state" role="alert">
          Couldn&apos;t load people. Try again.
        </div>
      ) : visible.length > 0 ? (
        <div className="app-profile-picker-results">
          {visible.map((profile) => (
            <button
              key={profile.id}
              onClick={() => {
                onPick(profile);
                setQuery("");
                setResults([]);
              }}
              className="app-profile-picker-result"
            >
              <Avatar size="sm">
                <AvatarImage src={profile.image ?? undefined} />
                <AvatarFallback>{initialsOf(profile.name)}</AvatarFallback>
              </Avatar>
              {profile.name}
            </button>
          ))}
        </div>
      ) : query.trim().length >= 2 ? (
        <div className="app-profile-picker-state">No one else here yet</div>
      ) : null}
    </div>
  );
}
