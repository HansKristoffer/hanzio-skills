# Asking the user

Every question goes through `factory ask`. The page shows it under Needs you, and the answer comes back to this thread as a message that starts with `Factory decisions answered on the page:`, or the user types it here (record that with `factory answer <id> -` and their words on stdin).

## Blocking or provisional

Most questions are **provisional**: ask, then keep working as if the recommendation were the answer. One unanswered question once stalled a whole build for 22 hours; a provisional one costs at most some rework.

```bash
factory ask --kind question --provisional --question "<one question>" --recommend "<what you will do>" [--option <label>]...
```

A **blocking** question waits. End your turn after asking it, and ask it when nothing else can go on:

| Kind | When |
| --- | --- |
| `plan` | The user approves a plan (see `plan-flow.md`). Options Approve and Change; the plan goes in `--body-file`. |
| `merge` | `factory gate` is blocked by `risk`, or by the `ask` merge setting (see `review-loop.md` step 6). Give `--head <sha>`; the options are always Merge and Do not merge, and only Merge on that head clears the gate. |
| `blocked` | Something only the user can give: access, a secret, a broken `factory.config.yaml`, a model this machine does not offer, a step `land-pr` would stop for. With `--round`, whether to go on past the review round budget; its options are Go on and Stop. |
| `question` without `--provisional` | A one-way door: a schema, a public API, a data migration, a deletion, money, permissions. |

The service refuses `--provisional` on `plan`, `merge` and `blocked`.

## How to word one

- One question per decision. Questions you can ask now go out together, one `factory ask` each, before you end the turn; the page sends their answers back in one message once no blocking one is left.
- `--recommend` is worded so that accepting it is a whole answer: "Keep `total` as an alias of `amount` for one release", not "Yes". The page's first button is "Accept: <recommendation>".
- Put the facts in the question: what you found, the options and what each costs. Never ask what the code, the docs or a command can tell you; look it up.

## When the answer comes

1. `factory status` shows every decision with its answer.
2. For a provisional answer that differs from the recommendation, rework what you built on the guess before anything is merged. The gate stays blocked by `decisions` while any decision has no answer.
3. A message that lists only ids you already acted on changes nothing.
