import { resolve } from "node:path";

import { S3Client } from "@aws-sdk/client-s3";
import type { Pool } from "@neondatabase/serverless";
import { drizzleAdapter, filepackRecordsSchema } from "@filepack/adapter-drizzle";
import {
  createFilepack,
  route,
  type FilepackApi,
  type FilepackSchema,
  type ObjectStorage,
} from "@filepack/core";
import { localAdapter } from "@filepack/storage-local";
import { s3Adapter } from "@filepack/storage-s3";
import { drizzle } from "drizzle-orm/neon-serverless";

/** Maximum files one message may carry. Chatpack's own ceiling is 32. */
export const MAX_ATTACHMENTS_PER_MESSAGE = 5;

/** Largest single upload accepted, in bytes. */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

/** Media types the upload route accepts. Wildcards are matched by Filepack. */
export const ACCEPTED_ATTACHMENT_TYPES = [
  "image/*",
  "video/mp4",
  "audio/*",
  "application/pdf",
  "text/plain",
] as const;

/**
 * Binds every upload to one conversation.
 *
 * Filepack stores the parsed output as the file's `routeMetadata`, and
 * `@chatpack/file` refuses to attach a file whose metadata names a different
 * conversation than the message being sent. Without this schema there is no
 * association to check, so attachments would not work at all.
 *
 * This is a hand-written Standard Schema so the starter does not pull in a
 * validation library for one field. Swap in Zod, Valibot, or ArkType by
 * passing their schema here instead - Filepack accepts any Standard Schema v1
 * validator.
 */
const conversationRouteInput = {
  "~standard": {
    version: 1 as const,
    vendor: "chatpack-starter",
    validate: (value: unknown) => {
      const conversationId =
        typeof value === "object" && value !== null
          ? (value as { conversationId?: unknown }).conversationId
          : undefined;
      if (typeof conversationId !== "string" || conversationId.length === 0) {
        return { issues: [{ message: "conversationId is required.", path: ["conversationId"] }] };
      }
      return { value: { conversationId } };
    },
  },
} as FilepackSchema;

/** The one upload route this application exposes. */
export const attachmentRoutes = {
  attachment: route({
    input: conversationRouteInput,
    accepts: ACCEPTED_ATTACHMENT_TYPES,
    maxFileSize: MAX_ATTACHMENT_BYTES,
    maxFileCount: MAX_ATTACHMENTS_PER_MESSAGE,
  }),
} as const;

/** Router type the browser client is generic over. */
export type AttachmentRoutes = typeof attachmentRoutes;

/**
 * Local disk unless S3 is configured.
 *
 * `localAdapter` keeps upload and download capabilities in memory, so it only
 * works for a single development process - it is not a deployment target. Set
 * `S3_BUCKET` and the credentials beside it and the same code talks to any
 * S3-compatible bucket, including Cloudflare R2, Backblaze B2, and MinIO.
 *
 * `s3Adapter` takes a constructed `S3Client`, so `@aws-sdk/client-s3` must
 * resolve to the **same copy** `@filepack/storage-s3` depends on - that is why
 * `package.json` pins the exact version rather than a range. Two copies install
 * side by side and the client built from one is not the type the other accepts,
 * which shows up as a wall of `S3Client is not assignable to S3Client`. If you
 * bump `@filepack/storage-s3`, read its pinned `@aws-sdk/client-s3` version and
 * match it here.
 */
function objectStorage(): ObjectStorage {
  const bucket = process.env.S3_BUCKET;
  if (!bucket) {
    return localAdapter({
      directory: resolve(process.cwd(), process.env.FILE_STORAGE_DIRECTORY ?? ".chatpack-files"),
    });
  }
  const accessKeyId = process.env.S3_ACCESS_KEY_ID;
  const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY;
  const endpoint = process.env.S3_ENDPOINT;
  return s3Adapter({
    bucket,
    client: new S3Client({
      // R2 and most S3-compatible providers ignore the region but require one
      // to be present; "auto" is what Cloudflare documents.
      region: process.env.S3_REGION ?? "auto",
      // A custom endpoint means a non-AWS provider, and path-style addressing
      // is the form all of them accept.
      ...(endpoint === undefined ? {} : { endpoint, forcePathStyle: true }),
      // Omitted entirely when unset so the SDK's own credential chain (IAM
      // roles, instance profiles) still works on AWS.
      ...(accessKeyId !== undefined && secretAccessKey !== undefined
        ? { credentials: { accessKeyId, secretAccessKey } }
        : {}),
    }),
  });
}

function conversationIdOf(routeMetadata: unknown): string | null {
  if (typeof routeMetadata !== "object" || routeMetadata === null) return null;
  const value = (routeMetadata as { conversationId?: unknown }).conversationId;
  return typeof value === "string" && value.length > 0 ? value : null;
}

export interface ApplicationFilepackOptions {
  /**
   * The same connection pool Chatpack stores messages in.
   *
   * A pool rather than the `db` from `src/lib/db.ts`, because Filepack's record
   * store is typed as `PgDatabase<_, typeof filepackRecordsSchema>` - a Drizzle
   * instance whose schema **is** Filepack's four tables. The application's `db`
   * is built from `src/db/schema.ts`, which deliberately leaves those tables out
   * (drizzle-kit cannot load the ESM-only package they come from; the comment in
   * that file has the details), so it is not that type and never will be.
   *
   * So Filepack gets its own Drizzle instance over the same pool, built below
   * from the `filepackRecordsSchema` it publishes for exactly this purpose. It
   * is a thin wrapper, not a second connection - both share this pool, and the
   * two libraries were already opening separate transactions on it anyway.
   */
  readonly pool: Pool;
  /**
   * Whether this user may read the conversation a file is bound to.
   *
   * Passed in rather than imported because the answer comes from the Chatpack
   * instance, and that instance takes the plugin built from this Filepack -
   * wiring it the other way round would be a circular import.
   */
  readonly canAccessConversation: (input: {
    userId: string;
    conversationId: string;
  }) => Promise<boolean>;
}

/**
 * Builds the Filepack instance that backs message attachments.
 *
 * Filepack owns the bytes, the records, and every short-lived URL. Chatpack
 * stores only `{ id, name, contentType, size }` in message metadata, so a file
 * can never leak through message history.
 */
export function createApplicationFilepack(
  options: ApplicationFilepackOptions,
): FilepackApi<AttachmentRoutes> {
  return createFilepack({
    routes: attachmentRoutes,
    records: drizzleAdapter(drizzle({ client: options.pool, schema: filepackRecordsSchema })),
    storage: objectStorage(),
    // Filepack defaults to owner-only access, which would let the uploader see
    // an attachment and nobody else. Everyone who can read the conversation
    // gets metadata and downloads instead - Chatpack's own `canRead` stays
    // authoritative. Deleting the bytes stays with whoever uploaded them.
    authorizeFile: async ({ actor, file, action }) => {
      if (file.ownerId === actor.id) return true;
      if (action === "delete") return false;
      const conversationId = conversationIdOf(file.routeMetadata);
      if (conversationId === null) return false;
      return options.canAccessConversation({ userId: actor.id, conversationId });
    },
  });
}
