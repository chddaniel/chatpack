---
"@chatpack/core": minor
"@chatpack/next": patch
"@chatpack/file": minor
---

Add blocking and trusted bearer-capability plugin hooks plus the `@chatpack/file`
integration for Filepack-backed, conversation-authorized attachments. Capability
dispatch is limited to exact Filepack transfer routes; control routes remain
authenticated and unknown routes are not forwarded.
