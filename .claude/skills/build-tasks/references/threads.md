# Running tasks as T3 Code threads

Each ready task runs in its own top-level T3 Code thread instead of a subagent. The thread opens a PR into the integration branch, and you merge it. This replaces **Fan out** and **Merge and refill** in `SKILL.md`; the **Gate**, **Stop and ask** (as changed below) and **Close** still apply.

## The delivery rules file

Write it once, before the first launch, beside the task documents or in a folder outside the repository, and point every launch message at it by its absolute path. It holds what every task thread needs and the task documents leave out:

- **Who you are**: your own thread's id, which this thread's link carries (`t3_thread_list` with `titleContains` set to this thread's title also finds it), and that the thread reports to it.
- **Branch and ownership**: its own worktree on `task/<slug>-<id>` from the integration branch; push to that branch only; never push to or merge into the integration branch, the default branch or a release branch such as `staging`. Edit only the files its task owns, plus a test fixture or assertion its own contract change broke (fixed in its PR and listed there). Anything else it must change: report it.
- **Environment**: never edit an `.env*` file, never `cat` it or split its lines (they hold multi-line private keys); let Bun or buncargo load it and pass single named variables through. List new keys in the PR.
- **Checks**: the commands, and the baseline on the integration branch where it is not clean ("typecheck has 84 errors on the base; add none"). CI often runs less on PRs into an integration branch, so the thread runs the checks locally and pastes the results into its PR. How to start its own dev stack, and to stop it when done.
- **Before the PR**: put every test through the `unslop` authoring gate, run `unslop` on its diff, rebase onto the integration branch's tip when that is clean, and open a ready PR titled `<slug> <id>: <name>`.
- **Reports**, below.
- **Background work**: never end the turn while its own evals, servers or measurements still run, since nothing wakes it when they finish.

The launch message adds what is particular to one task: decisions the user made after the split, and notes from tasks already merged. They win over the task document.

## Launch

For each task whose dependencies are all merged and whose files no running task owns, without waiting for the rest of its phase:

- `t3_thread_launch` with `title: "<slug> <id>: <name>"`, `workspaceStrategy: { "type": "worktree", "baseRef": "<integration branch>", "branch": "task/<slug>-<id>", "startFromOrigin": true }` and `clientRequestId: "<slug>-<id>"`. Push the integration branch first, since the worktree starts from origin.
- `message`: the task document's absolute path (the tasks folder is often gitignored, so the worktree lacks it), the delivery rules file's path, and the task's notes.
- Set the task's row to In progress, with the thread's link.

## Reports

Threads report with `t3_thread_send` to your thread, `mode: "queue"`, one message per event:

- `[<id> DONE]`: the PR link and a short summary, deviations from the task document, values for the user to review, blockers (environment keys, manual steps), notes later tasks need, and the local check results.
- `[<id> BLOCKED]`: the question, the facts and the options, recommendation first. The thread keeps building whatever the question does not block.

When you are busy, reports and scheduled checks queue up behind each other. Read them with `t3_queue` (`list`, then `read`), and `cancel` the duplicates of what you already handled.

## Answer without stopping

A question asked with the question tool in your thread stops every task until the user answers: in one build a single unanswered question stalled everything for 22 hours. So:

- answer from the plan, the task documents or another task's result when they settle it;
- otherwise give the thread your recommendation as a provisional answer, tell it to build with it, mark its PR's merge as held, and put the question in the index's open questions and in your next message to the user;
- use the question tool only for a one-way door no provisional answer can cover, and keep the other threads running meanwhile.

## Merge

When a thread reports DONE, read its PR's diff and checks, then merge it with the repository's merge method and `--match-head-commit`. A held PR waits for its answer. After each merge, run the checks on the integration branch's tip and compare them with the baseline. Set the row to Done with the PR link.

A merge can make other open PRs conflict, or change something they use. Tell each affected running thread, with `t3_thread_send`: what merged, the new tip, and what to rebase or adjust. Add notes later tasks need to the index, and pass them on in those tasks' launch messages.

## Keep them moving

Schedule a check every 30 minutes with `schedule_task`, bound to your thread. Each run:

- reads each running task thread's latest messages (`t3_thread_read` with a small `limit`);
- sends a thread that stopped without reporting what is expected of it, never a bare "continue";
- launches every task that has become ready;
- ends silently when nothing changed.

Pause it (`schedule_task` with its `scheduledTaskId` and `enabled: false`) whenever no task thread is running, and enable it again when you launch one.

## Where the state lives

The index is the state: each row's status, thread link, PR and whether its merge is held. Add a **Run notes** section to it with your thread's id, the user's decisions with their dates, the baselines, and the notes for later tasks. Running the skill again resumes from it.

## Close

As in `SKILL.md`. Worktrees outlive their threads, so remove each merged task's worktree (`git worktree remove`) and delete its merged branch on origin.
