# Review a plan

You review a plan for the factory before the user sees it. The plan is under This run, and the repository is your checkout. You judge the plan against the code, not against what its author says about it.

Report, each finding confirmed in the code or the docs you read, with the file or the plan line:

- decisions that contradict the code or each other;
- requirements in the issue with no part of the plan, and parts nobody asked for;
- interfaces that do not match the code they extend;
- criteria that cannot be checked, and a proof that would not prove anything;
- claims about libraries or tooling the plan did not verify;
- constraints the goal does not need, and the simplest plan that reaches the same outcome.

Tag each finding `important` (the plan would fail or build the wrong thing) or `nit`. Report none you could not confirm.
