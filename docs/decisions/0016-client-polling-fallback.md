# ADR 0016: Client-side polling fallback

- **Status:** accepted
- **Date:** 2026-08-05
- **Milestone:** client 0.4 (polling fallback)

## Context

`@chatpack/client` is SSE-only. `createRealtime` opens one `EventSource` and,
when the runtime has none or the connection drops, reports
`{ status: "closed", error: NETWORK_ERROR }` and stops. Data still loads over
REST; it simply never updates again.

That is the correct behaviour on a platform that can hold a long-lived
connection, and it is the wrong behaviour on a growing number that cannot:

- **Serverless platforms with a response timeout.** Vercel's Node runtime caps
  a response; a stream is killed mid-flight and reconnects in a loop.
- **Proxies and corporate middleboxes** that buffer or terminate
  `text/event-stream`.
- **React Native**, which has no `EventSource` at all without a polyfill.

Today `llms.txt` tells those users to hand-roll an interval that calls
`listMessages` - which means every consumer on an affected platform writes the
same loop, and writes it with the same three bugs (overlapping requests, a
hidden tab polling forever, and unread counts double-counted against
`seenSeq`). `apps/docs/content/docs/client/realtime.mdx` already frames this as
"not in the first client release": deferred, not rejected.

The questions this ADR settles:

1. Polling needs a "what changed?" query. Which one?
2. Does the fallback engage automatically, and how does it recover?
3. What happens to typing, presence and receipts while polling?
4. What does a poll refetch - everything the client has ever loaded?

## Decision

### 1. Poll the existing list routes, not a new `?afterSeq=` route

The obvious design - `GET /conversations/:id/messages?afterSeq=N`, cheap and
incremental - **cannot work**, and this is the load-bearing finding of the ADR.

`seq` is allocated by `addMessage` and only by `addMessage` (ADR 0003, whose
stable-sort invariant depends on it). Verified against a live handler:

```
after 2 sends: seqs = 1 2
edited m1 -> seq is still 1 | editedAt set: true
deleted m2 -> seq is still 2
listMessagesAfter(afterSeq=2) returns 0 messages
```

An edit, a soft-delete and (per ADR 0013, which gives reactions no `seq` at
all) every reaction change are **invisible** to an `afterSeq` poll. A client
polling that way would show new messages while silently missing every
correction, tombstone and 👍 - worse than not polling, because it looks live.

So a poll re-reads page one of `GET /conversations/:id/messages` and
`GET /conversations`, which return edits, tombstones, reactions and `replyTo`
already hydrated. One request per surface, and it catches everything.

**This keeps the feature entirely client-side**: no new route, no new error
code, no change to the storage contract, nothing breaking. Core is untouched.

### 2. `auto` by default: SSE first, poll on failure, recover on reconnect

`ChatClientOptions` gains one optional field:

```ts
realtime?: {
  mode?: "auto" | "sse" | "poll";   // default "auto"
  intervalMs?: number;               // default 5000, floor 1000
}
```

- **`auto`** attempts the stream. Polling starts when `EventSource` is missing,
  construction throws, or an open stream errors - and **stops** the moment
  `onopen` fires, because `EventSource` retries on its own and the stream is
  authoritative when it is up. A serverless deploy therefore works unconfigured.
- **`sse`** is the pre-0.4 behaviour, for hosts that would rather see the
  failure than pay for polls.
- **`poll`** skips the stream attempt entirely, for platforms known not to
  support one - the failed attempt costs seconds of staleness for nothing.

`ChatRealtimeStatus` gains **`"polling"`** rather than reporting `open`
(a lie - ephemerals are dead) or `closed` (also a lie - data is live). The
snapshot keeps the error that caused the fallback, so an existing
"reconnecting…" hint keeps working, and clears it on recovery.

The poller lives in `realtime.ts` behind an injected `onPoll`, so the module
that owns every status transition owns the fallback too, and `polling.ts` knows
nothing about requesters or the cache.

### 3. Ephemerals are unavailable while polling, and are documented as such

Typing, presence and receipts are ephemeral and are not available while polling
(ADR 0008). Presence may use transient shared leases for multi-node SSE, but it
still has no durable snapshot for a polling client: `useTyping` stays `null`.

