# ADR 0018: Filepack-backed conversation attachments

- **Status:** accepted
- **Date:** 2026-08-04
- **Milestone:** v0.next (file attachments)

## Context

Chatpack messages need stable file references. Storage providers, upload
lifecycle, and object cleanup belong to Filepack. Chatpack must add the
conversation permission boundary and must not persist signed URLs, object keys,
or storage credentials.

Chat UIs also need media to render when a message loads. A normal attachment
download is not enough for images, audio, and video. Documents use attachment
delivery or a host-controlled preview until a trusted preview service exists.

## Decision

`@chatpack/file` is an independent Chatpack plugin. It mounts Filepack below
the Chatpack handler path, normally `/api/chat/files`, and stores only this
message metadata:

```ts
{
  filepack: {
    version: 1,
    attachments: [{ id, name, contentType, size }]
  }
}
```

Upload plans require a host upload policy and a route association containing a
conversation id. File metadata and download target requests require a
Chatpack-readable conversation and a matching Filepack route association.
Message sends validate that every referenced file is ready, authorized,
conversation-bound, and unchanged before persistence. Message deletion does
not delete files.

Filepack owns delivery policy. Attachment is the default. The browser client
requests inline delivery only for Filepack's explicit safe media allowlist and
falls back to attachment delivery when the host narrows that allowlist. Local
handler targets support one HTTP byte range for media seeking. No thumbnails,
transcoding, scanning, or public URLs are part of this milestone.

Filepack handler transfer targets use Chatpack's trusted capability plugin hook because
their short-lived capability is the complete authorization. `@chatpack/file`
claims only these exact nested routes, without a query string:

- `PUT /files/uploads/:attemptId/content`
- `PUT /files/uploads/:attemptId/parts/:partNumber/content`
- `GET /files/downloads/v1.<nonempty-capability>`

The read-only hook receives no Chatpack user, user id, domain API, or mutable
context and forwards the original request without changing headers, body, or
Range. Filepack validates the upload attempt or download capability. Upload
planning, status, part preparation and recording, completion, abort, file
metadata, deletion, and download-target creation remain authenticated
`handleRequest` routes and retain Chatpack conversation authorization.

The authenticated plugin forwards only the Filepack client/resume controls
`GET /uploads/:attemptId`, `POST /uploads/:attemptId/parts/prepare`,
`POST /uploads/:attemptId/parts/record`, `POST /uploads/:attemptId/complete`,
and `POST /uploads/:attemptId/abort`, plus the explicit list, metadata, and
download-target routes. Owner-bound attempt controls do not require a
conversation id: plan route metadata binds the attempt to the Chatpack
operation and Filepack actor ownership protects the attempt. Unknown routes
and `DELETE /files/:id` are not forwarded. Message deletion does not delete a
Filepack file; hosts can use the Filepack server API when they need that action.

## Consequences

- Hosts must configure Filepack `authorizeFile` to allow conversation members
  to read and download files; its default remains owner-only.
- Hosts must expose `PUT` from the Chatpack handler when Filepack uses local
  handler upload targets.
- Hosts must expose the Chatpack handler's capability route dispatch for
  local transfer targets. Browser XHR sends the capability header supplied by
  Filepack; media elements use the opaque download URL without app auth
  headers.
- A ready file can remain after an upload succeeds but message persistence
  fails. Filepack lifecycle cleanup remains independent; a later garbage
  collection policy can reclaim unattached files without a message cascade.
- Direct S3/R2 targets remain provider-signed. Handler targets remain short
  lived and private.

## Amendment (2026-08-09): three behaviours found by dogfooding

Recorded here because all three were discovered only by building a real app
against the published packages, and each one looks like a bug in the host's
code rather than a documented rule.

- **There are no attachment-only messages.** Core requires `body` to be a
  non-empty string after trimming, on send and on edit, so an image-only
  message is `400 INVALID_INPUT`. This follows from attachments living in
  metadata - they are a property of a message, never a substitute for one -
  but it was never stated, and an image-only composer is an obvious UI to
  build. Hosts must synthesize a body; whitespace will not do, since it is
  trimmed.
- **`@filepack/client` <= 0.1.1 breaks every browser upload unless the host
  passes `controlFetch`.** It stores `globalThis.fetch` unbound and invokes it
  as a method, which Chrome's brand check rejects; the error is caught and
  mislabeled `CLIENT_NETWORK_ERROR` with no request sent. Node's `fetch`
  tolerates the same call, which is why no test caught it. Reported upstream;
  documented in `llms.txt` and the `@chatpack/file` README until it is fixed.
- **Filepack's `complete`/`abort` controls demanded `request.body === null`,
  which Next.js App Router cannot satisfy** - it hands route handlers a
  present-but-empty body. Hosts were working around this with their own
  `stripEmptyBody()`. `@chatpack/file` now normalizes an empty body on exactly
  those two routes before forwarding, so the framework difference no longer
  reaches the host. A body carrying real bytes is still forwarded untouched and
  still rejected: this normalizes emptiness, it does not discard payloads.
  `parts/prepare` and `parts/record` genuinely take JSON and are excluded.
