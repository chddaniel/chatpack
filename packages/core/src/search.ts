/**
 * Canonical message-search tokenization shared by first-party adapters.
 *
 * Punctuation separates tokens. This keeps memory and Postgres matching
 * identical for values such as URLs, paths, email addresses, phone numbers,
 * versions, and underscored identifiers.
 */

const SEARCH_TOKEN = /[\p{L}\p{N}]+/gu;

/** Split text into case-insensitive, Unicode-aware search tokens. */
export function tokenizeSearch(value: string): string[] {
  return value.normalize("NFKC").toLowerCase().match(SEARCH_TOKEN) ?? [];
}

/** Return the unique query terms, preserving their first-seen order. */
export function getSearchTerms(value: string): string[] {
  return [...new Set(tokenizeSearch(value))];
}

/** Count each token occurrence in message text. */
export function countSearchTokens(value: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const token of tokenizeSearch(value)) {
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  return counts;
}

/**
 * Score a message for a query. Every unique query term must be present; the
 * score is the sum of its occurrences. `null` means that the message does not
 * match all query terms.
 */
export function scoreSearchTerms(
  counts: ReadonlyMap<string, number>,
  terms: readonly string[],
): number | null {
  let score = 0;
  for (const term of terms) {
    const count = counts.get(term);
    if (count === undefined) return null;
    score += count;
  }
  return score;
}
