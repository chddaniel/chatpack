import { redirect } from "next/navigation";

import { InviteAccept } from "@/components/invite-accept";
import { currentUser } from "@/lib/auth";

export const runtime = "nodejs";

export default async function InvitePage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  const user = await currentUser();
  // Signing in has to come first: an invite grants membership to a user id, so
  // there is nobody to add until we know who is holding the link. Returning to
  // the invite afterwards is your auth provider's redirect story, not
  // Chatpack's - the code survives in the URL, so the link works on a second
  // click either way.
  if (!user) redirect("/sign-in");
  return (
    <InviteAccept
      code={code}
      user={{ id: user.id, name: user.name ?? "User", image: user.image ?? null }}
    />
  );
}
