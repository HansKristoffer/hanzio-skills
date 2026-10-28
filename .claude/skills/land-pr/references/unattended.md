# Full send and full stop

Use this only when the user explicitly says "full send" or "full stop", or asks in other clear words for an unattended run to the end. Then the user is not watching: your updates and final message go unread until long after you stop. You own the work from its current state to:

- **Full send:** a merged PR.
- **Full stop:** a PR that passes the merge gate, left open for the user to merge.

## What the request grants

- Every step of the normal workflow without asking: commits and pushes to this task's branch, replies to review bots and human reviewers, approval of this PR's pending workflow runs. It answers the merge question: full send merges at the merge gate, full stop leaves the PR open. Shipping a release-please release is included only when the user said so.
- The test methods the proof needs, even where a project file says to ask first or to leave testing to the user: browser automation, computer use, simulators and devices, running the app or a dev server, screenshots. Rules about how to test (the right command, fixture or check) still apply. The grant covers this task's tests only; production changes, data deletion and harness approval prompts stay outside it.
- Full stop never merges, enables auto-merge, enters a merge queue or pushes to the default branch. Before starting, turn off auto-merge if it is on (`gh pr merge "$PR" --repo "$REPO" --disable-auto`) and take the PR out of any merge queue; report both.

## Steps

1. **Finish the change.** Make the smallest change that meets the user's goal, and fix the case that happened. On the default branch, create a branch first.
2. **Prove it** (see **Proof**).
3. **Open the PR** with **Write the PR body**; its **Evidence** is your proof.
4. **Land it** with the normal loop: watch, fix CI, resolve conflicts, answer reviews. Prove each fix before you push it.
5. **Run the done check** (see **Done check**).
6. **Finish at the merge gate** from **Merge** in `SKILL.md`, with two more conditions: your proof covers every change in the final diff, and the done check has no line short of green. Full send merges; full stop stops.
7. **Report:** the PR link, the merge commit (full stop: the final head and that the PR is open and unmerged), the done check table, every decision you made for the user, and declined review items worth doing later.

Stay active from step 1 to step 7. Each turn ends with the PR watcher or a background wait running, because nobody will prompt you again. Stop the watch (`unwatch_pull_request`) only when you hand off or ask.

## Proof

Proof is evidence you observed yourself in this session: command output, a reproduction, a screenshot. Use the most direct kind the change allows:

- Reproduce the original failure, apply the fix, and watch the same reproduction pass.
- Run the checks CI runs (typecheck, lint, tests).
- Add one focused test that fails without the fix when the behavior has none and the repository has a test setup.
- For UI and runtime behavior, run the app and look at it; green mocked tests leave the user experience unproven.

A change you cannot prove is a reason to ask.

## Done check

Re-read what the user asked for in their own words: the message that started the task and every later message that changed it, plus the plan's acceptance criteria when there is one. Write one line per thing they asked for: the ask, the evidence, and how far it got, using the weakest level that is true:

- **claimed:** you say it is done, and nothing shows it yet;
- **pushed:** it is in a commit on the PR branch;
- **green:** it is proven (see **Proof**) and the checks passed on the final head;
- **merged:** it is on the base branch.

A line at claimed or pushed is not done: prove it, or ask. An ask you dropped on purpose gets its line too, with the reason.

## Asking

A question in a normal message goes unseen and the thread looks done. Ask with the harness's question tool (`AskUserQuestion` in Claude Code, `request_user_input` in Codex), with all the context inside it: the PR link, what blocks you, and the options with your recommendation first. Ask only when:

- you cannot prove the change;
- the merge gate cannot pass and you cannot fix that yourself;
- the budget in **Publish and continue** is spent;
- the next step is outside the grant;
- the diff makes a change the user's request did not name and that needs a person to agree to it: new or changed auth or permission logic, a new category of personal or payment data, CORS rules, a file upload handler, a destructive migration, payment flows, a deploy, or a secret;
- the goal is ambiguous in a way that changes the result;
- another PR makes this one obsolete.

Decide everything else with sensible defaults and list those decisions in the report. When there is no question tool or it returns no answer, take the safe path: leave the PR open and unmerged, and start the final message with the question.
