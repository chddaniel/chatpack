import { redirect } from "next/navigation";

import { ChatShell } from "@/components/chat-shell";
import { currentUser } from "@/lib/auth";
import { isModerator } from "@/lib/chatpack.server";

export const runtime = "nodejs";

export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<{ conversation?: string | string[] }>;
}) {
  const [user, params] = await Promise.all([currentUser(), searchParams]);
  if (!user) redirect("/sign-in");
  const initialConversationId =
    typeof params.conversation === "string" ? params.conversation : null;
  const moderator = await isModerator(user.id);
  return (
    <ChatShell
      user={{ id: user.id, name: user.name ?? "User", image: user.image ?? null }}
      initialConversationId={initialConversationId}
      isModerator={moderator}
    />
  );
}
