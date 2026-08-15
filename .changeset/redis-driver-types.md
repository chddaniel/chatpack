---
"@chatpack/transport-redis": patch
---

Fix `RedisSubscriber` so the documented drivers actually typecheck.

`subscribe` was declared as one permissive signature, `subscribe(channel, listener?)`, which neither supported driver is assignable to: `node-redis`'s message listener is required (so it cannot stand in for a signature that may omit one), and `ioredis`'s optional second argument is a `(err, count)` completion callback, not a listener. Passing a real client - including the snippet in this package's README - therefore needed a cast to compile. `subscribe` is now a union of the two real signatures, so a client only has to match one arm. Runtime behavior, the driver discriminator and the two-connection rule are unchanged, and a type-level test against the real `ioredis` and `node-redis` types keeps it that way.
