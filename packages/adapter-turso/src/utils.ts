import { countSearchTokens } from "@chatpack/core";

import type { SearchTokenRow } from "./types";

export const SEARCH_TOKEN_BATCH_SIZE = 1000;

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
  // 128 bits of randomness via the Web Crypto API (available in Node 19+,
  // Bun, Deno, Workers) - no extra dependency.
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

export function encodeSearchCursor(rank: number, createdAt: Date, id: string): string {
  return encodeURIComponent(JSON.stringify([rank, createdAt.getTime(), id]));
}

export function decodeSearchCursor(cursor: string): [number, number, string] | null {
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
    // Invalid cursors restart from the first result, matching other adapter cursors.
  }
  return null;
}
