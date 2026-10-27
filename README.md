# hanzio-skills

Agent skills for Claude Code and Codex, built for TypeScript monorepos (Bun or Node, Prisma, Zod, oRPC, [hanzio](https://github.com/HansKristoffer/hanzio), Vue or React/Expo). Each skill reads the repository's own `AGENTS.md` first and lets it win.

| Skill | Use it to |
| --- | --- |
| [build-engine](.claude/skills/build-engine/SKILL.md) | Design and build a typed domain engine end to end: contracts, pure logic, adapters to an external system, a durable runtime and a UI driven by the engine's manifest |
| [build-tasks](.claude/skills/build-tasks/SKILL.md) | Split an agreed plan or scope into self-contained task documents with a status index, then run them with parallel agents, one per task in its own worktree, merged phase by phase and landed as one PR |
| [debug](.claude/skills/debug/SKILL.md) | Find the cause of a bug, flaky test or slowdown: build a command that fails on the exact symptom before forming any theory, test ranked hypotheses against it, and keep it as the regression test |
| [grill](.claude/skills/grill/SKILL.md) | Interview in rounds until a plan has no open decisions: every question that can be answered now, each with a recommended answer, and every fact looked up instead of asked |
| [handoff-thread](.claude/skills/handoff-thread/SKILL.md) | Move a T3 Code thread, with its Claude session and uncommitted code, to another machine through agentgate (for example to run or verify work on a server), and carry on there. Only for sessions in T3 Code with agentgate connected |
| [land-pr](.claude/skills/land-pr/SKILL.md) | Open a PR or rewrite its body (problem first, summary diagram, evidence, merge danger), watch its checks and review bots, resolve conflicts, fix failing CI and real review findings until it is green, then merge it and ship a release-please release when asked. Say "full send" to finish, prove and merge a change unattended, or "full stop" to stop before the merge |
| [our-libs](.claude/skills/our-libs/SKILL.md) | Pick which of our npm packages (hanzio, orpc-fn, better-mastra, better-graphile-worker, measurr, buncargo, expo-release and more) a new or existing project should adopt, what local code each replaces, and how to set it up; links each repo, whose README stays the source of truth |
| [plan](.claude/skills/plan/SKILL.md) | Plan a change in an existing repo before building it: size it, settle the decisions, and write numbered decisions, exact interfaces, vertical slices with checkable criteria and a proof for each, reviewed by a second model |
| [postgres-tuning](.claude/skills/postgres-tuning/SKILL.md) | Audit and optimize a Postgres database behind our Prisma apps: run a read-only audit script, rank the findings in a report, fix them with lock-safe migrations or code changes, and measure before and after. |
| [product-video](.claude/skills/product-video/SKILL.md) | Make professional product videos: launch films, explainers, demos and walkthroughs that mix frame-exact motion graphics with real product footage, scored and voiced with ElevenLabs, checked by measurement and an independent critic |
| [retro](.claude/skills/retro/SKILL.md) | Look back over a session and propose changes to the environment, not the code: checks for mechanical mistakes, steering, navigation, and fixes to our own skills |
| [scheduled-agents](.claude/skills/scheduled-agents/SKILL.md) | Set up and review agents that run unattended on a timer or webhook: production checks after merges, flaky test reports, error and feedback triage, with fixed windows, a write boundary, duplicate checks, caps and a weekly review that proposes prompt fixes |
| [scope-new-project](.claude/skills/scope-new-project/SKILL.md) | Turn a new consulting project's emails, notes, transcripts and designs into a scope checklist with price, phases and questions for the customer, a technical document and a draft reply, using the template repository it runs in to see what must be built; then split the agreed scope into self-contained task documents for parallel AI agents |
| [unslop](.claude/skills/unslop/SKILL.md) | Clean up code, tests and prose after a change: AI artifacts, typed contracts, low-value tests, AI-sounding text |

Install by copying or symlinking a skill folder into a project's `.claude/skills/` (Claude Code) or `.agents/skills/` (Codex), or into `~/.claude/skills/` for every project.
