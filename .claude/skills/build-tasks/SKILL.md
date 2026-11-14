---
name: build-tasks
description: Split an agreed plan or technical document into self-contained task documents with a status index, and run them with parallel AI agents, one per ready task in its own git worktree (subagents, or T3 Code threads that each open a PR), merged into one integration branch. Use when asked to split a plan or scope into tasks, to build or run the tasks, to fan work out to parallel agents, or to resume a half-finished task set.
---

# Build from tasks

Two parts: **split** an agreed master document into task documents, then **run** them.

## Learn the repository first

Read the root and nearest `AGENTS.md` / `CLAUDE.md`. Note the lint, typecheck and test commands, how dependencies install, and the branch and commit conventions. They override this skill.

## Split

Follow [references/split.md](references/split.md). Before splitting, check that the master document is complete enough: every slice or feature entry in the approved work has acceptance criteria, and every interface it touches is written out.

Done when every task document exists, the index lists them all, and no file is owned by two tasks in the same phase. Show the index table and the open questions, and stop. Running is a separate yes.

## Run

You are the **orchestrator**: you own the integration branch and the index, and you write no feature code. Each task goes to an **implementer** in its own git worktree:

- **In T3 Code**: `delegate_task` with `isolation: "worktree"`. Prefer it to Claude Code's worktree-isolated subagents, whose guard refuses compound Bash calls.
- **In T3 Code, as threads** that each open a PR, when tasks take hours, need their own dev stack, or the user wants to steer each one: [references/threads.md](references/threads.md) replaces **Fan out** and **Merge and refill**.
- **Elsewhere**: the harness's worktree isolation, or `git worktree add`.

### Gate

1. Read `0.0 – index.md`. A task set with open questions that block the next phase stops here; ask them.
2. `git status --porcelain` must be clean apart from the tasks folder. Anything else: ask the user to commit, stash or confirm, because merges must not absorb unrelated work.
3. **Price the checks.** Time the repository's full check once. Above 60 s, implementers run lint and the tests their change touches, you run build, lint and those tests per merge, and the full check runs once per phase.
4. Show the phases, the `hitl` tasks, where the run will stop and the draft PR of step 11, and wait for a clear yes ("go", "yes"). A hedged answer is not approval. That one yes covers the whole run up to the stops below.

### Fan out

5. **Integration branch**: the current branch, or `feat/<slug>` when you are on the default branch.
6. Start one implementer per ready task (not Done, in the current phase), the starts in one message, at most 6 running at once unless the user names another number.
7. Brief each implementer with pointers, not copies: the absolute path of its task document in this checkout (the tasks folder is often gitignored, so a worktree lacks it), the integration branch name, its checks, and these instructions:
   - work on branch `task/<slug>-<id>` from the integration branch tip, and install dependencies;
   - build exactly the task's scope, inside its owned files;
   - run each git command as its own plain Bash call from the worktree root, with no `cd`, no heredoc and nothing chained to it; a harness-isolated subagent keeps every Bash call that plain and changes files with the edit tools;
   - put every test through `unslop`'s authoring gate, run the task's tests and its checks until green, then call the Skill tool with `unslop` on its own diff;
   - pass the Bash tool's `timeout` parameter (up to 600000) on every check: a shell `timeout` leaves the tool's 120 s limit in place, and past it a command moves to the background, where nothing wakes the implementer. Wait for it with `t3_background_wait` before ending the turn;
   - commit with the repository's convention, then bring the integration branch tip in with `git merge` only: a reset, rebase or squash onto the tip reverts every task merged since;
   - never edit the index, and report in a few lines: branch, commits, which acceptance criteria hold and how it showed them, anything blocked.

Set each started task's row to In progress.

### Merge and refill

8. When an implementer reports, run `git diff --name-only --no-renames <integration branch>...task/<slug>-<id>`. A path the task does not own and its report does not name is merged work reverted or work out of scope: send it back.
9. Merge the branch into the integration branch and run your checks there. A conflict goes to a merger subagent that resolves it there and runs them. Set the row to Done with the merge commit, and start the next ready task.
10. When an implementer stops on a usage limit, start no other, wait until the reset time the error states, then resume it.

### After each phase

11. When every task in the phase is Done, run the full check, push the integration branch, and start the next phase at once from the new tip. After phase 1, open the branch as a draft PR (`gh pr create --draft`), and after every push give its red checks (`gh pr checks`) to an implementer.

### Stop and ask

Stop before starting a `hitl` task, and ask when:

- an implementer's checks are still red after three fixes;
- a task document is ambiguous, contradicts the code, or needs a decision it does not contain (add it to the index's open questions);
- a task does something `git revert` cannot undo: auth or permission changes, destructive migrations, payments, deletes, deploys, secrets.

Implementers already running keep going. Running this skill again resumes from the index.

### Close

12. When every task is Done, call the Skill tool with `unslop` over the integration branch's whole diff against its base, for what only shows across tasks: duplicated helpers, two shapes for one thing.
13. **Done check.** Re-read the master document's Ask, when it has one, and every acceptance criterion in the task documents. For each, cite the evidence the implementer reported and check it still holds on the integration branch: rerun the test or command. A criterion without evidence is not done: start one more implementer for it, or list it in the report.
14. Remove every implementer worktree and every merged `task/<slug>-*` branch.
15. Report the tasks done, the merges, the done check, and anything skipped or flagged. Then mark the draft PR ready (`gh pr ready`) and call the Skill tool with `land-pr` on it, with each task's proof as its evidence; "full send" lands it unattended.

Without subagents, run the tasks one by one in index order on the integration branch, committing each one, scoped to its owned files.
