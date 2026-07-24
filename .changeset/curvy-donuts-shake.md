---
"@chatpack/core": patch
---

Docs: document the custom storage adapter contract precisely — adapter-defined
cursor encodings, the real-`Date`-instances rule, and adapter-generated ids —
in the StorageAdapter TSDoc and README, and point adapter authors at the
reference schema (`migrationSql`/`chatpackSchema`) and the new root `llms.txt`
agent guide (invariants, reference SQL, skeleton, pitfalls, and a "verify your
adapter" checklist). Also fixes the `Conversation.id`/`Message.id` TSDoc,
which wrongly claimed core generates ids (adapters do).
