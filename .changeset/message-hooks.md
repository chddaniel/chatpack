---
"@chatpack/core": minor
---

Add message lifecycle hooks (ADR 0011): a new `hooks` option on `chatpack()`
with `beforeMessageSend` (block or rewrite a message before it persists;
rejections surface as the new `MESSAGE_REJECTED` error code, HTTP 422) and
`afterMessageSend` (post-persistence side-effects such as triggering an AI
reply; never fails the request). Both hooks run for sends and edits, with
`ctx.action` distinguishing the two.
