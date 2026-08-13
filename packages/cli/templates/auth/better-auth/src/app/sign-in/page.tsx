"use client";

import { FormEvent, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { authClient } from "@/lib/auth-client";

export default function SignInPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    const result = await authClient.signIn.email({ email, password });
    if (result.error) {
      toast.error(result.error.message);
      return;
    }
    router.push("/");
    router.refresh();
  }
  return (
    <main className="grid min-h-screen place-items-center p-6">
      <form
        onSubmit={(event) => void submit(event)}
        className="w-full max-w-sm rounded-xl border p-6 shadow-sm"
      >
        <h1 className="mb-6 text-2xl font-semibold">Sign in</h1>
        <FieldGroup>
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
          <Button type="submit">Sign in</Button>
          <FieldDescription>
            Need an account?{" "}
            <Link className="underline" href="/sign-up">
              Sign up
            </Link>
          </FieldDescription>
          <FieldDescription>
            Email verification is disabled in this starter. Enable it before public launch.
          </FieldDescription>
        </FieldGroup>
      </form>
    </main>
  );
}
