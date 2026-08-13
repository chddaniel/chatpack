"use client";

import { signIn } from "next-auth/react";
import { GitBranch } from "lucide-react";

import { Button } from "@/components/ui/button";

export default function SignInPage() {
  return (
    <main className="grid min-h-screen place-items-center p-6">
      <section className="w-full max-w-sm rounded-xl border p-6 text-center shadow-sm">
        <h1 className="text-2xl font-semibold">Sign in</h1>
        <p className="mt-2 mb-6 text-sm text-muted-foreground">
          Continue with your GitHub account.
        </p>
        <Button className="w-full" onClick={() => void signIn("github", { redirectTo: "/" })}>
          <GitBranch />
          Continue with GitHub
        </Button>
      </section>
    </main>
  );
}
