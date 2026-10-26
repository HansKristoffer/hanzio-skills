---
name: handoff-thread
description: Move a T3 Code thread, with its Claude session and its uncommitted code, to another machine through agentgate and carry on there, for example to run or verify work on an always-on server, or to bring a thread back to a laptop. Only applies when the session runs inside T3 Code with agentgate connected, which means the mcp__agentgate__agentgate__handoff_thread and mcp__t3-code__ tools are available; without both, do not use it. Use when asked to move, hand off, switch or continue a thread on the server or another machine, or to run something on a machine this session cannot reach.
---

# Hand off a thread

agentgate moves a T3 Code thread to another of the user's machines: the Claude session, the worktree's uncommitted files and its unpushed commits. The thread then continues on the target, in a new worktree on the same branch. It is the way to run work on another machine from inside a thread. Use it instead of SSH, which may be blocked by the tailnet's policy or need a sign-in the user has to approve.

## Check that it applies

Before anything else, confirm both tools are in this session's tool list:

- `mcp__agentgate__agentgate__handoff_thread` (agentgate)
- `mcp__t3-code__t3_thread_configuration` (T3 Code)

If either is missing, stop. Tell the user that moving a thread needs T3 Code with agentgate connected, and offer the plain route instead: commit and push, then pull and run it on the other machine.

A handoff interrupts the thread and moves the work, so only hand off when the user asked for it or agreed to it. Being told to make something work on a server is not, on its own, permission to move there.

## Before the handoff

1. **Pick the target.** `mcp__agentgate__agentgate__handoff_targets` lists every machine with `server` (always on) and `available`, plus the `reason` when one is not available (`offline`). Use the node name the user means. `to: "server"` picks the first available always-on machine.
2. **Get the thread id.** Call `mcp__t3-code__t3_thread_configuration` with no arguments. A thread that has already moved once has an id such as `import:claudeAgent:<session-id>`; use it as it is.
3. **Find what will not travel.** Only what git tracks or would track comes along. Run `git status --short` (what travels) and `git status --short --ignored` (what does not), then list everything else the work depends on:
   - ignored files: `.env` files and keys, build output, recordings, `node_modules`;
   - anything outside the repository: caches, browser profiles, tools downloaded to `/tmp`, shell environment variables;
   - running background jobs, dev servers and subagents. Let them finish or stop them first; none of them move.

   Secrets are the usual gap. Say up front which keys the target will need, and never copy a secret into the conversation to carry it across.
4. **Leave the next step in the thread.** On the target, the session starts from a summary with every earlier item left out, followed by "Continue where you left off". End your last message before the handoff with where the work stands, the exact next step and the list from step 3, so the target knows what to do without digging through the history.
5. **Hand off as the last action of the turn.** Call `mcp__agentgate__agentgate__handoff_thread` with `{ threadId, to }`. It returns `{ status: "started", handoffId, node, to }` and the turn ends right after. Do not run anything after it.

To move a different thread instead (the user names one), find its id with `agentgate threads` or `mcp__t3-code__t3_thread_list`. Moving another thread does not interrupt this one.

## On the target

The first message is a `Context handoff (manual_context)` note. Then:

1. **Confirm where you are.** `hostname`, `pwd`, `git branch --show-current` and `git status --short`. Compare the changed files with what you left; the worktree path is new, for example `~/.t3/worktrees/<repo>/<repo>-<handoffId prefix>`.
2. **Recover the context you need.** The note names the old thread id. Read the earlier turns with `mcp__t3-code__t3_thread_read` (`view: "activity"`, then follow `nextPosition`), or read the Claude transcript under `~/.claude/projects/` for this worktree. Read only what the next step needs.
3. **Rebuild what did not travel.** Install dependencies, regenerate ignored build output, and ask the user for any missing key. Absolute paths from the other machine (`/Users/...`) are stale; work from the new worktree.
4. **Run changed code from the worktree.** Skills and tools the target installed from GitHub (agentgate keeps `~/.claude/skills` in sync with the pushed repository) do not have the uncommitted changes. Run a changed skill from its path in the worktree, for example `bun .claude/skills/<skill>/<script>`, not from `~/.claude/skills`.
5. **Tell the user** that the thread is now on the target, and what did and did not come along.

The source machine keeps its old worktree with the changes as they were at the handoff. Make further changes, commits and pushes only on the target; once pushed, the old worktree is just a stale copy the user can remove.

To bring the thread back, hand it off again from the target with the original machine's node name.

## When a tool fails

- **An agentgate MCP call times out** (`upstream response timeout`): retry once. Then use the same operation through the CLI: `agentgate threads` (every machine, which ones are servers, and their threads), `agentgate handoff <threadId> --to <node>`, and `agentgate handoffs` (recent handoffs and their state).
- **The target is `offline`:** say so and let the user decide. Do not wait in a loop.
- **The handoff never arrives:** check `agentgate handoffs`. A handoff stuck before `done` is the user's to retry; report its id and state.
