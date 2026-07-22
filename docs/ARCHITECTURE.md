# Chatpack

## Vision

Chatpack is an open-source toolkit that aims to become the standard way developers add chat to their applications.

The inspiration comes from BetterAuth.

Authentication is something almost every application needs, yet developers rarely want to build it from scratch. BetterAuth solved that by providing a powerful, flexible, and developer-friendly solution that "just works."

We believe chat has the same opportunity.

Today, every application that needs messaging ends up rebuilding the same concepts repeatedly. Conversations, messages, typing indicators, read receipts, real-time communication, permissions, attachments, notifications, and countless edge cases are implemented over and over again in slightly different ways.

The goal of Chatpack is to remove that repetition.

Developers should be able to install a package, spend a few minutes configuring it, and immediately have a reliable, production-ready chat foundation that they can customize however they like.

This project is **not** about building another Slack, Discord, or WhatsApp.

It is about building the infrastructure that powers those kinds of experiences.

---

# Philosophy

The most important principle is developer experience.

We are building for developers—not end users.

Developers will judge every decision we make.

They will care about:

- API design
- Documentation
- Simplicity
- Flexibility
- Extensibility
- Performance
- Reliability
- Maintainability

The project should feel elegant.

The best compliment someone can give Chatpack is:

> "Wow... that's all I had to write?"

---

# Simplicity First

The first version should intentionally do less.

There will always be opportunities to add more features later.

Instead, the initial goal is to solve the most common chat use cases exceptionally well.

Every feature should justify its existence.

If a feature makes the library more complicated than valuable, it probably doesn't belong in the core.

---

# Extensibility

Different applications have different requirements.

Some need simple one-to-one messaging.

Others need customer support chat.

Others need team collaboration.

Others need AI conversations.

The library should not assume one specific type of application.

Instead, it should provide a solid foundation that developers can extend however they choose.

---

# AI

One interesting direction is making Chatpack naturally compatible with AI-powered applications.

The core library should remain focused on chat itself.

However, AI applications often need additional capabilities that traditional chat systems do not.

Rather than forcing every AI application to rebuild those capabilities independently, Chatpack could eventually provide optional support specifically for AI-driven conversations.

This is especially valuable for AI application builders like Shipper, Lovable, v0, and similar tools. When a generated application requires AI chat, the builder should be able to plug in an existing solution rather than generating all of that infrastructure from scratch every time.

The goal is not to turn Chatpack into an AI framework.

The goal is simply to make AI-powered chat feel like a natural extension of the same foundation.

---

# Open Source

This project is being built as an open-source library first.

That changes how decisions should be made.

Writing code that works is not enough.

Every public API becomes part of the developer experience.

Developers should be able to install it through npm

Every decision should be made with future contributors and users in mind.

The project should be:

- Easy to understand
- Easy to contribute to
- Easy to document
- Easy to maintain
- Easy to extend

---

# Telemetry (anonymous, opt-out)

Decide this early — not after launch.

Chatpack should ship **anonymous, opt-out telemetry** so we can report big-picture usage for social proof (e.g. “a million messages were sent last month”). That is the sole purpose: credibility for an open-source project, not product analytics on end users.

Rules:

- **Anonymous only** — aggregate counters (messages sent, conversations created, library version). Never message bodies, user ids, conversation ids, emails, or hostnames that identify a customer.
- **Opt-out** — on by default; disabled with one config flag or env var. Documented loudly in the README.
- **Never on the hot path** — counting and flushing must not slow down send/receive. Fire-and-forget; failures are silent.
- **Design the hook now** — even if the collector ships late in v0 (launch polish), core should expose a place to increment counters so we do not retrofit later.

Details: `docs/MVP.md` §12.

---

# Long-Term Goal

The ambition is simple.

When developers think:

> "I need authentication."

they think:

> BetterAuth.

When developers think:

> "I need chat."

we want them to think:

> Chatpack.
