# Chatpack agent skills

[Agent Skills](https://agentskills.io) are folders of instructions that coding
agents (Claude Code, Cursor, Codex, ...) load on demand. Installing the
`chatpack` skill teaches your agent the correct integration workflow - the one
handler + catch-all mount, the real `chat.api` surface, iframe-proof demo auth,
and the verification steps - so it gets Chatpack right on the first shot
instead of hallucinating routes and methods.

## Install into your app's repo

The [skills CLI](https://github.com/vercel-labs/skills) installs into every
agent's directory layout (`.claude/skills/`, `.cursor/skills/`, ...):

```sh
npx skills add chddaniel/chatpack
```

Or copy it manually - the skill is a single file:

```sh
# Claude Code
mkdir -p .claude/skills/chatpack && curl -o .claude/skills/chatpack/SKILL.md \
  https://raw.githubusercontent.com/chddaniel/chatpack/main/skills/chatpack/SKILL.md

# Cursor
mkdir -p .cursor/skills/chatpack && curl -o .cursor/skills/chatpack/SKILL.md \
  https://raw.githubusercontent.com/chddaniel/chatpack/main/skills/chatpack/SKILL.md
```

(Cursor also reads `.claude/skills/` for compatibility, so one copy is enough.)

## No skills support? (AI app builders: Lovable, v0, Bolt, ...)

Paste this into the builder's chat instead:

> Before writing any code that uses Chatpack, fetch and follow
> https://raw.githubusercontent.com/chddaniel/chatpack/main/llms.txt -
> especially the hard rules, the mount recipe for this framework, the
> iframe-proof demo-auth cookie, and the verification steps.

The same guide also ships inside every `@chatpack/*` npm package as
`node_modules/@chatpack/core/llms.txt`.

## What's here

| Skill                             | What it covers                                                                                                             |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| [`chatpack`](./chatpack/SKILL.md) | Full integration workflow: decisions → wiring → mount → verify → troubleshoot, plus when to write a custom storage adapter |

The skill intentionally stays a lean procedure and defers to
[`llms.txt`](../llms.txt) as the single source of truth for the route table
and the custom-adapter contract - one fact, one home.
