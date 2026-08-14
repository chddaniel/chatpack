# @chatpack/file

`@chatpack/file` connects Chatpack messages to Filepack files. Filepack owns
storage, records, upload routes, and file authorization. Chatpack stores only
stable file IDs and verified display metadata.

## Server

Create one Filepack instance with a route schema whose parsed output contains a
`conversationId` (or `metadata.conversationId`). Configure Filepack's
`authorizeFile` hook to allow read and download only when the file belongs to a
conversation that the actor may read. Then mount the integration plugin:

```ts
const files = createFileAttachmentPlugin({
  filepack,
  authorizeUpload: ({ actor, conversationId }) => canWrite({ userId: actor.id, conversationId }),
  authorizeAttachment: ({ actor, conversationId, file }) =>
    canWrite({ userId: actor.id, conversationId, fileId: file.id }),
});

const chat = chatpack({
  storage,
  auth,
  plugins: [files],
});
```

Filepack routes mount below Chatpack's handler base path at `/files` by
default. Metadata and download-target requests require
`?conversationId=...`; the plugin calls `chat.api.getConversation()` before
forwarding them, so Chatpack `canRead` remains authoritative. Upload plan
requests require the conversation association in Filepack route input and run
the host upload policy before Filepack creates a record.

Local Filepack transfer targets use Chatpack's trusted capability hook. It
claims only these exact routes below the configured Chatpack base path, with no
query string:

- `PUT /files/uploads/:attemptId/content`
- `PUT /files/uploads/:attemptId/parts/:partNumber/content`
- `GET /files/downloads/v1.<nonempty-capability>`

The context is read-only and excludes the Chatpack API and authenticated user.
The original request, including headers, body, and Range, reaches Filepack
unchanged. Filepack validates every short-lived capability or upload attempt.
Planning, status, part preparation/recording, completion, abort, metadata,
deletion, and download-target creation stay authenticated and
conversation-authorized. Owner-bound attempt controls use Filepack actor
ownership and the route metadata fixed during planning; they do not require a
conversation id. Unknown routes and `DELETE /files/:id` are not forwarded.
Browser media uses the opaque download URL; the client does not add app auth
headers or proxy media into blobs.

Use `createFileAttachmentMetadata(readyFiles)` for message metadata. The
metadata contains `{ id, name, contentType, size }` only. It never contains a
signed URL, object key, capability, or credential. Deleted, unavailable, and
cross-conversation files resolve as unavailable. Deleting a Chatpack message
never deletes a Filepack file.

## Browser client

```ts
import { createChatpackFileClient } from "@chatpack/file/client";

const files = createChatpackFileClient({
  basePath: "/api/chat/files",
  // Required with @filepack/client <= 0.1.1 in a browser - see below.
  controlFetch: (input, init) => fetch(input, init),
});
const resolved = await files.resolveTarget({ conversationId, fileId });
```

**Pass `controlFetch` explicitly while `@filepack/client` is at or below
0.1.1.** It stores `globalThis.fetch` unbound and later invokes it as a method,
which Chrome's brand check rejects with "Illegal invocation". The failure is
mislabeled `CLIENT_NETWORK_ERROR` and no HTTP request is ever sent, so it looks
like a network or CORS problem rather than a call-site bug. Node's `fetch` is
lenient about this, which is why it only breaks in browsers. Wrapping the call
(`(input, init) => fetch(input, init)`) restores the correct receiver and fixes
every upload.

Resolution is lazy and cached by conversation plus file ID. Available targets
are reused while valid and refreshed automatically shortly before `expiresAt`.
Use `force: true` to refresh a target immediately. Unavailable results remain
cached until `clearFileCache` clears them. Images, audio, and video request
Filepack's explicit safe `inline` delivery; other MIME types use `attachment`.
If the Filepack instance narrows its inline allowlist, the client falls back to
attachment delivery. Filepack remains the source of all short-lived targets.

## Scope

This package does not implement storage providers, record stores, migrations,
message deletion cascades, or a second file lifecycle.

## Community

- **[Discord](https://discord.gg/gY3GCTRv5Y)** — chat with the team and other developers
- **[X](https://x.com/chatpackdev)** — releases and updates
- **[Docs](https://docs.chatpack.dev)** — the full documentation site
- **[GitHub Discussions](https://github.com/chddaniel/chatpack/discussions)** — questions, show-and-tell, and feedback
