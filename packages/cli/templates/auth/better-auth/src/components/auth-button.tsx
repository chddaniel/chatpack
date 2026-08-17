"use client";

import { useRouter } from "next/navigation";
import { LogOut } from "lucide-react";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { authClient } from "@/lib/auth-client";

export function AuthButton({ user }: { user: { name: string; image: string | null } }) {
  const router = useRouter();
  async function signOut(): Promise<void> {
    await authClient.signOut();
    router.push("/sign-in");
    router.refresh();
  }
  return (
    <div className="flex items-center gap-3">
      <Avatar>
        <AvatarImage src={user.image ?? undefined} />
        <AvatarFallback>{user.name.slice(0, 2).toUpperCase()}</AvatarFallback>
      </Avatar>
      <span className="min-w-0 flex-1 truncate text-sm">{user.name}</span>
      <Button size="icon" variant="ghost" onClick={() => void signOut()} aria-label="Sign out">
        <LogOut />
      </Button>
    </div>
  );
}
