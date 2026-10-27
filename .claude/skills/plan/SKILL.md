---
name: plan
description: Plan a feature or change in an existing repository before building it - size it, settle every open decision with the user, and write a plan with numbered decisions, exact interfaces, vertical slices with checkable acceptance criteria and the proof for each slice, reviewed by a second model before any code is written. Use when asked to plan, spec or design a change, when a request is too big or too fuzzy to build directly, or before splitting work for parallel agents. Built for TypeScript monorepos (Bun or Node, Prisma, Zod, oRPC, hanzio, Vue or React/Expo); reads the repository's own rules first and lets them win.
---

# Plan a change

Input: a feature, change or idea, in the conversation or a ticket. Output: one plan document that a builder with no context can work from, and that `land-pr` can later prove the change against.

For a new customer project with a price and a scope to agree, use `scope-new-project` instead. For a new domain engine, `build-engine` has its own design doc and work packages.

## Learn the repository first

Read the root and nearest `AGENTS.md` / `CLAUDE.md` for every area the change touches, and the docs they point at. Those rules override this skill. Note where the repository keeps plans or specs, its glossary if it has one, and its lint, typecheck and test commands.

## 1. Size it

| Size | Looks like | What to do |
| --- | --- | --- |
| S | One commit, no open decisions | No plan. Say so in one line and build it; for a bug with an unknown cause, call the Skill tool with `debug`. |
| M | One slice or a few, a decision or two open | A short plan: one round of questions, then the document. |
| L | Several slices, several modules, or a fuzzy goal | The full plan below. |

A **one-way door** (a schema change, a public API, a data migration, a new vendor) moves the change up one size. When the user asked for a plan, write one even for an S, and keep it short.

## 2. Get the facts

Find out what exists before deciding anything. Use read-only explore subagents for the sweep when the harness has them.

- The current state: the data models, routes, jobs and screens the change touches, with real file paths.
- What can be reused: shared packages, utilities and our own libraries (the `our-libs` skill lists them). A plan that rebuilds what the repository already has is the most common planning mistake.
- External systems and libraries: read the docs for the installed version (the lockfile says which), not what you remember. Probe any assumption the plan rests on (idempotency, limits, error shapes) and record the result.

Done when every fact a decision depends on is written down with its source, and every claim you could not verify is marked as unverified.

## 3. Settle the decisions

Call the Skill tool with `grill`. Decisions are recorded in the plan's Decisions section. For an M, the first round is often the only one.

## 4. Write the plan

Put it where the repository keeps plans. Without a convention, use `.plans/<slug>.md` when `git check-ignore -q .plans` succeeds, otherwise ask. Use [references/template.md](references/template.md).

- **Interfaces are given, not designed.** Every type, route, table, event and job the slices share is written out exactly, so two builders cannot invent two shapes for it.
- **Slices are vertical.** Each slice goes through every layer it needs (schema, service, API, UI, tests) and can be shown working on its own. Name it by what you can demo when it is done ("Revenue visible end to end"), never by a layer. An "and" in the title means two slices.
- **Every acceptance criterion is checkable**: it names a test, a command, or a file and its content. A slice with more than five criteria is two slices.
- **Order the slices.** Foundations everything depends on (schema, shared types, contracts) come first. A wide mechanical change (renaming a column, retyping a shared symbol) goes expand, then migrate in batches, then contract, so every step stays green.
- **Mark `hitl`** on a slice that needs a person partway: credentials, a design call, manual setup, access to an external service.

## 5. Plan the proof

For each slice, write how you will show it works, with the most direct evidence it allows:

- a reproduction that fails before and passes after;
- a focused test that fails without the change;
- the checks CI runs;
- the running app, looked at, for UI and runtime behavior.

This becomes the **Evidence** in the PR body that `land-pr` writes, and the proof an unattended "full send" requires. A slice you cannot plan a proof for is a slice to rethink.

## 6. Review the plan with a second model

Before any code, have the plan reviewed by a subagent on a different model when the harness offers one, otherwise by a fresh subagent. Brief it with the plan's path and the repository, never with your own conclusions. Ask it to report, citing plan lines and files:

- decisions that contradict the code or each other;
- requirements with no slice, and slices nobody asked for;
- interfaces that do not match the code they extend;
- criteria that cannot be checked, and proofs that would not prove anything;
- claims about tooling or libraries the plan did not verify.

Fix each finding or answer it in the plan's review log. Two rounds at most; whatever is still open after that is a question for the user.

## 7. Hand off

Reply with the plan's path, one line per slice, and the open questions. End with the next step:

- one or a few slices: build slice 1, then call the Skill tool with `unslop` and land it with `land-pr` ("full send" runs that unattended);
- many slices, or work to run in parallel: call the Skill tool with `build-tasks` to split the plan and run it.

## When the plan changes

Rewrite the sections the change touches; never append a changelog. Record the new decision with its source and date. If tasks have been split from the plan, update the unstarted ones and their index.
