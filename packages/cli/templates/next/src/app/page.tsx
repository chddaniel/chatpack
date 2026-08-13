import { redirect } from "next/navigation";

import { ChatShell } from "@/components/chat-shell";
import { currentUser } from "@/lib/auth";

export const runtime = "nodejs";

export default async function HomePage() {
  const user = await currentUser();
  if (!user) redirect("/sign-in");
  return <ChatShell user={{ id: user.id, name: user.name ?? "User", image: user.image ?? null }} />;
}