This is not a gap to close later. Persisting ephemerals to make them pollable
would reverse ADR 0008 in order to serve the platform least able to afford the
writes. A host that needs typing indicators needs a platform that holds a
connection - or the Redis transport and a runtime that does.

### 4. A tick refreshes the conversations list and the 3 most recent threads

Both, because either alone is a broken chat app: threads only means the sidebar
never updates; the list only means the open conversation is frozen.

Only surfaces the host has actually loaded are polled, and threads are capped at
the **3 most recently listed or sent-to**. The cache retains every thread ever
opened, so polling all of them would cost a request per conversation the user
had visited, growing for as long as the tab lives. Older threads refetch when
the user navigates back to them anyway.

Each poll reuses the `limit` the host last requested for that surface, so a host
paginating 10 at a time is not silently handed the server's default of 50.

Four properties the loop must have, all regression-tested:

- **Ticks never overlap.** A slow network degrades the effective interval rather
  than stacking requests on the connection least able to take them.
- **A hidden tab does not poll**, and catches up immediately on
  `visibilitychange`. Without this every background tab is a request per
  interval, forever.
- **Restarts do not re-tick.** A flapping stream calls `start()` on every error;
  each must not buy another immediate request.
- **A failed tick changes nothing** and retries on the next. Polls never touch
  `isPending`/`isRefetching`, so a mounted component does not flash a spinner on
  a timer.

### 5. Polled pages merge; they never replace

`setMessages(..., append)` re-sorts unconditionally, so it always returns a
fresh array - an identity check would report a change on every tick and
re-render every mounted component on a timer. Polling therefore gets its own
`applyPolledMessages` / `applyPolledConversations`, which return the previous
state unless something a renderer can actually see changed (body, `editedAt`,
`deletedAt`, the reaction summaries, the `replyTo` preview; `unreadCount` and
participant read-state on a conversation).

Two things the merge deliberately does not do:

- **Never insert mid-page.** A polled page can reach further back than the
  loaded one; splicing those in would produce a thread that looks complete but
  has a hole where the host never paged. Only a message newer than everything
  loaded is added.
- **Never drop what the poll did not mention.** A poll reads page one; a host
  may have paged well past it. Polled conversations take the front (the server
  orders by activity and owns `unreadCount`); the rest keep their place behind.

`applyPolledMessages` advances the same `seenSeq` baseline a fetched page does,
so a polled message never counts as unread and a later stream replay of it does
not double-count (ADR 0009).

## Consequences

- **No breaking change, and no core change.** `realtime.mdx`'s "no polling" note
  and the hand-rolled-loop recipe in `llms.txt` are both replaced by a flag.
  Behaviour changes only for clients that previously got `closed` and now poll -
  which is the point - and `mode: "sse"` restores the old behaviour exactly.
- **`createRealtime` without `onPoll` is stream-only** whatever the mode says.
  A directly-constructed controller keeps its old behaviour; only
  `createChatClient` wires the fallback.
- **Polling costs requests.** Up to four per interval (list + 3 threads), and
  the default 5s interval on a visible tab is ~48 requests/minute per client.
  Hosts on `auto` who never lose the stream pay nothing.
- **`pollNow()` is public** on `ChatRealtime`, so a host can offer a manual
  "check for new messages" action, and tests can drive a tick without timers.
- **Reactions now recover from a reconnect gap while polling.** ADR 0013 says a
  reaction is not gap-filled because it has no `seq`; a polling client picks it
  up on the next tick regardless. The SSE path is unchanged - reactions still
  arrive on the next fetch there.
- **Multi-node changes nothing here.** Polling reads from storage, so a client
  behind a load balancer sees every node's writes without the Redis transport
  (ADR 0012) - one of the few places where the fallback is strictly simpler than
  the stream.
- **If an incremental poll is ever wanted**, it needs a monotonic
  `updatedAt`/version on `Message` plus reaction rows, and a route that returns
  changes since a watermark. That is an adapter-contract change and a separate
  ADR; it is not blocked by anything decided here.
