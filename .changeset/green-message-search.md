---
"@chatpack/core": minor
"@chatpack/adapter-memory": patch
"@chatpack/adapter-drizzle": patch
---

Add case-insensitive, ranked message search across participant conversations.
Search is available through the server API and `GET /search/messages` when the
configured storage adapter provides the optional search capability. Memory and
Drizzle share canonical punctuation-separated token matching; existing Drizzle
databases must run the exported search-token backfill once after migration.
