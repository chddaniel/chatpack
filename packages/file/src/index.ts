/** Chatpack integration for Filepack-backed message attachments. */

import type {
  BeforeMessageSendContext,
  ChatpackPlugin,
  MessageHooks,
  PluginCapabilityRequestContext,
} from "@chatpack/core";
import type {
  FilepackActor,
  FilepackApi,
  FilepackFile,
  FilepackRouter,
  UploadFileDescriptor,
} from "@filepack/core";
import { DEFAULT_INLINE_CONTENT_TYPES } from "@filepack/core";

export const FILEPACK_METADATA_VERSION = 1 as const;
export const DEFAULT_FILE_MOUNT_PATH = "files";

const ATTACHMENT_KEYS = new Set(["id", "name", "contentType", "size"]);
const LIST_FILE_QUERY_KEYS = new Set(["conversationId", "cursor", "limit"]);

/** Stable file reference persisted in Chatpack message metadata. */
export interface FileAttachmentReference {
  readonly id: string;
  readonly name: string;
  readonly contentType: string;
  readonly size: number;
}

/** Filepack metadata shape stored in a Chatpack message. */
export interface FileAttachmentMetadata extends Record<string, unknown> {
  readonly filepack: {
    readonly version: typeof FILEPACK_METADATA_VERSION;
    readonly attachments: readonly FileAttachmentReference[];
  };
}

/** Result of resolving one file for rendering or download. */
export type ResolvedFileAttachment =
  | {
      readonly status: "available";
      readonly file: FilepackFile;
      readonly kind: "inline" | "attachment";
      readonly delivery: "inline" | "attachment";
      readonly url: string;
      readonly expiresAt: string;
    }
  | { readonly status: "unavailable"; readonly fileId: string };

export interface FileUploadAuthorizationContext {
  readonly actor: FilepackActor;
  readonly conversationId: string;
  readonly route: string;
  readonly routeInput: unknown;
  readonly files: readonly UploadFileDescriptor[];
}

export interface FileAttachmentAuthorizationContext {
  readonly actor: FilepackActor;
  readonly conversationId: string;
  readonly file: FilepackFile;
}

/** Options for the server-side Filepack integration. */
export interface FileAttachmentOptions<TRouter extends FilepackRouter> {
  /** Safe Filepack instance boundary. Storage and record stores stay host-owned. */
  readonly filepack: FilepackApi<TRouter>;
  /** One path segment nested below Chatpack's configured handler base path. */
  readonly mountPath?: string;
  /** Host policy for upload association. Return true only when canWrite allows it. */
  readonly authorizeUpload: (context: FileUploadAuthorizationContext) => boolean | Promise<boolean>;
  /** Optional host policy for attaching an already-ready file to a message. */
  readonly authorizeAttachment?: (
    context: FileAttachmentAuthorizationContext,
  ) => boolean | Promise<boolean>;
  /** Maximum references accepted in one message. Defaults to 32. */
  readonly maxAttachments?: number;
}

/** File integration plugin plus its blocking message hook. */
export interface FileAttachmentPlugin extends ChatpackPlugin {
  readonly beforeMessageSend: NonNullable<ChatpackPlugin["beforeMessageSend"]>;
}

/** Returns true for media types safe to offer as an inline rendering target. */
export function isInlineFileType(contentType: string): boolean {
  return (DEFAULT_INLINE_CONTENT_TYPES as readonly string[]).includes(contentType.toLowerCase());
}

/** Creates stable, provider-independent message metadata from ready files. */
export function createFileAttachmentMetadata(
  files: readonly Pick<FilepackFile, "id" | "name" | "contentType" | "size">[],
): FileAttachmentMetadata {
  const attachments = files.map(toReference);
  return {
    filepack: {
      version: FILEPACK_METADATA_VERSION,
      attachments,
    },
  };
}

/** Parses and validates the Filepack namespace in arbitrary Chatpack metadata. */
export function parseFileAttachmentMetadata(
  metadata: Record<string, unknown>,
  maxAttachments = 32,
): FileAttachmentMetadata | null {
  const value = metadata.filepack;
  if (value === undefined) return null;
  if (!isRecord(value) || value.version !== FILEPACK_METADATA_VERSION) {
    throw new Error("Invalid Filepack attachment metadata.");
  }
  if (!Array.isArray(value.attachments) || value.attachments.length > maxAttachments) {
    throw new Error("Invalid Filepack attachment metadata.");
  }

  const ids = new Set<string>();
  const attachments = value.attachments.map((attachment) => {
    if (!isRecord(attachment)) throw new Error("Invalid Filepack attachment metadata.");
    for (const key of Object.keys(attachment)) {
      if (!ATTACHMENT_KEYS.has(key)) throw new Error("Invalid Filepack attachment metadata.");
    }
    const reference = toReference(attachment);
    if (ids.has(reference.id)) {
      throw new Error("Invalid Filepack attachment metadata.");
    }
    ids.add(reference.id);
    return reference;
  });
  return {
    filepack: {
      version: FILEPACK_METADATA_VERSION,
      attachments,
    },
  };
}

