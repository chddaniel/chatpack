import { countSearchTokens } from "@chatpack/core";
import type { Metadata } from "@chatpack/core";
import type { SearchTokenRow } from "./types";

export const SEARCH_TOKEN_BATCH_SIZE = 500;

export function searchTokenRows(messageId: string, body: string): SearchTokenRow[] {
  return [...countSearchTokens(body)].map(([token, occurrences]) => ({
    messageId,
    token,
    occurrences,
  }));
}

export async function insertSearchTokenRows(
  rows: SearchTokenRow[],
  insert: (batch: SearchTokenRow[]) => Promise<void>,
): Promise<void> {
  for (let offset = 0; offset < rows.length; offset += SEARCH_TOKEN_BATCH_SIZE) {
    await insert(rows.slice(offset, offset + SEARCH_TOKEN_BATCH_SIZE));
  }
}

export function generateId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

export function asDate(value: Date | string | number, field: string): Date {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`mysqlAdapter: invalid timestamp in ${field}.`);
  return date;
}

export function nullableDate(value: Date | string | number | null, field: string): Date | null {
  return value === null ? null : asDate(value, field);
}

export function metadata(value: Metadata | null): Metadata {
  return value ?? {};
}

export function seq(value: number | string): number {
  const result = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(result) || result < 0)
    throw new Error("mysqlAdapter: invalid message sequence.");
  return result;
}

export function encodeActivityCursor(activityAt: Date, id: string): string {
  return encodeURIComponent(JSON.stringify([activityAt.getTime(), id]));
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
      value[1]
    ) {
      return { activityMs: value[0], id: value[1] };
    }
  } catch {
    // Invalid cursors restart from the first page.
  }
  return null;
}

export function encodeSearchCursor(rank: number, createdAt: Date, id: string): string {
  return encodeURIComponent(JSON.stringify([rank, createdAt.getTime(), id]));
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
    )
      return [value[0], value[1], value[2]];
  } catch {
    // Invalid cursors restart from the first page.
  }
  return null;
}
