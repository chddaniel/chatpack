---
"@chatpack/client": patch
---

Recognize the six invite/join-request error codes (ADR 0019) as server errors
rather than transport failures, so `error.code` narrows correctly when you call
those routes with `fetch` alongside the client. No wrappers for the routes
themselves yet.
