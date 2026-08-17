import { redirect } from "next/navigation";

import { ChannelDirectory } from "@/components/channel-directory";
import { currentUser } from "@/lib/auth";

export const runtime = "nodejs";

export default async function ChannelsPage() {
  const user = await currentUser();
  if (!user) redirect("/sign-in");
  return (
    <ChannelDirectory
      user={{ id: user.id, name: user.name ?? "User", image: user.image ?? null }}
    />
  );
}
