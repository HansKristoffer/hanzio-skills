---
name: retro
description: Run a retrospective on a coding session and suggest changes to the agent's environment (checks, steering, docs, our skills), not to the code.
disable-model-invocation: true
---

# Retro

Look back over a session and suggest changes to the agent's **environment**, so the next run starts from a better place. Apply nothing until the user picks.

## Steps

1. Call the Skill tool with `writing-for-agents` for how to write steering text.
2. **Read the session**: this one unless the user names another, whose transcript you then find on this machine. Redact secrets when you quote it.
3. **Read the environment** before proposing anything new: the repository's and the global `AGENTS.md` / `CLAUDE.md`, its lint, typecheck and test commands, pre-commit hooks and CI workflows, and the skills the session used. A check that exists but is unwired or broken is the finding, not a new check.
4. **Find candidates** in every category below. Done when each category has a candidate or "nothing found".
5. **Present them most severe first**, each with its evidence from the session (what happened, where) and the exact change: the file, and the text before and after. Apply only what the user picks.

## Categories

- **Automated checks**: a mistake a lint rule, type, test, hook or CI job could have caught, or a repository with no guardrail at all (no hook and no CI running lint, types and tests). A **mechanical** rule (a banned API, an import shape, a file location, a syntactic pattern) becomes a check, never a line of prose.
- **Navigation**: the session took long to find a file or a fact. The fix is a pointer where the agent would have looked.
- **Coding standards**: the review missed something, or a rule needs removing or clarifying. Judgement calls only; mechanical ones are checks.
- **Steering**: lines in `AGENTS.md` / `CLAUDE.md` that belong in a check, a doc or a skill, and lines that change nothing (no-ops).
- **Tool economy**: expensive or token-heavy calls that a cheaper call or a script would replace.
- **Information access**: something the agent needed and could not see: dev server logs, a read-only view of a third-party service, a seed.
- **Bug prevention**: after `debug`, what would have prevented the bug. No good test seam, tangled callers or hidden coupling is an architecture finding; name the modules.
- **Our skills**: a skill of ours that misled the agent, missed a step, fired when it should not have, or did not fire when it should have. The fix is an edit to that skill in the `hanzio-skills` repository (github.com/HansKristoffer/hanzio-skills), which every project picks up on its next update. Installed copies are not the source: propose the edit against a checkout of that repository, quoting the skill and line.

## Where things go

The implementer carries the most context; the reviewer gets a diff and little else. So the reviewer enforces standards, and the implementer's always-loaded files stay small.

- `AGENTS.md` / `CLAUDE.md`: loaded into every session. Pointers only, and only lines whose absence causes mistakes on many tasks. A new line pushes out an old one.
- `CODING_STANDARDS.md` or the repository's equivalent: read at review time.
- Docs: reference other files point at. Extend an existing one before writing a new one.
- Skills: knowledge loaded on demand, and commands the user types.
