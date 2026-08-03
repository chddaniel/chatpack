/**
 * Wire encoding for cross-node transport events.
 *
 * The only real subtlety: {@link Message} carries `createdAt`, `editedAt`, and
 * `deletedAt` as real `Date` instances, and the Chatpack contract is explicit
 * that date fields must never be ISO strings - core does not coerce them.
 * `JSON.stringify` turns them into strings, so the receiving node has to revive
 * them before handing the event to subscribers. Without this, a message that
 * crossed nodes would reach the SSE layer with `createdAt` as a string and
 * quietly break anything that calls a `Date` method on it.
 *
 * `EphemeralEvent.at` is an ISO **string** by contract (`docs/decisions/0008`),
 * so it is left exactly as-is.
 *
 * @module
 */

import { isEphemeralEvent, type TransportEvent } from "@chatpack/core";

/** The envelope actually published to Redis. */
export interface EventEnvelope {
  /** Wire format version, so a future change can be detected, not guessed. */
  v: 1;
  /**
   * The id of the node that published this event. Receivers drop envelopes
   * carrying their own id - those events were already delivered in-process by
   * `publish()` (see `redisTransport`).
   */
  nodeId: string;
  /** The event itself, with `Date`s serialized by `JSON.stringify`. */
  event: TransportEvent;
}

/** Message fields that are `Date | null` on the wire and must be revived. */
const MESSAGE_DATE_FIELDS = ["createdAt", "editedAt", "deletedAt"] as const;

/** Encode an event for publishing. */
export function encodeEnvelope(nodeId: string, event: TransportEvent): string {
  const envelope: EventEnvelope = { v: 1, nodeId, event };
  return JSON.stringify(envelope);
}

/**
 * Revive one date field in place: ISO string → `Date`, `null`/absent → `null`.
 *
 * An unparseable value is left untouched rather than turned into an
 * `Invalid Date`, so corrupt input surfaces as itself instead of as a `Date`
 * that silently misbehaves.
 */
function reviveDate(record: Record<string, unknown>, field: string): void {
  const value = record[field];
  if (typeof value !== "string") return;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return;
  record[field] = parsed;
}

/**
 * Parse an envelope published by another node.
 *
 * Returns `null` for anything that is not a well-formed envelope - a stray
 * publisher on the same channel, a truncated payload, or a future wire version
 * must never take the process down.
 */
export function decodeEnvelope(payload: string): EventEnvelope | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;

  const record = parsed as Record<string, unknown>;
  if (record["v"] !== 1) return null;
  if (typeof record["nodeId"] !== "string" || record["nodeId"] === "") return null;

  const event = record["event"];
  if (typeof event !== "object" || event === null || Array.isArray(event)) return null;
  const eventRecord = event as Record<string, unknown>;
  if (typeof eventRecord["type"] !== "string") return null;

  if (!isEphemeralEvent(event as TransportEvent)) {
    // Durable event: revive the message's Date fields.
    const message = eventRecord["message"];
    if (typeof message !== "object" || message === null || Array.isArray(message)) return null;
    const messageRecord = message as Record<string, unknown>;
    for (const field of MESSAGE_DATE_FIELDS) reviveDate(messageRecord, field);
  }

  return {
    v: 1,
    nodeId: record["nodeId"],
    event: event as TransportEvent,
  };
}
