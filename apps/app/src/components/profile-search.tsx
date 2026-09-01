"use client";

import { useEffect, useState } from "react";
import { MessageSquarePlus } from "lucide-react";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
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
}: {
  onSelect: (profile: PublicProfile) => Promise<void>;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  hideTrigger?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [profiles, setProfiles] = useState<PublicProfile[]>([]);
  const isOpen = controlledOpen ?? open;
  const setIsOpen = controlledOnOpenChange ?? setOpen;

  useEffect(() => {
    if (!isOpen || query.trim().length < 2) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void searchProfiles(query, controller.signal)
        // A response for a query the user has already changed must not overwrite
        // the current list, even if it arrived just before the abort landed.
        .then((found) => {
          if (!controller.signal.aborted) setProfiles(found);
        })
        // Aborting is how this effect cancels an in-flight search, so the
        // rejection it causes is the intended outcome, not an error to report.
        .catch(() => undefined);
    }, 250);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [isOpen, query]);

  return (
    <Dialog open={isOpen} onOpenChange={setIsOpen}>
      {!hideTrigger && (
        <DialogTrigger asChild>
          <Button size="icon" variant="outline" aria-label="New direct message">
            <MessageSquarePlus />
          </Button>
        </DialogTrigger>
      )}
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Start a conversation</DialogTitle>
        </DialogHeader>
        <Command shouldFilter={false}>
          <CommandInput
            placeholder="Search name or exact email"
            value={query}
            onValueChange={setQuery}
          />
          <CommandList>
            <CommandEmpty>
              {query.length < 2 ? "Enter at least two characters." : "No people found."}
            </CommandEmpty>
            <CommandGroup>
              {(query.trim().length < 2 ? [] : profiles).map((profile) => (
                <CommandItem
                  key={profile.id}
                  value={profile.id}
                  onSelect={async () => {
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
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
