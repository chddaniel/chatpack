"use client";

import { LogOut } from "lucide-react";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";

export function AuthButton({ user }: { user: { name: string; image: string | null } }) {
  return (
    <div className="flex items-center gap-3">
      <Avatar>
        <AvatarImage src={user.image ?? undefined} />
        <AvatarFallback>{user.name.slice(0, 2).toUpperCase()}</AvatarFallback>
      </Avatar>
      <span className="min-w-0 flex-1 truncate text-sm">{user.name}</span>
      <Button asChild size="icon" variant="ghost">
        <a href="/auth/logout" aria-label="Sign out">
          <LogOut />
        </a>
      </Button>
    </div>
  );
}
