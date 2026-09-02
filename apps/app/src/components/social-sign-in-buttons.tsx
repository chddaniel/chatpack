"use client";

import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { authClient } from "@/lib/auth-client";
import type { SocialProvider } from "@/lib/auth-providers";

function GoogleIcon() {
  return (
    <svg className="size-4" viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M21.35 12.23c0-.7-.06-1.37-.18-2.02H12v3.82h5.24a4.48 4.48 0 0 1-1.94 2.94v2.45h3.15c1.85-1.7 2.9-4.2 2.9-7.19Z"
      />
      <path
        fill="#34A853"
        d="M12 21.75c2.65 0 4.87-.88 6.49-2.38l-3.15-2.45c-.88.59-2 .94-3.34.94-2.56 0-4.73-1.73-5.51-4.06H3.23v2.53A9.8 9.8 0 0 0 12 21.75Z"
      />
      <path
        fill="#FBBC05"
        d="M6.49 13.8A5.9 5.9 0 0 1 6.18 12c0-.63.11-1.24.31-1.8V7.67H3.23A9.75 9.75 0 0 0 2.25 12c0 1.57.38 3.05.98 4.33l3.26-2.53Z"
      />
      <path
        fill="#EA4335"
        d="M12 6.14c1.44 0 2.73.5 3.75 1.49l2.81-2.81C16.86 3.26 14.65 2.25 12 2.25a9.8 9.8 0 0 0-8.77 5.42l3.26 2.53c.78-2.33 2.95-4.06 5.51-4.06Z"
      />
    </svg>
  );
}

function GitHubIcon() {
  return (
    <svg className="size-4" viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="currentColor"
        d="M12 .3a12 12 0 0 0-3.79 23.39c.6.11.82-.26.82-.58v-2.04c-3.34.73-4.04-1.61-4.04-1.61-.55-1.39-1.33-1.76-1.33-1.76-1.09-.75.08-.74.08-.74 1.2.08 1.83 1.23 1.83 1.23 1.07 1.83 2.8 1.3 3.49.99.11-.77.42-1.3.76-1.6-2.67-.3-5.47-1.33-5.47-5.93 0-1.31.47-2.38 1.23-3.22-.12-.3-.53-1.52.12-3.18 0 0 1-.32 3.3 1.23a11.5 11.5 0 0 1 6 0c2.29-1.55 3.29-1.23 3.29-1.23.65 1.66.24 2.88.12 3.18a4.7 4.7 0 0 1 1.23 3.22c0 4.61-2.8 5.62-5.48 5.92.43.37.81 1.1.81 2.22v3.29c0 .32.22.69.83.57A12 12 0 0 0 12 .3Z"
      />
    </svg>
  );
}

export function SocialSignInButtons({ providers }: { providers: readonly SocialProvider[] }) {
  async function signIn(provider: SocialProvider): Promise<void> {
    const result = await authClient.signIn.social({ provider, callbackURL: "/" });
    if (result.error) toast.error(result.error.message);
  }

  return (
    <div className="grid gap-2 sm:grid-cols-2">
      {providers.includes("google") && (
        <Button type="button" variant="outline" onClick={() => void signIn("google")}>
          <GoogleIcon />
          Continue with Google
        </Button>
      )}
      {providers.includes("github") && (
        <Button type="button" variant="outline" onClick={() => void signIn("github")}>
          <GitHubIcon />
          Continue with GitHub
        </Button>
      )}
    </div>
  );
}
