/**
 * CORS for a public, credential-free demo API.
 *
 * Because the demo identity travels in the URL (see `lib/chat.ts`) there are no
 * cookies to protect, so this can be the simple, permissive form:
 * `Access-Control-Allow-Origin: *` with NO `Allow-Credentials`. That pair is
 * what makes the API reachable from every AI-builder preview origin - and from
 * the throwaway origins those tools generate per project, which we could never
 * enumerate in an allowlist.
 *
 * Never copy this into a real app: a cookie-authenticated backend must reflect
 * a specific origin and send `Access-Control-Allow-Credentials: true`.
 */

const CORS_HEADERS: Readonly<Record<string, string>> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, PATCH, DELETE, OPTIONS",
  "access-control-allow-headers": "content-type, last-event-id",
  "access-control-max-age": "86400",
};

/** Copy the CORS headers onto a response (mutates and returns it). */
export function withCors(response: Response): Response {
  for (const [key, value] of Object.entries(CORS_HEADERS)) {
    response.headers.set(key, value);
  }
  return response;
}

/** Preflight response - browsers send OPTIONS before cross-origin JSON writes. */
export function corsPreflight(): Response {
  return withCors(new Response(null, { status: 204 }));
}

/** A JSON error shaped like Chatpack's own error envelope. */
export function jsonError(code: string, message: string, status: number): Response {
  return withCors(
    new Response(JSON.stringify({ error: { code, message } }), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );
}
