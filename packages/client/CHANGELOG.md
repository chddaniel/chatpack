# @chatpack/client

## 0.2.0

### Minor Changes

- e3ab183: Make the conversations list react to realtime events.

  `message.created` now updates the cached conversation list, not just the open
  thread: the conversation moves to the front (matching the server's
  most-recently-active ordering), its `unreadCount` increments, and a conversation
  missing from the loaded list is fetched once and prepended. `message.updated`
  and `message.deleted` deliberately do not reorder, and redelivered events never
  double-count. `conversations.markRead` clears `unreadCount` locally when the
  marked message is the newest one cached.

  Adds an optional `userId` client option - a cache hint, never authentication -
  so the viewer's own messages are not counted as unread. Without it, the client
  infers the id from the first message it sends.

  `useConversations` and `useMessages` now open the realtime stream themselves, so
  a conversation list live-updates without mounting `useRealtimeStatus`. The
  subscribe-and-refetch workaround previously needed for live lists is obsolete.

  Also hardens `realtime.connect()`: a runtime without a global `EventSource`
  (SSR, React Native, some test renderers) now reports a `NETWORK_ERROR` stream
  error instead of throwing inside the effect that mounted a hook.

## 0.1.1

### Patch Changes

- Updated dependencies [d652d01]
  - @chatpack/core@0.4.0

## 0.1.0

### Minor Changes

- c47d3f4: Add the first-party framework-agnostic Chatpack client, React hooks, and client
  adapters for typing, presence, and receipts.
