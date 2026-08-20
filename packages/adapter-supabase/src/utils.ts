import { countSearchTokens, type Metadata } from "@chatpack/core";
import type { Timestamp } from "./types.js";

export function id(prefix: string, idPrefix: string): string {
  return `${idPrefix}_${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

export function date(value: Timestamp, field: string): Date {
  if (value instanceof Date) return new Date(value.getTime());
  if (typeof value === "string") {
    const result = new Date(value);
    if (!Number.isNaN(result.getTime())) return result;
  }
  throw new Error(`supabaseAdapter: invalid timestamp in ${field}.`);
}

export function nullableDate(value: Timestamp, field: string): Date | null {
  return value === null ? null : date(value, field);
}

export function seq(value: number | string): number {
  const result = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new Error("supabaseAdapter: invalid message sequence.");
  }
  return result;
}

export function metadata(value: Metadata | null): Metadata {
  return value ?? {};
}

export function encodeActivityCursor(cursor: { activityMs: number; id: string }): string {
  return encodeURIComponent(JSON.stringify([cursor.activityMs, cursor.id]));
}

export function decodeActivityCursor(
  cursor: string | undefined,
): { activityMs: number; id: string } | null {
  if (!cursor) return null;
  try {
    const value: unknown = JSON.parse(decodeURIComponent(cursor));
    if (
      Array.isArray(value) &&
      typeof value[0] === "number" &&
      Number.isFinite(value[0]) &&
      typeof value[1] === "string" &&
      value[1].length > 0
    ) {
      return { activityMs: value[0], id: value[1] };
    }
  } catch {
    // Invalid cursors restart at the first page, matching other adapters.
  }
  return null;
}

export function encodeSearchCursor(rank: number, createdAt: Date, messageId: string): string {
  return encodeURIComponent(JSON.stringify([rank, createdAt.getTime(), messageId]));
}

export function decodeSearchCursor(cursor: string | undefined): [number, number, string] | null {
  if (!cursor) return null;
  try {
    const value: unknown = JSON.parse(decodeURIComponent(cursor));
    if (
      Array.isArray(value) &&
      typeof value[0] === "number" &&
      typeof value[1] === "number" &&
      typeof value[2] === "string"
    ) {
      return [value[0], value[1], value[2]];
    }
  } catch {
    // Invalid cursors restart at the first result.
  }
  return null;
}

export function encodeSimpleCursor(value: string): string {
  return encodeURIComponent(value);
}

export function decodeSimpleCursor(value: string | undefined): string | null {
  if (!value) return null;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export type QueryResult<T> = {
  data: T;
  error: {
    message?: string;
    code?: string | null;
    details?: string | null;
    hint?: string | null;
  } | null;
};

export function checked<T>(result: QueryResult<T>, operation: string): T {
  if (result.error) {
    const detail =
      result.error.message ?? result.error.details ?? result.error.code ?? "unknown Supabase error";
    throw new Error(`supabaseAdapter: ${operation}: ${detail}`);
  }
  return result.data;
}

export function requiredRow<T>(result: QueryResult<T | null>, operation: string): T {
  const row = checked(result, operation);
  if (row === null) throw new Error(`supabaseAdapter: ${operation}: no row returned.`);
  return row;
}

export function requiredRows<T>(result: QueryResult<T[]>, operation: string): T[] {
  return checked(result, operation);
}

export function tokenRows(
  messageId: string,
  body: string,
): Array<{ message_id: string; token: string; occurrences: number }> {
  return [...countSearchTokens(body)].map(([token, occurrences]) => ({
    message_id: messageId,
    token,
    occurrences,
  }));
}

export function dbDate(value: Date | null): string | null {
  return value?.toISOString() ?? null;
}
