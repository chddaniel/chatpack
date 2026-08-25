import { redirect } from "next/navigation";

import { ModerationConsole } from "@/components/moderation-console";
import { currentUser } from "@/lib/auth";

export const runtime = "nodejs";

export default async function ModerationPage() {
  const user = await currentUser();
  if (!user) redirect("/sign-in");
  // Signed in is enough to reach this page: whether you may *use* the queue is
  // your `moderation.canModerate` hook's call, and the console renders whichever
  // answer the server gives.
  return (
    <ModerationConsole
      user={{ id: user.id, name: user.name ?? "User", image: user.image ?? null }}
    />
  );
}
