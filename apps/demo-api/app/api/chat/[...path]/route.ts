/**
 * The whole demo Chatpack API on one catch-all route.
 *
 * Every request is dispatched to the Chatpack instance for its sandbox, with a
 * per-request `basePath` so core strips `/api/chat/u/<sandbox>/<userId>` before
 * matching its own routes. That is the entire trick behind the URL-based demo
 * identity - core needs no changes to support it.
 */
import { chatFor, ensureSeeded, readIdentity } from "@/lib/chat";
import { corsPreflight, jsonError, withCors } from "@/lib/cors";

// SSE needs a long-lived connection, so this must not run as a static or
// short-lived function.
export const dynamic = "force-dynamic";
export const maxDuration = 300;

async function handle(request: Request): Promise<Response> {
  const identity = readIdentity(request);
  if (identity === null) {
    return jsonError(
      "UNAUTHENTICATED",
      "Demo backend: put your identity in the path - " +
        "/api/chat/u/<sandbox>/<userId>/... (e.g. /api/chat/u/my-app/alice/conversations). " +
        "See https://demo-api.chatpack.dev for the full recipe.",
      401,
    );
  }

  await ensureSeeded(identity);
  const handler = chatFor(identity).handler({ basePath: identity.basePath });
  return withCors(await handler.fetch(request));
}

export const GET = handle;
export const POST = handle;
export const PATCH = handle;
export const DELETE = handle;
export const OPTIONS = (): Response => corsPreflight();
