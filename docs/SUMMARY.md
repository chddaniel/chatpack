# Chatpack - Summary (for stakeholders)

> Non-technical overview. Technical detail lives in `docs/MVP.md` and `docs/ARCHITECTURE.md`.

## Vision

Chatpack is an open-source toolkit that aims to become the BetterAuth for chat.
Applications should be able to install a reliable chat foundation instead of
rebuilding conversations, messages, permissions, read state, real-time
delivery, and storage.

Developers bring their own authentication and frontend. Chatpack focuses on
chat infrastructure.

## Current scope

Current releases include:

- One-to-one and group conversations
- Text messages with edit and delete operations
- Participant permissions and durable read state
- Unread counts
- Real-time SSE delivery with reconnect gap-fill
- In-memory and Drizzle/Postgres storage adapters
- Redis transport for multi-node event fan-out
- Typing, presence, and receipt plugins
- A browser client, React hooks, and polling fallback
- Reactions and quote-replies
- Participant-scoped message search
- A post-persistence message mutation hook for application side effects
- `@chatpack/cli init` for project setup

The API remains `0.x`. Minor breaking changes can occur before `1.0`.

## Product boundary

Chatpack stays headless and provider-neutral.

- File attachments are pending work in
  [PR #7](https://github.com/chddaniel/chatpack/pull/7). `@chatpack/file` is not
  part of current `main` or the current package list.
- Quote-replies are flat message pointers. True message threads have not
  shipped.
- Applications can use `afterMessageMutation` to start notification work.
  Chatpack does not ship push notification providers.
- Chatpack does not ship reusable React UI components. It ships headless React
  hooks.
- Redis relays events between nodes. Presence connection state remains local
  to each process.
- Public channels, invite links, join requests, moderation suites, and
  multi-region infrastructure have not shipped.

These boundaries keep the core small. They are not release promises.

## Social proof (telemetry)

Chatpack includes anonymous, opt-out telemetry for aggregate project counts.
It does not collect message content or user data. Developers can disable it
with configuration or an environment variable. Details are in `docs/MVP.md`.

## Design philosophy

Every decision should prioritize:

- Simplicity
- Reliability
- Flexibility
- Clear developer experience
- Long-term maintainability

Success is not the number of features. Success is a dependable foundation
that applications can integrate without rebuilding chat infrastructure.

## Success measure

When developers need authentication, many immediately think of BetterAuth.
The ambition for Chatpack is the same association for messaging:

> “I need chat.” → “Use Chatpack.”
