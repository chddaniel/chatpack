"use client";

import { FormEvent, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { SocialSignInButtons } from "@/components/social-sign-in-buttons";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import type { SocialProvider } from "@/lib/auth-providers";
import { authClient } from "@/lib/auth-client";

export function EmailAuthForm({
  mode,
  socialProviders,
}: {
  mode: "sign-in" | "sign-up";
  socialProviders: readonly SocialProvider[];
}) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const isSignUp = mode === "sign-up";

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    const result = isSignUp
      ? await authClient.signUp.email({ name, email, password })
      : await authClient.signIn.email({ email, password });
    if (result.error) {
      toast.error(result.error.message);
      return;
    }
    router.push("/");
    router.refresh();
  }

  return (
    <form
      onSubmit={(event) => void submit(event)}
      className="w-full max-w-sm rounded-xl border p-6 shadow-sm"
    >
      <h1 className="mb-6 text-2xl font-semibold">{isSignUp ? "Create account" : "Sign in"}</h1>
      <FieldGroup>
        {isSignUp && (
          <Field>
            <FieldLabel htmlFor="name">Name</FieldLabel>
            <Input
              id="name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              required
            />
          </Field>
        )}
        <Field>
          <FieldLabel htmlFor="email">Email</FieldLabel>
          <Input
            id="email"
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            required
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="password">Password</FieldLabel>
          <Input
            id="password"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
            minLength={8}
          />
        </Field>
        <Button type="submit">{isSignUp ? "Sign up" : "Sign in"}</Button>
        {socialProviders.length > 0 && (
          <>
            <div className="relative py-1 text-center text-xs text-muted-foreground">
              <span className="bg-background px-2">or continue with</span>
            </div>
            <SocialSignInButtons providers={socialProviders} />
          </>
        )}
        <FieldDescription>
          {isSignUp ? "Already registered? " : "Need an account? "}
          <Link className="underline" href={isSignUp ? "/sign-in" : "/sign-up"}>
            {isSignUp ? "Sign in" : "Sign up"}
          </Link>
        </FieldDescription>
      </FieldGroup>
    </form>
  );
}
