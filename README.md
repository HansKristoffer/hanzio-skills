# hanzio-skills

Agent skills for Claude Code and Codex, built for TypeScript monorepos (Bun or Node, Prisma, Zod, oRPC, [hanzio](https://github.com/HansKristoffer/hanzio), Vue or React/Expo). Each skill reads the repository's own `AGENTS.md` first and lets it win.

| Skill | Use it to |
| --- | --- |
| [land-pr](.claude/skills/land-pr/SKILL.md) | Watch a PR's checks, resolve conflicts, fix failing CI until it is green, and ship a release-please release when asked |
| [unslop](.claude/skills/unslop/SKILL.md) | Clean up code, tests and prose after a change: AI artifacts, typed contracts, low-value tests, AI-sounding text |

Install by copying or symlinking a skill folder into a project's `.claude/skills/` (Claude Code) or `.agents/skills/` (Codex), or into `~/.claude/skills/` for every project.
