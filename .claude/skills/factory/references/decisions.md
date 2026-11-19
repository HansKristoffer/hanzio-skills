# Asking the user

Every question goes through `factory ask`. The page shows it under Needs you, and the answer comes back to this thread as a message that starts with `Factory decisions answered on the page:` (a line that ends `[through the MCP]` was answered by the user's agent through the factory's MCP server, and counts as the user's answer), or the user types it here (record that with `factory answer <id> -` and their words on stdin).

## Blocking or provisional

Most questions are **provisional**: ask, then keep working as if the recommendation were the answer. One unanswered question once stalled a whole build for 22 hours; a provisional one costs at most some rework.

Provisional is for **how** to build it. A question about **whether** to build it, where one answer is to do nothing, is blocking: going on would open a PR for work the user may not want, and they would read the question as an approval the factory did not wait for.

```bash
factory ask --kind question --provisional --question "<one question>" --recommend "<what you will do>" [--option <label>]...
```

A **blocking** question waits. End your turn after asking it, and ask it when nothing else can go on:

| Kind | When |
| --- | --- |
| `plan` | The user approves a plan (see `plan-flow.md`). Options Approve and Change; the plan goes in `--body-file`. |
| `merge` | `factory gate` is blocked by `risk`, or by the `ask` merge setting (see `review-loop.md` step 6). Give `--head <sha>`; the options are always Merge and Do not merge, and only Merge on that head clears the gate. |
| `blocked` | Something only the user can give: access, a secret, a broken `factory.config.yaml`, a model this machine does not offer, a provider that refused the run of a stage with no `fallback` (a usage limit with a reset time waits for it instead: `factory wait --on limit`), a step `land-pr` would stop for. With `--round`, whether to go on past the review round budget; its options are Go on and Stop. |
| `question` without `--provisional` | A whether question (above), or a one-way door: a schema, a public API, a data migration, a deletion, money, permissions. |

The service refuses `--provisional` on `plan`, `merge` and `blocked`.

## How to word one

- One question per decision. Questions you can ask now go out together, one `factory ask` each, before you end the turn; the page submits them together and sends their answers back in one message once no blocking one is left. When a revision replaces an earlier open question, pass `--replaces <old-id>` so the stale question leaves `Needs you`.
- `--recommend` and `--option` are short, scannable choice labels (roughly 4 to 14 words): "Keep `total` as an alias for one release", not "Yes" and not a 40-word paragraph. Put the tradeoffs and rationale in `--question` after the question mark, not stuffed into the option text. `--option` lists the alternative answers only, never the recommendation in other words: the service tells another answer from the recommendation by its text, and another answer sends a plan back to be written again.
- The question is the first sentence, ending in its question mark: the page shows it as the headline, and it must be answerable alone. After it, at most two sentences on what the answer hangs on: what you found, and what each option costs. The page shows what was asked, what was built, the checks and the reviews beside the question, so repeat none of them. Never ask what the code, the docs or a command can tell you; look it up.
- After a provisional ask, your message to the user says what is being built meanwhile, and that the answer holds only the merge.
- The service writes every question with its answer, or its recommendation while unanswered, into the plan and implement briefs. Build on a recommendation as part of the change itself, in the commits the change needs anyway.

## When the answer comes

1. `factory status` shows every decision with its answer.
2. For a provisional answer that differs from the recommendation, rework what you built on the guess before anything is merged. The gate stays blocked by `decisions` while any decision has no answer. The answer Merge to a `merge` decision also answers every provisional question asked before it with its recommendation. An answer starting with `Do not merge:` carries the user's requested changes before merging: act on them, push, re-check, and ask Merge again on the new head.
3. A message that lists only ids you already acted on changes nothing.
