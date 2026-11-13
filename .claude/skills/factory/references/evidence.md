# Proof for the reviewer

A reviewer decides on a merge from the issue's page and the PR, often without reading the diff. **Proof** is what they read in its place, and it comes in four kinds:

- a **test** that fails on the base and passes on the head;
- a **capture**: a screenshot or a short video of the change in the running app;
- a **measurement**: the same run on the base and on the head, with its numbers;
- a **transcript**: a real command and what it printed, on the base and on the head.

Every piece shows both sides, each at a commit it names, from a run you watched. `factory` below means the CLI the implement brief names.

## What proves the change

Find the row for the change, and say in your result's `media` what you captured and why, or why nothing.

| The change | Proof |
| --- | --- |
| A bug in logic, data, state or a protocol | The test. |
| A bug a user meets in the running app | The test, and a before and after pair of the place it shows, reached by the same steps on both sides. A video when the bug is in how something moves. |
| A bug only in how a screen looks (spacing, colour, alignment) | The before and after pair, in place of a test. |
| A bug with no screen: a server, a job, a CLI | The test, and a transcript of the real command. |
| A change to a screen that exists | A before and after pair of each screen it changes. |
| A new screen, or a new part of one | The filled state, and each state the change adds that a user can reach (empty, error, a dialog, a refusal), once per client and theme where it looks different. |
| A flow over several steps, or something that moves (a drag, a live update, an animation) | The stills for its start and end, and one video of the whole flow, 10 to 40 seconds. |
| Something made faster, smaller or cheaper | A measurement, and a test that pins the cause. |
| A flaky test | How often it failed, with the CI runs; then the failure forced on the base and the same forced run on the head, each as n of n. |
| A test or a guard with no product change | The product broken on purpose, once per thing it guards, and the test failing on each break. |
| An API, a migration, a refactor, a dependency | A transcript when one command shows the new behavior; otherwise the checks in your claims. |

One capture per thing a reviewer must see, at most eight; a screen the change does not touch is not one.

## The base side comes first

A before picture, a baseline number and a base transcript all need the code as it was. Research's `reproduction` already holds its command and what that printed on the base. Take the rest in this checkout before your first edit. Past that point, take it from a second checkout of the commit this branch started from, so the two sides differ by this change alone (`git worktree add --detach <temp folder> "$(git merge-base HEAD origin/<default>)"`, start the app there, `git worktree remove <temp folder>` afterwards) and pass `--commit <that commit>` to `factory evidence add`, never from memory or from production.

## Captures

1. **Start the app** as the repository's `AGENTS.md` says. With buncargo: `bunx buncargo dev --detach`, then `bunx buncargo url` for the address. Sign in with the seeded or demo account the project's note or seed files name.
2. **Stills.** Drive a browser with the repository's own tooling (its Playwright or end-to-end setup), or with an exploring script of the `product-video` skill, and save a PNG of the viewport at 1280 by 800 or wider. Frame what changed: scroll it into view, and open the dialog or the menu the change lives in. Use the same viewport, theme, account and data for a before and its after, so only the change differs.
3. **A video.** Call the Skill tool with `product-video` and follow its "A silent clip for a reviewer". Its captions say what each step shows. Skip everything else that skill offers: no brand work, music, narration or critic.
4. **Add each one**, with a title that names the screen or the flow in the user's words:

   ```bash
   factory evidence add /tmp/orders-before.png --title "Orders page" --label before
   factory evidence add /tmp/orders-after.png --title "Orders page" --label after - <<'EOF'
   Three orders selected: the action bar appears above the table.
   EOF
   factory evidence add /tmp/flow.mp4 --title "Marking three orders as paid"
   ```

   Two captures under one title, labelled `before` and `after`, show side by side, each with its commit. The same title and label again replaces the capture, which is how a retake goes in. The note is one sentence on what to notice: for a pair, the result that differs. A video is made smaller for you, with a still frame and a short GIF for GitHub.
5. **Look at each one** before you go on (read the PNG; for a video, a frame from its middle). Retake a capture that shows a spinner, a stray dialog, a development error overlay, or the wrong screen.

## Measurements

The `optimize` skill, which the implement brief calls for a metric, says how to measure. The proof holds:

1. **Both sides in one session**, on the same machine, data and build mode, with n runs each and the statistic named (the median of 5, cold or warm).
2. **The same result on both sides.** Compare what the two sides return (the rows, the bytes, the output) and say over how many cases. A faster wrong answer is a bug.
3. **A test that pins the cause.** It fails on the base and asserts what made it slow: a count of calls or rows, a query plan, a payload size. A test that asserts elapsed time flakes on a busy runner.
4. **Your result's `measured`:** `how` (what ran, on what data and machine, n and the statistic), `base` and `head` (the two commits), `rows` (one per thing measured, the unit in each value, such as `{ "what": "Export of 10,000 orders", "before": "31 s", "after": "2.4 s" }`), and `same` (how step 2 came out). The page and the PR show it as a table.
5. **The number where it is read.** The PR's title carries the headline number in the user's words ("exports finish about 10x faster"). When another change shares a number, say so in `how`. What is still slow goes in `leftOut`.

## Transcripts

Run the real thing (the CLI command, the request with `curl`, the job once) against a local instance with seeded data, on the base and on the head. Keep the command and the lines that differ, with `<REDACTED>` for any secret, and put both sides in a claim's evidence and in the PR body's Evidence, each as a code block under its commit.

## What proof may show

Seeded or demo data only. Proof is pushed to GitHub and stays there: retake a capture, and cut a transcript, that shows a secret, a token, a real customer's name or data, or another person's account. Proof shows the product as it ran: never edit a capture or a number, and never capture a mock in place of the product. Each thing the proof leaves uncovered (the other entry point, the client you could not start, the path you did not force) is one line in `notChecked`.

## When the change moves on

A capture and a measurement each record the commit they were taken at. After a later commit that changes what one shows (a review fix to the same screen or the same path), take it again: a capture under the same title and label, a measurement as a new `measured`. Proof the commit does not affect stays.

**Done when** the change has the proof its row names, `factory evidence list` shows each capture and you looked at each one, and your result says in `media`, `measured` and `notChecked` what was shown and what was left uncovered.
