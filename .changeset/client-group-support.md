---
"@chatpack/client": minor
---

Client group support (ADR 0017 follow-up). The five group mutations are now
wrapped as typed methods: `conversations.createGroup` (never find-or-create;
the caller becomes the first admin), `conversations.addParticipants`,
`conversations.removeParticipant` (pass your own id to leave),
`conversations.setParticipantRole`, and `conversations.update` (rename;
`name: null` clears the title).

The client also subscribes to `participant.added`, `participant.removed`, and
`conversation.updated` and applies them to the cache: renames and role changes
merge in place without reordering the list, being added to a group fetches and
prepends it, and being removed drops the conversation from every cache surface
(your own `participant.removed` is the only signal you get). Polling clients
converge on the next tick, treating a thread poll's `FORBIDDEN_READ` as the
removal signal.

Server error codes are now passed through exhaustively - `MESSAGE_REJECTED`,
`SEARCH_UNSUPPORTED`, and the four group codes (`NOT_CONVERSATION_ADMIN`,
`NOT_GROUP_CONVERSATION`, `LAST_ADMIN_REMAINING`, `GROUP_LIMIT_EXCEEDED`)
previously flattened to `HTTP_ERROR`; the mapping is exhaustive over core's
`ChatpackErrorCode`, so a future code fails typecheck instead of silently
degrading. New exports: `isConversationChatEvent`, `ConversationChatEvent`,
`ClientConversationSnapshot`, and the four mutation input types.
