# Land

`factory run --stage land` starts the land run and answers with the project's land note: how it deploys, how to check it, and whether to ship its release. Then call the Skill tool with `land-pr` and follow its **full send** (`references/unattended.md` there) from its step 2, since the change exists: prove it, write the PR body, watch, fix CI, answer reviews, run the done check, merge at the gate, check the deploy.

## What changes for a factory thread

- **Mark the PR ready first.** Implement opened a draft, and a draft cannot be merged. Once the last internal review of the head is clean, run `gh pr ready <number>` before `land-pr`'s step 2, since many workflows and review bots run only on a ready PR.
- **Questions.** Where `land-pr` would ask with the question tool, ask a factory decision instead (`decisions.md`): its budget running out (three pushed fixes, 60 minutes, the same failure twice) and a step outside its grant are `blocked`; a merge it cannot make is `merge`. End the turn and wait.
- **The PR body.** Its **Evidence** is the implementer's claims with their evidence, plus anything you proved yourself; its **Merge Danger** comes from the last review's `risk`.
- **The merge gate** gets four more conditions. Merge only when all hold:
  - a review of the PR's current head found no `important` finding (dropped when `reviewRounds` is 0); a push after the last review needs another round first;
  - `factory status` shows `mergeHeld: false`;
  - none of the leave-open rules in the `dispatched-run` skill's step 7 holds (a flow change, money, a migration or data change, new access, a new outbound call, over about 400 lines, something unverified, a second fix for an item that came back);
  - the starting message allows merging. "Never merge" means a `merge` decision on every PR.

  When one fails and you cannot fix it, ask a `merge` decision with what failed and your recommendation, and end the turn.
- **Release.** Ship a release-please release only when the land note says so.
- **End the run.** After the deploy check: `factory report --run <land run> --done -` with the merge commit and the deploy result on stdin.

## The deploy result

`verified` when every check in `land-pr`'s "Check the deploy" passed; `unverified` when the deploy finished but a check could not be made (say which in the report); `none` when merging does not deploy.

## The closing overview

The report file for `factory close`, readable in a minute:

```markdown
**<title>** (new / came back): Shipped / Waiting for your merge / Stopped, needs an answer / Not ours to fix
**What happened:** what failed or what was asked, for whom and how often, in one or two sentences.
**Cause:** the root cause in plain words. "None" for a feature.
**Fix:** what changed, in behavior terms, not file names. "None" if you stopped.
**Deploy:** verified / unverified (what was not checked) / none.
**Be aware of:** what was left out, what a reviewer should check, anything unverified. "Nothing" if there is nothing.
**Links:** the PR, the item, any earlier PR.

| Asked for | Evidence | Level |
| --- | --- | --- |
| <each thing the item asked for, and each plan criterion> | <the test, command or check> | claimed / pushed / green / merged |
```
