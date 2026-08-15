"use client";

import { createChatpackFileClient } from "@chatpack/file/client";
import type { FilepackSchema, UploadRoute } from "@filepack/core";

/**
 * The server's upload router, described by type only.
 *
 * Importing `@/lib/filepack` here would work in TypeScript and then drag
 * `@aws-sdk/client-s3` and `node:path` into the browser bundle. One line of
 * type is cheaper than that, and the shape is checked against the real router
 * the first time you call `upload`.
 */
type AttachmentRouter = { readonly attachment: UploadRoute<FilepackSchema> };

/**
 * Limits mirrored from `src/lib/filepack.ts` so the UI can refuse a file before
 * uploading it. **Keep the two in sync** - the server is the one that enforces
 * them, and it answers 400 for anything over.
 */
export const MAX_ATTACHMENTS_PER_MESSAGE = 5;
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
export const ACCEPTED_ATTACHMENT_TYPES = [
  "image/*",
  "video/mp4",
  "audio/*",
  "application/pdf",
  "text/plain",
];

/** Value for a file input's `accept` attribute. */
export const ATTACHMENT_ACCEPT_ATTRIBUTE = ACCEPTED_ATTACHMENT_TYPES.join(",");

export function createApplicationFileClient() {
  return createChatpackFileClient<AttachmentRouter>({
    // Filepack mounts below Chatpack's own base path, so this follows whatever
    // the catch-all route is mounted at.
    basePath: "/api/chat/files",
    // Required while `@filepack/client` is at or below 0.1.1: it stores
    // `globalThis.fetch` unbound and calls it as a method, which Chrome rejects
    // with "Illegal invocation" reported as CLIENT_NETWORK_ERROR. Wrapping the
    // call restores the right receiver.
    controlFetch: (input, init) => fetch(input, init),
  });
}

/** The file client type, so components can accept one without re-deriving it. */
export type ApplicationFileClient = ReturnType<typeof createApplicationFileClient>;
