---
name: build-tasks
description: Split an agreed plan or technical document into self-contained task documents with a status index, and run them with parallel AI agents, one per ready task in its own git worktree, merged phase by phase into one branch. Use when asked to split a plan or scope into tasks, to build or run the tasks, to fan work out to parallel agents, or to resume a half-finished task set.
---

# Build from tasks

Two parts: **split** an agreed master document into task documents, then **run** them. Either can happen alone; a task set someone else split can be run, and a split can be handed to people who run each task by hand.

## Learn the repository first

Read the root and nearest `AGENTS.md` / `CLAUDE.md`. Note the lint, typecheck and test commands, how dependencies install, and the branch and commit conventions. They override this skill.

## Split

Follow [references/split.md](references/split.md). Before splitting, check that the master document is complete enough: every slice or feature entry in the approved work has acceptance criteria, and every interface it touches is written out. Gaps become open questions in the index; never invent the answer.

Done when every task document exists, the index lists them all, and no file is owned by two tasks in the same phase. Show the index table and the open questions, and stop. Running is a separate yes.

## Run

You are the **orchestrator**: you own the integration branch and the index, and you write no feature code.

### Gate

1. Read `0.0 – index.md`. A task set with open questions that block the next phase stops here; ask them.
2. `git status --porcelain` must be clean apart from the tasks folder. Anything else: ask the user to commit, stash or confirm, because merges must not absorb unrelated work.
3. Show the phases, the `hitl` tasks and where the run will stop, and wait for a clear yes ("go", "yes"). A hedged answer is not approval. That one yes covers the whole run up to the stops below.

### Fan out

4. **Integration branch**: the current branch, or `feat/<slug>` when you are on the default branch.
5. For each ready task (every task in the current phase that is not Done), start one implementer subagent, all in the same message, each in its own git worktree on branch `task/<slug>-<id>` from the integration branch tip. Use the harness's worktree isolation when it has one; otherwise create the worktree yourself with `git worktree add`.
6. Brief each implementer with pointers, not copies: the absolute path of its task document in this checkout (the tasks folder is often gitignored, so a worktree lacks it), the integration branch name, and these instructions:
   - check the worktree starts at the integration branch tip, and install dependencies;
   - build exactly the task's scope, inside its owned files;
   - put every test through `unslop`'s authoring gate, run the task's tests and the repository's checks until green, then call the Skill tool with `unslop` on its own diff;
   - commit with the repository's convention, then merge the integration branch tip into its branch;
   - never edit the index, and report in a few lines: branch, commits, which acceptance criteria hold and how it showed them, anything blocked.

Set each started task's row to In progress.

### Merge and refill

7. As each implementer reports, merge its branch into the integration branch and run the repository's checks there. A conflict goes to a merger subagent that resolves it on the integration branch and runs the checks. Set the row to Done with the merge commit.
8. When every task in the phase is Done, start the next phase at once, from the new integration tip.

### Stop and ask

Stop before starting a `hitl` task, and ask when:

- an implementer's checks are still red after three fixes;
- a task document is ambiguous, contradicts the code, or needs a decision it does not contain (add it to the index's open questions);
- a task does something `git revert` cannot undo: auth or permission changes, destructive migrations, payments, deletes, deploys, secrets.

Implementers already running keep going. Running this skill again resumes from the index.

### Close

9. When every task is Done, call the Skill tool with `unslop` over the integration branch's whole diff against its base, for what only shows across tasks: duplicated helpers, two shapes for one thing.
10. **Done check.** Re-read the master document's Ask, when it has one, and every acceptance criterion in the task documents. For each, cite the evidence the implementer reported and check it still holds on the integration branch: rerun the test or command, since it may have passed only on the task branch. A criterion without evidence is not done: start one more implementer for it, or list it in the report.
11. Remove every implementer worktree and every merged `task/<slug>-*` branch.
12. Report the tasks done, the merges, the done check, and anything skipped or flagged. Then call the Skill tool with `land-pr` to open the PR for the integration branch, with each task's proof as its evidence; "full send" lands it unattended.

Without subagents, run the tasks one by one in index order on the integration branch, committing each one, scoped to its owned files.
