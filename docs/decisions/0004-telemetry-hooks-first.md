# ADR 0004 — Telemetry counters land in M1; the flusher lands in M5

- Status: accepted
- Date: 2026-07-22

## Context

Chatpack ships anonymous, opt-out telemetry for social proof (MVP §12,
ARCHITECTURE "Telemetry"). The docs are explicit: _"Design the hook now —
even if the collector ships late in v0, core should expose a place to
increment counters so we do not retrofit later."_ Retrofitting telemetry into
an already-published API is painful and trust-sensitive.

## Decision

Split telemetry across two milestones:

- **M1 (now):** `TelemetryCounters` (`packages/core/src/telemetry.ts`) —
  in-process aggregate counters (`messagesSent`, `conversationsCreated`)
  incremented by the engine after successful domain actions. Exposed as
  `chat.telemetry`. Opt-out resolved at instance creation:
  `CHATPACK_TELEMETRY=0` env (ops kill switch, always wins) →
  `telemetry: false` config → default on.
- **M5 (launch polish):** the fire-and-forget flusher that periodically POSTs
  `{ installId, version, period, messagesSent, conversationsCreated }`, plus
  loud README documentation.

Rules encoded now: increments are synchronous integer adds (never on the hot
path in any meaningful way), disabled means hard zeros, and nothing
identifying is ever counted.

## Consequences

- The public API shape (`telemetry` option, `chat.telemetry`) is stable from
  the first release; M5 adds behavior, not surface.
- Tests can assert counting semantics (e.g. find-or-create hits do not double
  count conversations) long before any network code exists.
