"use client";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

export default function ErrorPage({ reset }: { reset: () => void }) {
  return (
    <main className="grid min-h-screen place-items-center p-6">
      <Alert variant="destructive" className="max-w-lg">
        <AlertTitle>Chat could not load</AlertTitle>
        <AlertDescription className="flex items-center justify-between gap-4">
          Try again. If the problem continues, check the database and environment settings.
          <Button variant="outline" onClick={reset}>
            Retry
          </Button>
        </AlertDescription>
      </Alert>
    </main>
  );
}
