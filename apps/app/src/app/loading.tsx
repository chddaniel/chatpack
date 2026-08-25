import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <main className="grid min-h-screen place-items-center p-6">
      <div className="w-full max-w-5xl space-y-4">
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-[70vh] w-full" />
      </div>
    </main>
  );
}
