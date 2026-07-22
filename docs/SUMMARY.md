# Chatpack — Summary (for stakeholders)

> Non-technical overview. Technical detail lives in `docs/MVP.md` and `docs/ARCHITECTURE.md`.

## Vision

Chatpack is an open-source toolkit that aims to become the BetterAuth for chat. Today, every application that needs messaging ends up rebuilding the same functionality from scratch. Conversations, messages, real-time communication, permissions, read states, and countless edge cases are implemented repeatedly across projects.

Our goal is to provide a simple, production-ready foundation that developers can install instead of rebuilding chat every time. Just like BetterAuth made authentication easy, Chatpack aims to make chat effortless.

## Goal

The first version intentionally stays small. Rather than trying to build every possible chat feature, the objective is to build an excellent foundation with a clean developer experience.

The first release (v0) focuses on:

- One-to-one conversations
- Sending and receiving messages
- Real-time messaging
- Basic permissions
- Read status
- Easy integration into existing applications

Developers bring their own authentication and frontend. Chatpack focuses solely on solving chat infrastructure well.

## Social proof (telemetry)

From early on, Chatpack should include **anonymous, opt-out telemetry** — only big-picture counts such as messages sent per month. The goal is social proof for the open-source project (“a million messages were sent last month”), not tracking end users. Message content and personal data are never collected. Developers can turn it off with one setting. Details: `docs/MVP.md` §12.

## Design philosophy

The project is being built for developers. Success isn’t measured by the number of features — it is measured by how simple and enjoyable it is to use.

Every decision should prioritize:

- Simplicity
- Reliability
- Flexibility
- Excellent developer experience
- Long-term maintainability

The goal is that developers can add production-ready chat to an application in minutes instead of spending days or weeks building it themselves.

## Long-term vision (the “Telegram / Discord” picture)

In a year, the ambition is exactly what was described on the Loom:

- Telegram-like **one-to-one** chat
- **Group chats**
- Discord-like **rooms / channels**
- Rich UI/UX building blocks (images, GIFs, typing, presence, and more)
- All of it **configurable**: install Chatpack and say “I only want one-to-one,” or “one-to-one plus images and GIFs,” or “groups with rooms” — and get a pre-built path instead of rebuilding from scratch

That year-one product is real. The important discipline is **not** trying to ship the year-one product in the first week. We draw the line the same way BetterAuth did: ship a foundation people love, then grow the surface carefully.

**Where we draw the line early:** anything that is polish, media hosting, or multi-product complexity (groups, rooms, typing, presence, live ticks, file uploads, push notifications, AI-specific features) waits until the core is solid. Details: `docs/MVP.md` §§4–5.

## What ships when — answering “3 days vs 7 vs 14”

Estimated effort for the first public release is still **~3 focused days (roughly 24–30 hours)**. Below is what the package contains at each horizon if we keep building after that foundation lands.

### In ~3 days — first release (v0)

**What’s in the package:** the minimum that still feels like real chat infrastructure.

- One-to-one conversations only (no groups)
- Send and receive text messages
- Live / real-time delivery
- Basic permissions (only the two people in the chat can read and write)
- Read status (“how far has the other person read?”)
- Easy drop-in for existing apps (developers keep their own login and their own UI)

**What’s deliberately not in the package yet** (from the MVP defer / non-goal list):

| Not in v0                                           | Why wait                                                |
| --------------------------------------------------- | ------------------------------------------------------- |
| Group conversations                                 | Bigger product surface; keep v0 simple                  |
| Typing indicators                                   | Nice polish, not required for messaging to work         |
| Online / presence (“who’s online”)                  | Product + privacy choice; many apps skip it             |
| Live “delivered / read” ticks                       | Read status already covers the important part           |
| Ready-made React UI / hooks                         | Developers bring their own frontend in v0               |
| Image / GIF / file attachments                      | A whole second problem (hosting & uploads)              |
| Push / email notifications                          | Separate product concern                                |
| AI-specific chat features                           | Escape hatches only; not an AI framework                |
| Threads, reactions, search, moderation, admin tools | Later                                                   |
| Multi-server scale-out                              | Single-server is correct for v0; designed to grow later |

**Bottom line for day 3:** a developer can install Chatpack and get reliable **1:1 text + live messaging + read status** into their app quickly. That is the BetterAuth-style “wow, that’s all I had to do?” moment for chat.

---

### In ~7 days — next slice on top of v0

**What’s added to the package** (still not “Telegram + Discord,” but clearly more product-complete):

| Added around day 7                           | What it means in plain terms                                  |
| -------------------------------------------- | ------------------------------------------------------------- |
| Typing indicators                            | “Alice is typing…”                                            |
| Presence                                     | Online / last-seen style signals                              |
| Live delivery / read ticks                   | Instant ✓ / ✓✓ style feedback while both people are online    |
| First official UI helpers (e.g. React hooks) | Faster to wire a frontend without building everything by hand |
| Stronger docs + example app polish           | Easier onboarding for outside developers                      |

**Still out at day 7:** groups, Discord-like rooms, attachments as a first-class feature, push notifications, AI framework features.

**Bottom line for day 7:** 1:1 chat that _feels_ closer to a consumer messenger (typing, presence, live ticks), with a smoother path to build UI — still configurable to turn those extras off.

---

### In ~14 days — toward “pick what you need”

**What’s added to the package:**

| Added around day 14                                 | What it means in plain terms                                                                  |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Group conversations                                 | Chat with more than two people                                                                |
| First pass at rooms / channels (lightweight)        | Early Discord-like structure — not full Discord parity                                        |
| Attachments (images / GIFs / files) — first version | Send media, with clear limits and a simple upload story                                       |
| More configuration knobs                            | “1:1 only,” “1:1 + images,” “groups on/off” — closer to the Loom vision of install-and-choose |

**Still later than 14 days (toward the year vision):** full Discord-like product depth, push/email notification suites, moderation/admin suites, search, reactions/threads at scale, multi-region infrastructure, and deep AI chat tooling.

**Bottom line for day 14:** the package starts to match the Loom story in miniature — developers can choose a shape (1:1 vs groups, text vs media) instead of rebuilding those choices themselves. The year-long roadmap is how that becomes Telegram/Discord-class breadth.

---

## Timeline summary

| Horizon      | Package focus                                                                | Rough effort                               |
| ------------ | ---------------------------------------------------------------------------- | ------------------------------------------ |
| **~3 days**  | Solid 1:1 foundation (text, live, permissions, read status, easy integrate)  | ~24–30 hours — first public release        |
| **~7 days**  | 1:1 + typing, presence, live ticks, UI helpers                               | ~additional week of focused work           |
| **~14 days** | Groups + early rooms + first attachments + clearer “configure what you want” | ~two weeks cumulative                      |
| **~1 year**  | Telegram-like + Discord-like breadth, rich configurable UX                   | Continuous product growth on a stable core |

## Success measure

When developers need authentication, many immediately think of BetterAuth.

The ambition for Chatpack is the same association for messaging:

> “I need chat.” → “Use Chatpack.”
