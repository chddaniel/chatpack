---
"@chatpack/transport-redis": patch
---

Relay conversation events across nodes. `decodeEnvelope` required a `message`
field on every non-ephemeral event, so the new `ConversationEvent` category
(`participant.added`, `participant.removed`, `conversation.updated`) decoded to
`null` and every membership change was silently dropped between nodes. The
decoder now handles all four `TransportEvent` members and revives dates on
whichever snapshot the event carries - a message, or a conversation and each of
its participants' `joinedAt`.
