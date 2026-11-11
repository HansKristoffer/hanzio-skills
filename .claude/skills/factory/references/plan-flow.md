# The plan path

For an issue research routed to a plan: a feature, an unclear design, a change of size M or L, or anything with a one-way door.

1. **Plan.** `factory run --stage plan` with research's result in the context. The result has the plan, at most five checkable criteria, the proof, the questions only the user can settle (`undecided`), and the slices for later.
2. **Review the plan.** `factory run --stage review --on plan` with the plan in the context, never the planner's reasoning. It runs on the review model. `important` findings go to one more plan run, with the findings in its context. Two review rounds at most; a finding still open then becomes an `undecided` question.
3. **Ask the undecided questions** together (see `decisions.md`): `oneWay` ones blocking, the rest provisional with the planner's recommendation.
4. **Approval.** The user approves the plan when `settings.planApproval` is `always`, or is `auto` and the issue is a feature, size L, or has a one-way door. Then write the plan to a temp file outside the repository and ask:

   ```bash
   factory ask --kind plan --question "Approve the plan for <title>?" --recommend Approve --option Approve --option Change --body-file /tmp/<plan>
   ```

   End your turn. "Change" with feedback starts one more plan run with the feedback in its context, then the review and the approval again. After two rounds of changes, ask a `blocked` decision about how to go on. With `never`, or `auto` for a small bug, go on without asking and `factory report` that the plan was not shown.
5. **Carry the criteria.** Implement gets the approved plan in its context, and its `claims` answer the criteria one by one. The land stage's done check reads the same criteria. The `later` slices become issues when the issue closes.

Nothing from the plan is written into the repository.
