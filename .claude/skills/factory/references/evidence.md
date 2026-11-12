# Captures for the reviewer

A reviewer decides on a merge from the issue's page and the PR, often without reading the diff. A **capture** is a screenshot or a short video of the change in the running app. It shows on the page, in the PR's body and, at the end, on the source issue. `factory` below means the CLI the implement brief names.

## What to capture

Decide by what a person would look at to believe the change, and say what you chose in your result's `media`.

| The change | Capture |
| --- | --- |
| A bug fix | Nothing: the test that failed before the fix is the proof. Only when the bug was how a screen looked, one before and after pair of that spot. |
| A change to a screen that exists | A before and after pair of each screen it changes. |
| A new screen, or a new part of one | The filled state, and each state the change adds that a user can reach (empty, error, a dialog). |
| A flow over several steps, or something that moves (a drag, a live update, an animation) | The stills above for its start and end, and one video of the whole flow, 10 to 40 seconds. |
| An API, a CLI command, a job, a migration, a refactor, a dependency | Nothing: the command and its output go in a claim. |

One capture per thing a reviewer must see, at most eight. A screen the change does not touch is not a capture.

## Before you change a screen

A before picture needs the code as it was. Take it first, in this checkout, before your first edit to that screen. When you are past that point, take it from a second checkout of the base (`git worktree add <temp folder> origin/<default>`, start the app there, remove the worktree afterwards), never from memory or from production.

## How to capture

1. **Start the app** as the repository's `AGENTS.md` says. With buncargo: `bunx buncargo dev --detach`, then `bunx buncargo url` for the address. Sign in with the seeded or demo account the project's note or seed files name.
2. **Stills.** Drive a browser with the repository's own tooling (its Playwright or end-to-end setup), or with an exploring script of the `product-video` skill, and save a PNG of the viewport at 1280 by 800 or wider. Frame what changed: scroll it into view, and open the dialog or the menu the change lives in. Use the same viewport, account and data for a before and its after, so only the change differs.
3. **A video.** Call the Skill tool with `product-video` and follow its "A silent clip for a reviewer". Its captions say what each step shows. Skip everything else that skill offers: no brand work, music, narration or critic.
4. **Add each one**, with a title that names the screen or the flow in the user's words:

   ```bash
   factory evidence add /tmp/orders-before.png --title "Orders page" --label before
   factory evidence add /tmp/orders-after.png --title "Orders page" --label after - <<'EOF'
   Three orders selected: the action bar appears above the table.
   EOF
   factory evidence add /tmp/flow.mp4 --title "Marking three orders as paid"
   ```

   Two captures under one title, labelled `before` and `after`, show side by side. The same title and label again replaces the capture, which is how a retake goes in. The note is one sentence on what to notice. A video is made smaller for you, with a still frame and a short GIF for GitHub.
5. **Look at each one** before you go on (read the PNG; for a video, a frame from its middle). Retake a capture that shows a spinner, a stray dialog, a development error overlay, or the wrong screen.

## What a capture may show

Seeded or demo data only. A capture is pushed to GitHub and stays there: retake one that shows a secret, a token, a real customer's name or data, or another person's account. A capture shows the app as it ran: never edit one, and never capture a mock in place of the product.

## When the change moves on

A capture records the commit it was taken at. After a later commit that changes what a capture shows (a review fix to the same screen), take it again under the same title and label. Captures the commit does not affect stay.

**Done when** `factory evidence list` shows a capture for each row of the table that fits the change, each one looked at, and your result's `media` says what you captured and why, or why nothing.