/** Creates the Chatpack blocking hook used by `hooks.beforeMessageSend`. */
export function createFileAttachmentMessageHook<TRouter extends FilepackRouter>(
  options: FileAttachmentOptions<TRouter>,
): NonNullable<MessageHooks["beforeMessageSend"]> {
  const maxAttachments = options.maxAttachments ?? 32;
  if (!Number.isSafeInteger(maxAttachments) || maxAttachments < 1) {
    throw new Error("maxAttachments must be a positive safe integer.");
  }

  return async (context: BeforeMessageSendContext) => {
    const parsed = parseFileAttachmentMetadata(context.metadata, maxAttachments);
    if (parsed === null) return undefined;

    const actor: FilepackActor = context.user;
    const files = await Promise.all(
      parsed.filepack.attachments.map(async (attachment) => {
        let file: FilepackFile;
        try {
          file = await options.filepack.getFile({ actor, fileId: attachment.id });
        } catch {
          throw new Error("One or more attachments are unavailable.");
        }
        if (!hasConversationAssociation(file.routeMetadata, context.conversation.id)) {
          throw new Error("One or more attachments are unavailable.");
        }
        if (
          file.name !== attachment.name ||
          file.contentType !== attachment.contentType ||
          file.size !== attachment.size
        ) {
          throw new Error("Attachment metadata does not match the Filepack record.");
        }
        if (options.authorizeAttachment !== undefined) {
          let allowed = false;
          try {
            allowed = await options.authorizeAttachment({
              actor,
              conversationId: context.conversation.id,
              file,
            });
          } catch {
            allowed = false;
          }
          if (!allowed) throw new Error("Attachment is not allowed in this conversation.");
        }
        return file;
      }),
    );

    return {
      metadata: {
        ...context.metadata,
        ...createFileAttachmentMetadata(files),
      },
    };
  };
}

/** Creates a nested Filepack route plugin and its blocking message hook. */
export function createFileAttachmentPlugin<TRouter extends FilepackRouter>(
  options: FileAttachmentOptions<TRouter>,
): FileAttachmentPlugin {
  const mountPath = normalizeMountPath(options.mountPath ?? DEFAULT_FILE_MOUNT_PATH);
  const beforeMessageSend = createFileAttachmentMessageHook(options);

  const plugin: FileAttachmentPlugin = {
    name: "file",
    beforeMessageSend,

    async handleCapabilityRequest(context: PluginCapabilityRequestContext) {
      if (!isFilepackTransferRoute(context, mountPath)) return null;
      return filepackTransferHandler(options.filepack, `${context.basePath}/${mountPath}`).fetch(
        context.request,
      );
    },

    async handleRequest(context) {
      if (context.segments[0] !== mountPath) return null;

      const nestedBasePath = `${context.basePath}/${mountPath}`;
      const rest = context.segments.slice(1);
      const actor: FilepackActor = context.user ?? { id: context.userId };

      if (context.method === "POST" && rest.length === 1 && rest[0] === "uploads") {
        let body: Record<string, unknown>;
        try {
          body = await readJson(context.request);
        } catch {
          return errorResponse(400, "INVALID_REQUEST");
        }
        const conversationId = extractConversationId(body.routeInput);
        if (conversationId === undefined) return errorResponse(400, "INVALID_CONVERSATION");
        const route = typeof body.route === "string" ? body.route : "";
        let files: readonly UploadFileDescriptor[];
        try {
          files = parseUploadDescriptors(body.files);
        } catch {
          return errorResponse(400, "INVALID_REQUEST");
        }
        let allowed = false;
        try {
          allowed = await options.authorizeUpload({
            actor,
            conversationId,
            route,
            routeInput: body.routeInput,
            files,
          });
        } catch {
          allowed = false;
        }
        if (!allowed) return errorResponse(403, "FORBIDDEN_UPLOAD");

        const forwarded = new Request(stripConversationQuery(context.url).toString(), {
          method: "POST",
          headers: context.request.headers,
          body: JSON.stringify(body),
        });
        return filepackHandler(options.filepack, nestedBasePath, actor).fetch(forwarded);
      }

      if (rest.length === 1 && rest[0] === "files" && context.method === "GET") {
        const query = parseListFilesQuery(context.url);
        if (query === null) return errorResponse(400, "INVALID_REQUEST");
        const { conversationId } = query;
        if (conversationId === null || !(await canReadConversation(context, conversationId))) {
          return unavailableResponse();
        }
        const page = await options.filepack.listFiles({
          actor,
          ...(query.cursor !== undefined ? { cursor: query.cursor } : {}),
          ...(query.limit !== undefined ? { limit: query.limit } : {}),
        });
        return jsonResponse({
          files: page.files.filter((file) =>
            hasConversationAssociation(file.routeMetadata, conversationId),
          ),
          ...(page.nextCursor !== undefined ? { nextCursor: page.nextCursor } : {}),
        });
      }

      const fileId = rest[0] === "files" && rest[1] !== undefined ? decodeSegment(rest[1]) : null;
      const protectedFileRoute = fileId !== null && rest.length === 2 && context.method === "GET";
      const protectedDownloadRoute =
        fileId !== null && rest.length === 3 && rest[2] === "download" && context.method === "POST";

      if (protectedFileRoute || protectedDownloadRoute) {
        const conversationId = requiredConversationId(context.url);
        if (
          conversationId === null ||
          !(await canReadConversation(context, conversationId)) ||
          !(await fileBelongsToConversation(options.filepack, actor, fileId, conversationId))
        ) {
          return unavailableResponse();
        }
        const forwarded = new Request(
          stripConversationQuery(context.url).toString(),
          context.request,
        );
        return filepackHandler(options.filepack, nestedBasePath, actor).fetch(forwarded);
      }

      if (isOwnerBoundUploadControlRoute(context.method, rest)) {
        // The upload plan's route metadata binds the attempt to its intended
        // Chatpack operation. Filepack's actor ownership protects these
        // attempt controls; they do not have a conversationId contract.
        return filepackHandler(options.filepack, nestedBasePath, actor).fetch(context.request);
      }

      // Message deletion does not delete the Filepack record. Keep this route
      // unavailable until Chatpack and Filepack expose one coordinated action.
      if (context.method === "DELETE" && fileId !== null && rest.length === 2) {
        return unavailableResponse();
      }

      return null;
    },
  };
  return plugin;
}

