# Land

The PR reaches this file when `factory gate` says `ready` (see `review-loop.md`). The gate holds every condition the factory adds: the reviews, the approvals, the risk verdict, the decisions and the project's `merge` setting. What is left is `land-pr`'s own gate, the merge and the deploy check.

1. **`land-pr`'s gate.** Call the Skill tool with `land-pr` and follow its **Merge** section: the branch is not behind its base in a way the repository forbids, the base's newer commits do not overlap the change, the done check has no line short of green, and the head did not move. Anything that fails and you cannot fix is a `blocked` decision.
2. **Merge** with `land-pr`'s command, guarded by `--match-head-commit` on the head the gate was `ready` for. Never `--admin`, and never past branch protection.
3. **Check the deploy** with `land-pr`'s **Check the deploy**, as the land run's note says. Ship a release-please release only when the note says so.
4. **End the run:** `factory report --run <land run> --done -` with the merge commit and the deploy result on stdin.

With the project's `merge` set to `never`, people merge: the gate says `merge-setting`, and you wait on the merge (`factory wait --on merge`). When the PR is merged, check the deploy (step 3) and end the run (step 4). When it is closed without a merge, close the issue as `dropped`.

**Questions** go through `factory ask`, never the question tool: where `land-pr` would stop and ask, ask a `blocked` decision and end the turn.

## The deploy result

`verified` when every check in `land-pr`'s "Check the deploy" passed; `unverified` when the deploy finished but a check could not be made (say which in the report); `none` when merging does not deploy.

## The closing overview

The report file for `factory close`, readable in a minute:

```markdown
**<title>** (new / came back): Shipped / Waiting for your merge / Stopped, needs an answer / Not ours to fix
**What happened:** what failed or what was asked, for whom and how often, in one or two sentences.
**Cause:** the root cause in plain words. "None" for a feature.
**Fix:** what changed, in behavior terms, not file names. "None" if you stopped.
**Review:** who reviewed, how many rounds, what was declined and why. "None" if nobody reviewed.
**Deploy:** verified / unverified (what was not checked) / none.
**Be aware of:** what was left out, what a reviewer should check, anything unverified. "Nothing" if there is nothing.
**Links:** the PR, the item, any earlier PR.

| Asked for | Evidence | Level |
| --- | --- | --- |
| <each thing the item asked for, and each plan criterion> | <the test, command or check> | claimed / pushed / green / merged |
```
