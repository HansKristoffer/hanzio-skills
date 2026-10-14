# hanzio-skills

Agent skills for Claude Code and Codex, built for TypeScript monorepos (Bun or Node, Prisma, Zod, oRPC, [hanzio](https://github.com/HansKristoffer/hanzio), Vue or React/Expo). Each skill reads the repository's own `AGENTS.md` first and lets it win.

| Skill | Use it to |
| --- | --- |
| [build-engine](.claude/skills/build-engine/SKILL.md) | Design and build a typed domain engine end to end: contracts, pure logic, adapters to an external system, a durable runtime and a UI driven by the engine's manifest |
| [land-pr](.claude/skills/land-pr/SKILL.md) | Open a PR or rewrite its body (summary diagram, evidence, merge danger), watch its checks, resolve conflicts, fix failing CI until it is green, then merge it and ship a release-please release when asked |
| [product-video](.claude/skills/product-video/SKILL.md) | Make professional product videos: launch films, explainers, demos and walkthroughs that mix frame-exact motion graphics with real product footage, scored and voiced with ElevenLabs, checked by measurement and an independent critic |
| [scope-new-project](.claude/skills/scope-new-project/SKILL.md) | Turn a new consulting project's emails, notes, transcripts and designs into a scope checklist with price, phases and questions for the customer, a technical document and a draft reply, using the template repository it runs in to see what must be built; then split the agreed scope into self-contained task documents for parallel AI agents |
| [unslop](.claude/skills/unslop/SKILL.md) | Clean up code, tests and prose after a change: AI artifacts, typed contracts, low-value tests, AI-sounding text |

Install by copying or symlinking a skill folder into a project's `.claude/skills/` (Claude Code) or `.agents/skills/` (Codex), or into `~/.claude/skills/` for every project.
