import { countSearchTokens } from "@chatpack/core";
import type { Metadata } from "@chatpack/core";

export type JsonInput =
  string | number | boolean | null | JsonInput[] | { [key: string]: JsonInput };

export type JsonValue = JsonInput;

export const SEARCH_TOKEN_BATCH_SIZE = 500;

export interface SearchTokenRow {
  messageId: string;
  token: string;
  occurrences: number;
}

export function searchTokenRows(messageId: string, body: string): SearchTokenRow[] {
  return [...countSearchTokens(body)].map(([token, occurrences]) => ({
    messageId,
    token,
    occurrences,
  }));
}

export function generateId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

export function asDate(value: Date | string | number, field: string): Date {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(date.getTime()))
    throw new Error(`prismaAdapter: invalid timestamp in ${field}.`);
  return date;
}

export function nullableDate(value: Date | string | number | null, field: string): Date | null {
  return value === null ? null : asDate(value, field);
}

export function metadata(value: JsonValue | null): Metadata {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Metadata;
}

export function jsonInput(value: Metadata): JsonInput {
  return toJsonInput(value, "metadata");
}

function toJsonInput(value: unknown, field: string): JsonInput {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new Error(`prismaAdapter: ${field} contains non-finite number.`);
    return value;
  }
  if (Array.isArray(value))
    return value.map((item, index) => toJsonInput(item, `${field}[${index}]`));
  if (typeof value === "object") {
    const object: { [key: string]: JsonInput } = {};
    for (const [key, item] of Object.entries(value))
      object[key] = toJsonInput(item, `${field}.${key}`);
    return object;
  }
  throw new Error(`prismaAdapter: ${field} contains non-JSON value.`);
}

export function seq(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error("prismaAdapter: invalid message sequence.");
  return value;
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

export async function insertSearchTokenRows(
  rows: SearchTokenRow[],
  insert: (batch: SearchTokenRow[]) => Promise<void>,
): Promise<void> {
  for (let offset = 0; offset < rows.length; offset += SEARCH_TOKEN_BATCH_SIZE) {
    await insert(rows.slice(offset, offset + SEARCH_TOKEN_BATCH_SIZE));
  }
}