function toReference(
  value: Pick<FilepackFile, "id" | "name" | "contentType" | "size"> | Record<string, unknown>,
): FileAttachmentReference {
  if (
    typeof value.id !== "string" ||
    value.id.length === 0 ||
    typeof value.name !== "string" ||
    value.name.length === 0 ||
    typeof value.contentType !== "string" ||
    !isConcreteMimeType(value.contentType) ||
    typeof value.size !== "number" ||
    !Number.isSafeInteger(value.size) ||
    value.size < 0
  ) {
    throw new Error("Invalid Filepack attachment metadata.");
  }
  return {
    id: value.id,
    name: value.name,
    contentType: value.contentType,
    size: value.size,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasConversationAssociation(value: unknown, conversationId: string): boolean {
  return extractConversationId(value) === conversationId;
}

function extractConversationId(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.conversationId === "string" && value.conversationId.length > 0) {
    return value.conversationId;
  }
  if (isRecord(value.metadata) && typeof value.metadata.conversationId === "string") {
    return value.metadata.conversationId.length > 0 ? value.metadata.conversationId : undefined;
  }
  return undefined;
}

function parseUploadDescriptors(value: unknown): readonly UploadFileDescriptor[] {
  if (!Array.isArray(value)) throw new Error("Invalid upload descriptors.");
  return value.map((item) => {
    if (!isRecord(item) || typeof item.name !== "string" || typeof item.type !== "string") {
      throw new Error("Invalid upload descriptors.");
    }
    if (typeof item.size !== "number" || !Number.isSafeInteger(item.size) || item.size < 0) {
      throw new Error("Invalid upload descriptors.");
    }
    return { name: item.name, type: item.type, size: item.size };
  });
}

function isConcreteMimeType(value: string): boolean {
  return /^[!#$%&'*+.^_`|~0-9A-Za-z-]+\/[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u.test(value);
}

function normalizeMountPath(value: string): string {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new Error("mountPath must be one URL path segment.");
  }
  return value;
}

function filepackHandler<TRouter extends FilepackRouter>(
  filepack: FilepackApi<TRouter>,
  basePath: string,
  actor: FilepackActor,
) {
  return filepack.handler({
    basePath,
    auth: () => actor,
  });
}

function filepackTransferHandler<TRouter extends FilepackRouter>(
  filepack: FilepackApi<TRouter>,
  basePath: string,
) {
  return filepack.handler({
    basePath,
    // Exact transfer routes do not authenticate. Filepack validates the
    // short-lived capability or upload attempt inside its transfer handler.
    auth: () => null,
  });
}

function isFilepackTransferRoute(
  context: PluginCapabilityRequestContext,
  mountPath: string,
): boolean {
  if (context.url.search !== "") return false;
  if (context.segments[0] !== mountPath) return false;
  const rest = context.segments.slice(1);
  if (context.method === "GET") {
    return rest.length === 2 && rest[0] === "downloads" && isVersionedDownloadCapability(rest[1]);
  }
  if (context.method !== "PUT") return false;
  return (
    (rest.length === 3 &&
      rest[0] === "uploads" &&
      isNonEmptySegment(rest[1]) &&
      rest[2] === "content") ||
    (rest.length === 5 &&
      rest[0] === "uploads" &&
      isNonEmptySegment(rest[1]) &&
      rest[2] === "parts" &&
      isPositivePartNumber(rest[3]) &&
      rest[4] === "content")
  );
}

function isOwnerBoundUploadControlRoute(method: string, segments: readonly string[]): boolean {
  if (segments[0] !== "uploads" || !isNonEmptySegment(segments[1])) return false;
  if (method === "GET") return segments.length === 2;
  if (method !== "POST") return false;
  if (segments.length === 4 && segments[2] === "parts") {
    return segments[3] === "prepare" || segments[3] === "record";
  }
  return segments.length === 3 && (segments[2] === "complete" || segments[2] === "abort");
}

function isNonEmptySegment(value: string | undefined): value is string {
  return value !== undefined && value.length > 0;
}

function isPositivePartNumber(value: string | undefined): boolean {
  if (value === undefined || !/^[1-9][0-9]*$/u.test(value)) return false;
  const partNumber = Number(value);
  return Number.isSafeInteger(partNumber) && partNumber <= 10_000;
}

function isVersionedDownloadCapability(value: string | undefined): boolean {
  return value !== undefined && /^v1\..+$/u.test(value);
}

async function canReadConversation(
  context: Parameters<NonNullable<ChatpackPlugin["handleRequest"]>>[0],
  conversationId: string,
): Promise<boolean> {
  try {
    await context.api.getConversation({ userId: context.userId, conversationId });
    return true;
  } catch {
    return false;
  }
}

async function fileBelongsToConversation<TRouter extends FilepackRouter>(
  filepack: FilepackApi<TRouter>,
  actor: FilepackActor,
  fileId: string,
  conversationId: string,
): Promise<boolean> {
  try {
    const file = await filepack.getFile({ actor, fileId });
    return hasConversationAssociation(file.routeMetadata, conversationId);
  } catch {
    return false;
  }
}

function requiredConversationId(url: URL): string | null {
  const value = url.searchParams.get("conversationId");
  return value !== null && value.length > 0 ? value : null;
}

function parseListFilesQuery(url: URL): {
  readonly conversationId: string | null;
  readonly cursor?: string;
  readonly limit?: number;
} | null {
  const seen = new Set<string>();
  for (const [name] of url.searchParams) {
    if (!LIST_FILE_QUERY_KEYS.has(name) || seen.has(name)) return null;
    seen.add(name);
  }

  const rawLimit = url.searchParams.get("limit");
  let limit: number | undefined;
  if (rawLimit !== null) {
    if (!/^[1-9][0-9]*$/u.test(rawLimit)) return null;
    limit = Number(rawLimit);
    if (!Number.isSafeInteger(limit) || limit > 100) return null;
  }

  const rawConversationId = url.searchParams.get("conversationId");
  const cursor = url.searchParams.get("cursor");
  return {
    conversationId:
      rawConversationId !== null && rawConversationId.length > 0 ? rawConversationId : null,
    ...(cursor !== null ? { cursor } : {}),
    ...(limit !== undefined ? { limit } : {}),
  };
}

function stripConversationQuery(url: URL): URL {
  const copy = new URL(url);
  copy.searchParams.delete("conversationId");
  return copy;
}

function decodeSegment(value: string): string | null {
  try {
    const decoded = decodeURIComponent(value);
    return decoded.includes("/") || decoded.includes("\\") || decoded === "." || decoded === ".."
      ? null
      : decoded.length > 0
        ? decoded
        : null;
  } catch {
    return null;
  }
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const value: unknown = await request.json();
    if (!isRecord(value)) throw new Error("not an object");
    return value;
  } catch {
    throw new Error("Invalid JSON request.");
  }
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
      "x-content-type-options": "nosniff",
    },
  });
}

function errorResponse(status: number, code: string): Response {
  return jsonResponse({ error: { code, message: "File operation is not allowed." } }, status);
}

function unavailableResponse(): Response {
  return errorResponse(404, "FILE_UNAVAILABLE");
}

export type { FilepackFile, FilepackRouter } from "@filepack/core";
