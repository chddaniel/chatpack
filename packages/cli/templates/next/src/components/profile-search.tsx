"use client";

import { useEffect, useState } from "react";
import { Search } from "lucide-react";
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

export interface PublicProfile {
  id: string;
  name: string;
  image: string | null;
}

export function ProfileSearch({
  onSelect,
}: {
  onSelect: (profile: PublicProfile) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [profiles, setProfiles] = useState<PublicProfile[]>([]);

  useEffect(() => {
    if (!open || query.trim().length < 2) return;
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      try {
        const response = await fetch(`/api/profiles?q=${encodeURIComponent(query)}`, {
          signal: controller.signal,
        });
        if (response.ok) {
          const body = (await response.json()) as { profiles: PublicProfile[] };
          setProfiles(body.profiles);
        }
      } catch {
        if (!controller.signal.aborted) setProfiles([]);
      }
    }, 250);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [open, query]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="icon" variant="outline" aria-label="New conversation">
          <Search />
        </Button>
      </DialogTrigger>
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
                    setOpen(false);
                    setQuery("");
                    setProfiles([]);
                  }}
                >
                  <Avatar>
                    <AvatarImage src={profile.image ?? undefined} />
                    <AvatarFallback>{profile.name.slice(0, 2).toUpperCase()}</AvatarFallback>
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
