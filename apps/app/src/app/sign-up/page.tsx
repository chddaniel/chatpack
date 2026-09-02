import { EmailAuthForm } from "@/components/email-auth-form";
import { enabledSocialProviders } from "@/lib/auth-providers";

export const dynamic = "force-dynamic";

export default function SignUpPage() {
  return (
    <main className="grid min-h-screen place-items-center p-6">
      <EmailAuthForm mode="sign-up" socialProviders={enabledSocialProviders()} />
    </main>
  );
}
