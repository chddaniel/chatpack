/** Chatpack-aware browser wrapper around the public Filepack client. */

import {
  createFilepackClient,
  type ControlHeaders,
  type FilepackClient,
  type FilepackClientOptions,
  type FilepackClientError,
  type ResumeUploadInput,
  type UploadInput,
  type UploadResult,
  type UploadTask,
} from "@filepack/client";
import type { FilepackFile, FilepackRouter } from "@filepack/core";
import {
  DEFAULT_FILE_MOUNT_PATH,
  isInlineFileType,
  type ResolvedFileAttachment,
} from "../index.js";

export interface ChatpackFileClientOptions extends Omit<FilepackClientOptions, "basePath"> {
  /** Nested Chatpack Filepack path. Defaults to `/api/chat/files`. */
  readonly basePath?: string;
}

export interface FileMetadataInput {
  readonly conversationId: string;
  readonly fileId: string;
  readonly signal?: AbortSignal;
}

export interface ResolveFileTargetInput extends FileMetadataInput {
  readonly force?: boolean;
}

export interface ChatpackFileClient<TRouter extends FilepackRouter> {
  readonly filepack: FilepackClient<TRouter>;
  upload<TRoute extends keyof TRouter & string>(input: UploadInput<TRouter, TRoute>): UploadTask;
  resumeUpload(input: ResumeUploadInput): UploadTask;
  getFile(input: FileMetadataInput): Promise<FilepackFile | null>;
  resolveTarget(input: ResolveFileTargetInput): Promise<ResolvedFileAttachment>;
  clearFileCache(input?: Pick<FileMetadataInput, "conversationId" | "fileId">): void;
}

export class ChatpackFileClientError extends Error {
  override readonly name = "ChatpackFileClientError" as const;
  readonly status: number;
  readonly responseBody: unknown;

  constructor(status: number, responseBody: unknown) {
    super("The Filepack request failed.");
    this.status = status;
    this.responseBody = responseBody;
  }
}

interface TargetCacheEntry {
  promise: Promise<ResolvedFileAttachment>;
  result: ResolvedFileAttachment | undefined;
}

const TARGET_EXPIRY_SAFETY_MS = 5_000;

