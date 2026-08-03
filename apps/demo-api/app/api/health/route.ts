/** Liveness probe - also the quickest way to confirm CORS headers are landing. */
import { withCors } from "@/lib/cors";

export const dynamic = "force-dynamic";

export function GET(): Response {
  return withCors(
    new Response(JSON.stringify({ ok: true, service: "chatpack-demo-api" }), {
      headers: { "content-type": "application/json" },
    }),
  );
}

export const OPTIONS = (): Response => withCors(new Response(null, { status: 204 }));
