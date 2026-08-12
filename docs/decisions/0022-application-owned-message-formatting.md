# ADR 0022: Application-owned message formatting

- **Status:** accepted
- **Date:** 2026-08-11
- **Milestone:** v1.next (message formatting)

## Context

Applications often want basic formatting such as links, emphasis, lists, or
code. Chatpack serves different products and runtimes, so one formatting
syntax or rendered output would add policy, parser, and security requirements
to every consumer.

## Decision

Chatpack treats `Message.body` as opaque text. Core does not interpret
Markdown, HTML, or any other formatting syntax. It does not parse, render, or
sanitize message bodies, and it does not store rendered HTML.

Formatting is an application convention. An application may choose plain text,
Markdown, or another syntax and may keep any format marker in its own data
model. The application owns parsing and presentation for message bodies,
edits, and reply previews.

Message bodies are untrusted input. Applications must render them as text by
default. If an application supports markup, it must use a maintained parser
and sanitizer with an explicit allowlist before inserting HTML, including safe
URL-scheme handling. It must not insert a raw body directly into the DOM.

## Consequences

- Core keeps one stable text contract and gains no formatting or HTML
  dependency.
- Consumers choose formatting rules that match their product and platform.
- Different consumers can render the same body differently; Chatpack does not
  promise portable formatted output.
- Search, excerpts, events, and persistence continue to use the stored raw
  body. Core never creates a formatted representation for them.
