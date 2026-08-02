/** Result and error contracts for Chatpack client operations. */

import type { ChatpackErrorCode } from "@chatpack/core";

/** Stable client error codes, including codes returned by the server. */
export type ChatpackClientErrorCode =
  | ChatpackErrorCode
  | "UNAUTHENTICATED"
  | "NOT_FOUND"
  | "INTERNAL_ERROR"
  | "HTTP_ERROR"
  | "INVALID_RESPONSE"
  | "NETWORK_ERROR";

/** Structured client failure with an optional underlying cause. */
export interface ChatpackClientError {
  code: ChatpackClientErrorCode;
  message: string;
  status: number | null;
  cause?: unknown;
}

/** Discriminated result returned by client methods. */
export type ChatClientResult<T> =
  { data: T; error: null } | { data: null; error: ChatpackClientError };

/** Build a successful client result. */
export function success<T>(data: T): ChatClientResult<T> {
  return { data, error: null };
}

/** Build a failed client result. */
export function failure<T>(error: ChatpackClientError): ChatClientResult<T> {
  return { data: null, error };
}

/** Create a structured client error. */
export function createClientError(
  code: ChatpackClientErrorCode,
  message: string,
  status: number | null,
  cause?: unknown,
): ChatpackClientError {
  return cause === undefined ? { code, message, status } : { code, message, status, cause };
}
