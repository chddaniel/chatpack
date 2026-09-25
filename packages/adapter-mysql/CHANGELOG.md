# @chatpack/adapter-mysql

## 0.1.0

### Minor Changes

- c89b571: Add the first-party Drizzle ORM MySQL 8 storage adapter with full Chatpack
  storage capabilities, migrations, search-token backfill, and real-database
  regression tests.
- 37946db: Allow one thread reply to appear in the main conversation and add a permission-scoped message lookup. The Chatpack app now has a thread inbox, follow and unread state, reply links, and optional email and browser push alerts.
- 31fc33f: Add opt-in message threads with reply pages, counts, storage migrations, client hooks, and realtime cache updates.

### Patch Changes

- Updated dependencies [37946db]
- Updated dependencies [31fc33f]
  - @chatpack/core@0.14.0
