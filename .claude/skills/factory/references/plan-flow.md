# The plan path

For an issue research routed to a plan: a feature of size M or L, a bug that needs a design or schema change, or anything with a one-way door.

1. **Plan.** `factory run --stage plan`; the service gives it research's result, including research's `undecided` questions. The result has the plan, its outline in a few bullets, at most five checkable criteria, the proof, the deduplicated questions only the user can settle (`undecided`), and the slices for later.
2. **Review the plan.** `factory run --stage review --on plan`; the service gives it the stored plan, never the planner's reasoning. It runs on the review model. When there are `important` findings, run `factory run --stage plan` once more so the planner addresses every finding (the service hands it the previous plan and the open findings). Stop plan review after that revision, unless the revision introduced a new one-way door (a new schema, storage bucket, migration or public API the first review never saw): then run one final plan review, and turn any finding still open into an `undecided` question.
3. **Ask the final questions and plan approval together.** Ask each question from the latest plan's `undecided` (`oneWay` blocking, the rest provisional; pass `--replaces <id>` if any earlier open question was superseded). When `settings.planApproval` is `always`, or is `auto` and the issue is a feature, size L, or has a one-way door, ask the plan approval in the same turn, with no temp file needed (the service attaches the latest stored plan automatically):

   ```bash
   factory ask --kind plan --question "Approve the plan for <title>?" --recommend Approve --option Approve --option Change
   ```

   End your turn. On the page, the user sees the plan's outline and all open choices together in one workbench: provisional questions default to their recommendation, blocking one-way choices require a pick, and one click submits every choice and approves (or revises) the plan. The user may also opt into auto-ship on approval (the service sets `autoShip: true`, so `merge: ask` clears automatically once CI and reviews are green and nothing unrelated changed). An answer other than a question's recommendation makes the plan stale: the service then answers the plan `Change` for the user, naming the questions that differ. "Change", from the user with feedback or from the service, starts one more plan run (the service gives it every answer; the user's feedback goes in `--context-file`), then one review and the approval again. After two rounds of user-requested changes, ask a `blocked` decision about how to go on. With `never`, or `auto` for a small bug, go on without asking and `factory report` that the plan was not shown.
4. **Carry the criteria.** The service gives implement the latest plan, which is the approved one, and its `claims` answer the criteria one by one. The land stage's done check reads the same criteria. The `later` slices become issues when the issue closes.

Nothing from the plan is written into the repository.
