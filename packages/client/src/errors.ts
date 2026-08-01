import type { ChatpackErrorCode } from "@chatpack/core";

export type ChatpackClientErrorCode =
  | ChatpackErrorCode
  | "UNAUTHENTICATED"
  | "NOT_FOUND"
  | "INTERNAL_ERROR"
  | "HTTP_ERROR"
  | "INVALID_RESPONSE"
  | "NETWORK_ERROR";

export interface ChatpackClientError {
  code: ChatpackClientErrorCode;
  message: string;
  status: number | null;
  cause?: unknown;
}

export type ChatClientResult<T> =
  { data: T; error: null } | { data: null; error: ChatpackClientError };

export function success<T>(data: T): ChatClientResult<T> {
  return { data, error: null };
}

export function failure<T>(error: ChatpackClientError): ChatClientResult<T> {
  return { data: null, error };
}

export function createClientError(
  code: ChatpackClientErrorCode,
  message: string,
  status: number | null,
  cause?: unknown,
): ChatpackClientError {
  return cause === undefined ? { code, message, status } : { code, message, status, cause };
}
