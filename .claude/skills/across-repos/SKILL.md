---
name: across-repos
description: Make the same change in many repositories at once (upgrade Bun or a shared dependency, adopt one of our libraries, roll out a tool, a config or a CI change), from one brief with the user's words, tried on one repository first, then one thread per repository in its own worktree, each landing its own PR, tracked in one table. Use when asked to do something "in all our repos", in a list of repositories, in every repo that uses a package, or to open one thread or PR per repository.
---

# Across repositories

The same change in ten repositories is ten small projects that share one brief. Write the brief once, try it on one repository so its surprises land in the brief instead of in ten threads, then run the rest in parallel and keep one table of where each stands.

This skill coordinates. The repositories' own `AGENTS.md` / `CLAUDE.md` decide how each one is built, tested and released, and each thread reads its own.

## 1. List the repositories

Use the list the user gave. For "every repo that uses X", search each owner the user works in (personal and organization accounts separately), and check the result against the user's T3 projects:

```bash
gh search code '<package-name>' --owner <owner> --filename package.json --json repository,path \
  --jq '.[] | "\(.repository.nameWithOwner) \(.path)"'
```

Code search only reads default branches and lags behind pushes, so confirm each hit by reading its `package.json`. Drop archived repositories and forks the user does not maintain. Show the list and the ones you dropped, with why, before going further.

**Done when** every repository has a T3 project (`t3_project_list`) or is marked as having none. Ask before adding one.

## 2. Write the brief

One brief serves every repository. Put it in a file outside every repository (beside the checkouts, or where the user keeps briefs) and point every thread at it by its absolute path, so a fix to the brief reaches threads that start later. It holds:

- **The ask**: the user's words, quoted verbatim, links included.
- **The change**: what to do, as steps a repository can follow without this conversation: the versions, the commands, the config to add, the docs to read (link the release notes or the library's README).
- **First, read the repository**: its `AGENTS.md` / `CLAUDE.md`, package manager, scripts and CI. Its rules win over the brief.
- **Not applicable**: when the change does not fit this repository (it does not use the package, it is already done, the tool clashes with something it relies on), say why in the report and stop. No PR.
- **Done when**: the repository's checks pass with the change, and what proves the change itself works there (the new command runs, the old one is gone).
- **Landing**: open a PR, follow the `land-pr` skill, and how far to go: leave it open, merge it, merge and release. Take this from the user's words ("and merge it in", "ship a new release"); without them, leave the PR open.
- **Report**: the last message ends with one line, `<repo>: <PR url> <merged | open | not applicable | blocked> <one-line reason>`, followed by anything the brief got wrong or left out.

## 3. Try it on one repository first

Pick the one most like the rest, not the easiest. Run it as in step 4, alone, and read its result. Everything it had to work out (a flag that changed, a config that conflicts, a check that needed updating) goes into the brief before the others start.

**Done when** the first repository's PR is green, or its report explains why the change does not fit, and the brief has its lessons.

## 4. Start one thread per repository

For each remaining repository, `t3_thread_launch` with:

- `projectId`: the repository's T3 project;
- `title`: `<repo>: <change in a few words>`;
- `workspaceStrategy`: `{ "type": "worktree", "baseRef": "<default branch>", "branch": "<kind>/<slug>", "startFromOrigin": true }`, with a branch name that follows the repository's convention (`chore/bun-1-4-4`);
- `clientRequestId`: `<slug>-<repo>`, reused on a retry so a lost reply does not start a second thread;
- `message`: the brief's path, the repository's name, and anything particular to it.

Start them a few at a time (five is a good batch). Every `land-pr` watcher on the account spends the same GitHub GraphQL rate limit, and a burst of PRs exhausts it.

Without T3 Code, run the repositories one after another in this session, each in its own worktree (`git -C <repo> fetch origin <default>`, then `git -C <repo> worktree add <path> -b <branch> origin/<default>`), with the same brief.

## 5. Track them

Keep one table in this thread, updated as reports arrive:

| Repository | Thread | PR | State | Note |
| ---------- | ------ | -- | ----- | ---- |

Wait for each thread with `t3_thread_wait`. On a timeout with `next`, end your turn and follow it; never poll in a loop. A thread that reports blocked gets one answer from you when the brief or another repository's result settles it. Otherwise the question goes in the table for the user.

When one thread learns something the others need (the same conflict in two repositories), add it to the brief and send it to the threads still running with `t3_thread_send`.

## 6. Finish

Report the table, with every repository in exactly one state: merged, open (and why), not applicable (and why), or blocked (with the question). End with the lessons that changed the brief and whether any belong in the shared library or skill itself, for example a bug in our package that every repository had to work around.
