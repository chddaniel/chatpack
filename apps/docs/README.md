# @chatpack/docs

The Chatpack documentation site - built with [Fumadocs](https://fumadocs.dev)
on Next.js.

## Develop

From the repo root:

```sh
pnpm install
pnpm --filter @chatpack/docs dev   # http://localhost:3333
```

## Build

```sh
pnpm --filter @chatpack/docs build
pnpm --filter @chatpack/docs start
```

## Structure

| Path                       | What it is                                                                       |
| -------------------------- | -------------------------------------------------------------------------------- |
| `content/docs/`            | All documentation pages (MDX) - edit these                                       |
| `content/docs/*/meta.json` | Sidebar section titles, icons, and page order                                    |
| `app/`                     | Next.js app: layouts, docs renderer, search API, OG images                       |
| `lib/shared.ts`            | Site name, GitHub repo info, route constants                                     |
| `components/mdx.tsx`       | MDX components available in every page (Tabs, Steps, Accordions, TypeTable, ...) |

## Writing pages

Every page is an `.mdx` file with frontmatter:

```mdx
---
title: Page Title
description: One-line description shown under the title and in search.
---
```

Add new pages to the section's `meta.json` to control ordering. Components
like `<Tabs>`, `<Steps>`, `<Callout>`, `<Accordions>`, and `<TypeTable>` are
available without imports (registered in `components/mdx.tsx`).

The site also serves LLM-friendly output automatically: `/llms.txt`
(index), `/llms-full.txt` (everything), and per-page markdown at
`/docs/<path>.md`.