/** Creates a Filepack upload client with guarded, cached attachment resolution. */
export function createChatpackFileClient<TRouter extends FilepackRouter>(
  options: ChatpackFileClientOptions = {},
): ChatpackFileClient<TRouter> {
  const basePath = options.basePath ?? `/api/chat/${DEFAULT_FILE_MOUNT_PATH}`;
  const filepackOptions: FilepackClientOptions = {
    ...options,
    basePath,
  };
  const filepack = createFilepackClient<TRouter>(filepackOptions);
  const metadataCache = new Map<string, Promise<FilepackFile | null>>();
  const targetCache = new Map<string, TargetCacheEntry>();

  async function getFile(input: FileMetadataInput): Promise<FilepackFile | null> {
    const key = cacheKey(input.conversationId, input.fileId);
    const cached = metadataCache.get(key);
    if (cached !== undefined) return cached;

    const pending = requestJson<{ readonly file: FilepackFile }>(
      options.controlFetch ?? globalThis.fetch,
      controlUrl(basePath, `/files/${encodeURIComponent(input.fileId)}`, input.conversationId),
      requestInit("GET", await resolveHeaders(options.controlHeaders), input.signal),
    )
      .then((body) => body.file)
      .catch((error: unknown) => {
        if (error instanceof ChatpackFileClientError && error.status === 404) return null;
        throw error;
      });
    metadataCache.set(key, pending);
    void pending.catch(() => {
      if (metadataCache.get(key) === pending) metadataCache.delete(key);
    });
    return pending;
  }

  async function resolveTarget(input: ResolveFileTargetInput): Promise<ResolvedFileAttachment> {
    const key = cacheKey(input.conversationId, input.fileId);
    if (!input.force) {
      const cached = targetCache.get(key);
      if (cached !== undefined && isReusableTarget(cached.result)) return cached.promise;
    }

    const fresh = (async (): Promise<ResolvedFileAttachment> => {
      const file = await getFile(input);
      if (file === null) return { status: "unavailable", fileId: input.fileId };
      try {
        const delivery = isInlineFileType(file.contentType) ? "inline" : "attachment";
        const target = await prepareDownload(input, delivery);
        return {
          status: "available",
          file,
          kind: target.delivery,
          delivery: target.delivery,
          url: target.url,
          expiresAt: target.expiresAt,
        };
      } catch (error) {
        if (error instanceof ChatpackFileClientError && error.status === 404) {
          return { status: "unavailable", fileId: input.fileId };
        }
        throw error;
      }
    })();
    const entry: TargetCacheEntry = { promise: fresh, result: undefined };
    entry.promise = fresh
      .then((result) => {
        entry.result = result;
        return result;
      })
      .catch((error: unknown) => {
        if (targetCache.get(key) === entry) targetCache.delete(key);
        throw error;
      });
    targetCache.set(key, entry);
    return entry.promise;
  }

  async function prepareDownload(
    input: FileMetadataInput,
    delivery: "inline" | "attachment",
  ): Promise<{
    readonly url: string;
    readonly expiresAt: string;
    readonly delivery: "inline" | "attachment";
  }> {
    const fetcher = options.controlFetch ?? globalThis.fetch;
    const headers = await resolveHeaders(options.controlHeaders);
    const url = controlUrl(
      basePath,
      `/files/${encodeURIComponent(input.fileId)}/download`,
      input.conversationId,
    );
    const request = (mode: "inline" | "attachment"): RequestInit => ({
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ delivery: mode }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    try {
      const result = await requestJson<{
        readonly url: string;
        readonly expiresAt: string;
        readonly delivery?: "inline" | "attachment";
      }>(fetcher, url, request(delivery));
      return { ...result, delivery: result.delivery ?? delivery };
    } catch (error) {
      if (
        delivery !== "inline" ||
        !(error instanceof ChatpackFileClientError) ||
        error.status !== 415
      ) {
        throw error;
      }
      const result = await requestJson<{
        readonly url: string;
        readonly expiresAt: string;
        readonly delivery?: "inline" | "attachment";
      }>(fetcher, url, request("attachment"));
      return { ...result, delivery: result.delivery ?? "attachment" };
    }
  }

  return {
    filepack,
    upload: filepack.upload,
    resumeUpload: filepack.resumeUpload,
    getFile,
    resolveTarget,
    clearFileCache(input) {
      if (input === undefined) {
        metadataCache.clear();
        targetCache.clear();
        return;
      }
      const key = cacheKey(input.conversationId, input.fileId);
      metadataCache.delete(key);
      targetCache.delete(key);
    },
  };
}

function requestInit(
  method: string,
  headers: HeadersInit,
  signal: AbortSignal | undefined,
): RequestInit {
  return signal === undefined ? { method, headers } : { method, headers, signal };
}

function cacheKey(conversationId: string, fileId: string): string {
  return `${conversationId}\u0000${fileId}`;
}

function isReusableTarget(result: ResolvedFileAttachment | undefined): boolean {
  if (result === undefined || result.status === "unavailable") return true;
  const expiresAt = Date.parse(result.expiresAt);
  return Number.isFinite(expiresAt) && expiresAt - Date.now() > TARGET_EXPIRY_SAFETY_MS;
}

function controlUrl(basePath: string, suffix: string, conversationId: string): string {
  const normalized = basePath.replace(/\/$/u, "");
  const separator = suffix.includes("?") ? "&" : "?";
  return `${normalized}${suffix}${separator}conversationId=${encodeURIComponent(conversationId)}`;
}

async function resolveHeaders(headers: ControlHeaders | undefined): Promise<HeadersInit> {
  if (headers === undefined) return {};
  return typeof headers === "function" ? await headers() : headers;
}

async function requestJson<T>(
  fetcher: typeof globalThis.fetch,
  input: string,
  init: RequestInit,
): Promise<T> {
  const response = await fetcher(input, init);
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (!response.ok) throw new ChatpackFileClientError(response.status, body);
  return body as T;
}

export type {
  ControlHeaders,
  FilepackClient,
  FilepackClientError,
  FilepackClientOptions,
  ResumeUploadInput,
  UploadInput,
  UploadResult,
  UploadTask,
};
