"use client";

import { useEffect, useState } from "react";
import { MessageSquarePlus, Search } from "lucide-react";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { initialsOf, searchProfiles, type PublicProfile } from "@/lib/profiles";

/**
 * Picks a person from *your* users table to start a direct message with.
 *
 * Chatpack has no users table to search - it only ever stores ids - so this hits
 * `/api/profiles`, which is your own route over your own schema.
 */
export function ProfileSearch({
  onSelect,
  open: controlledOpen,
  onOpenChange: controlledOnOpenChange,
  hideTrigger = false,
  triggerLabel,
  triggerClassName,
}: {
  onSelect: (profile: PublicProfile) => Promise<void>;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  hideTrigger?: boolean;
  /** Renders a labeled primary trigger instead of the compact icon trigger. */
  triggerLabel?: string;
  triggerClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [profiles, setProfiles] = useState<PublicProfile[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [retryCount, setRetryCount] = useState(0);
  const isOpen = controlledOpen ?? open;
  const setIsOpen = controlledOnOpenChange ?? setOpen;

  useEffect(() => {
    if (!isOpen || query.trim().length < 2) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setLoading(true);
      setError(false);
      void searchProfiles(query, controller.signal)
        // A response for a query the user has already changed must not overwrite
        // the current list, even if it arrived just before the abort landed.
        .then((found) => {
          if (!controller.signal.aborted) {
            setProfiles(found);
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
  }, [isOpen, query, retryCount]);

  return (
    <Dialog open={isOpen} onOpenChange={setIsOpen}>
      {!hideTrigger && (
        <DialogTrigger asChild>
          <Button
            size={triggerLabel === undefined ? "icon" : "sm"}
            variant={triggerLabel === undefined ? "outline" : "default"}
            className={triggerClassName}
            aria-label={triggerLabel ?? "New direct message"}
          >
            <MessageSquarePlus />
            {triggerLabel}
          </Button>
        </DialogTrigger>
      )}
      <DialogContent className="app-profile-search-dialog">
        <DialogHeader className="app-profile-search-header">
          <DialogTitle>New conversation</DialogTitle>
          <DialogDescription>Pick someone to message.</DialogDescription>
        </DialogHeader>
        <div className="app-profile-search-field-wrap">
          <Search aria-hidden="true" />
          <Input
            className="chatpack-ui-search-dialog-field app-profile-search-field"
            placeholder="Search name or exact email"
            aria-label="Search people"
            autoFocus
            value={query}
            onChange={(event) => {
              const value = event.target.value;
              setQuery(value);
              setProfiles([]);
              setLoading(value.trim().length >= 2);
              setError(false);
            }}
          />
        </div>
        <ScrollArea className="app-profile-search-body">
          {loading ? (
            <div className="app-profile-search-loading" aria-busy="true">
              {[0, 1, 2, 3].map((index) => (
                <span key={index} />
              ))}
            </div>
          ) : error || query.trim().length < 2 || profiles.length === 0 ? (
            <div className="app-profile-search-state">
              {error ? (
                <>
                  <span>Couldn’t load people.</span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setRetryCount((count) => count + 1)}
                  >
                    Try again
                  </Button>
                </>
              ) : query.trim().length < 2 ? (
                "Enter at least two characters."
              ) : (
                "No people found."
              )}
            </div>
          ) : (
            <div className="app-profile-search-results">
              {profiles.map((profile) => (
                <button
                  type="button"
                  key={profile.id}
                  className="app-profile-search-result"
                  onClick={async () => {
                    await onSelect(profile);
                    setIsOpen(false);
                    setQuery("");
                    setProfiles([]);
                  }}
                >
                  <Avatar>
                    <AvatarImage src={profile.image ?? undefined} />
                    <AvatarFallback>{initialsOf(profile.name)}</AvatarFallback>
                  </Avatar>
                  <span>{profile.name}</span>
                </button>
              ))}
            </div>
          )}
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
