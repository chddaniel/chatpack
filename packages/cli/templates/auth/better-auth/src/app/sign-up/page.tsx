"use client";

import { FormEvent, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { authClient } from "@/lib/auth-client";

export default function SignUpPage() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    const result = await authClient.signUp.email({ name, email, password });
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
        <h1 className="mb-6 text-2xl font-semibold">Create account</h1>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="name">Name</FieldLabel>
            <Input
              id="name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              required
            />
          </Field>
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
          <Button type="submit">Sign up</Button>
          <FieldDescription>
            Already registered?{" "}
            <Link className="underline" href="/sign-in">
              Sign in
            </Link>
          </FieldDescription>
          <FieldDescription>
            Email verification is disabled. Do not use this choice for high-trust identity flows.
          </FieldDescription>
        </FieldGroup>
      </form>
    </main>
  );
}
