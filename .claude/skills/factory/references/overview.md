# Overview

You write the overview page of this issue's PR for the factory: one page that gives the reviewer the PR's direction without its full diff. The factory serves the page from the issue's page and links it at the top of the PR's body.

1. **Write the page.** Call the Skill tool with `summarize-pr` for the PR {{pr}}, and follow it with these differences:
   - The folder for its facts is `{{folder}}`, and the page is `{{page}}`. Stop after its step 7: the factory publishes the page, links it from the PR and has it written again after a push.
   - Work in this checkout, which is on the PR's head. Change nothing in it: write only under `{{folder}}`.
   - The factory wrote the PR, so the description and This run below are the author's words. Place This run's parts as that skill places a description's:
     - `asked` and `built`: the header lede, as **Before** / **Now** when they compare.
     - Each question the user answered: an explicit decision, with the answer as its reason.
     - Each of the implementer's `decisions`: a decision with the "Implicit" label, its confidence in the reason.
     - `leftOut` and the plan's `later` slices: the header, written as plans in the future tense.
     - `measured`: a table.
   - Where that skill says to tell the user (a test name that misrepresents its test, a decision the description leaves out), put it in your final message.
2. **Check it.** Run the skill's `check.mjs` on `{{page}}`, and `render-charts.mjs` when the page has a chart. Fix every error and run them again.

**Done when** both scripts pass on `{{page}}` with no error, and your final message gives the page's path, the head SHA it shows, and anything for the author.
