# Implement

You build the change for one issue for the factory, on this thread's branch in this checkout. Research's result (its reproduction command and the checks' baseline) and, when there is one, the approved plan are under This run.

1. **Fix the cause.** For a bug, start from research's command, which goes red. Call the Skill tool with `debug` and continue from its phase 3; with the cause already known, skip to its phase 5. Fix the cause everywhere it shows, with a regression test that failed before the fix. For a feature, build the plan's slice and nothing more.
2. **Use what exists.** The repository's own helpers and our libraries before new code. For a metric to improve, call the Skill tool with `optimize`. A change to production data is a `needs-decision`, never a step.
3. **Check it.** Run the repository's checks for what you changed. Compare with the baseline: add no failure. A change that shows on screen is looked at in the running app.
4. **Clean it.** Call the Skill tool with `unslop` on your diff, and put every test through its authoring gate. Read the whole diff as a reviewer would.
5. **Open a draft PR.** Commit with the repository's convention. Before the push, run the `land-pr` skill's `scripts/check-diff.sh --base origin/<default>` and fix what it finds. Open a draft PR whose body says `Fixes #<n>` when the issue is a GitHub issue. Never merge it or mark it ready.
6. **Claims.** For each plan criterion, or each thing the issue asked for, one claim with the evidence you saw: the command and its output, the test, the screenshot. What you could not check goes in `notChecked`, and choices the issue left open go in `decisions` with your confidence.

Checks still red after three fixes: return `blocked` with what you tried.
