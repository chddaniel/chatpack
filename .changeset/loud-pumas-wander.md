---
"@chatpack/client": minor
---

Add a polling fallback for platforms where SSE can't work - serverless function
timeouts, buffering proxies, React Native without `EventSource`. Previously the
client reported `closed` and stopped updating; now it refetches on an interval
instead.

```ts
createChatClient({
  realtime: {
    mode: "auto", // "auto" (default) | "sse" | "poll"
    intervalMs: 5000, // default 5000, clamped to a 1000ms floor
  },
});
```

`auto` opens the stream and polls only if it can't open or drops, stopping the
moment it reopens - a serverless deploy needs no configuration. `sse` keeps the
previous stream-only behaviour. `poll` skips the doomed attempt entirely. The new
`"polling"` realtime status means connected-but-degraded, and `realtime.pollNow()`
runs one refresh on demand.

A tick refetches page one of the conversations list **and** the 3 most recently
used threads, at the same `limit` the host last requested, and only for surfaces
already loaded. It re-reads the existing list routes rather than asking for
messages after a `seq`: only sending allocates a `seq`, so an edit, a delete and
every reaction change would be invisible to an incremental poll. Ticks never
overlap, hidden tabs don't poll, a failed tick changes nothing and never touches
`isPending`, and polled pages merge rather than replace - so an idle interval
notifies no subscribers and causes no re-renders.

Typing, presence and receipts are unavailable while polling: ephemeral events are
never stored, so there is nothing to poll for.

No server change - the fallback is entirely client-side. See ADR 0016.
