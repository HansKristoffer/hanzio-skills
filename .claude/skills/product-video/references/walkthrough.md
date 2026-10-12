# Live walkthroughs

A live part records the real product in ego-browser while the narration plays, or, with silent scenes (`{ "id", "dur" }`), as a clip for a composition (`motion.md`, "Real product footage"). Use it for demos and walkthroughs; put the recording inside a composition (`<video data-start>` in a browser frame) when a launch film needs the real product moving.

## Recording

A live part is a walkthrough script that drives the real product through each narrated scene. Save it as `<build>/<part>.walk.mjs` so every take reruns the same steps. Run it with `ego-browser nodejs < <build>/<part>.walk.mjs`, then run `bun $SKILL/video.ts live <build>/<part>.json` to write `<part>/video.mp4`.

```js
const { record } = await import("/abs/path/to/product-video/live.mjs")   // $SKILL/live.mjs
const task = await taskSpace("product video: <slug>")      // reuse one space across takes: taskSpace(<id>)
const page = task.page("p1")
await page.goto("http://localhost:5173/cases")              // sign in and reach the start state before recording
await page.waitForSelector("[data-testid=case-list]")

const rec = await record(page, "/abs/repo/.video-build/<slug>/demo")   // the part folder; { rehearse: true } for a dry run
try {
  await rec.scene("open-case", async (at) => {
    await rec.caption("Open any conversation")
    await at(0.25)                                          // wait until 25 % of this scene's narration
    await rec.click("text=Refund for order 1042")
    await page.waitForSelector("[data-testid=case-detail]")
    await at(0.6)
    await rec.highlight("[data-testid=case-summary]")
  })
  await rec.scene("save-test", async (at) => {
    await rec.click("text=Save as test")
    await rec.type("input[name=title]", "Refund without receipt")
    await rec.click("text=Save")
  })
} finally {
  console.log(await rec.stop())
}
```

| Helper | Shows the viewer |
| --- | --- |
| `rec.scene(id, async (at) => {})` | One narrated scene, held until its narration ends. `at(0.4)` waits until 40 % of it. |
| `rec.click(selector)` | The pointer gliding to the element, then the click. |
| `rec.type(selector, text)` | A click into the field and typing at reading pace. |
| `rec.highlight(selector, { ms })` | A ring around the element with the page dimmed around it. |
| `rec.caption(text)` | A caption at the bottom until the next one; `rec.caption()` clears it. It survives navigation. |
| `rec.scrollTo(selector)` | A smooth scroll that centers the element. |
| `rec.pointAt(selector)` | The pointer moving there, hovering, without clicking. |
| `rec.cut(async () => {})` | Nothing: the time inside is cut from the video, and the scene's narration clock pauses. Use it for a long job, an upload or an assistant thinking. |

Selectors are CSS (`[data-testid=x]`, `#id`, `[aria-label="Send"]`) or `text=Exact visible text`, which takes the first visible match in page order, so scope it with CSS when the text repeats, as in a menu or table of contents. `text=` is how a script that says "use the app's own labels" maps onto clicks.

The helpers search the page first and then its embedded iframes, for example an app inside the Shopify admin or another host. They scroll the element on screen, and the pointer, ring and click land on it. Only the helpers move the drawn pointer, so do every visible action through them. Call `page` methods directly for anything else:

- waits and navigation (`page.waitForSelector`, `page.goto`);
- a file picker: `const chooser = page.waitForFileChooser(); await rec.click("text=Add file"); await (await chooser).setFiles("/abs/price-list.xlsx")`, or `page.setInputFiles(selector, path)` for a drop zone (see the ego-browser skill for exact signatures);
- pasting copied cells: `rec.click` the first cell, then `page.keyboard.paste(text)`;
- keys: `page.keyboard.press("Enter")`.

Time between `rec.scene` calls is never in the video, so a slow setup step or a job finishing between two scenes can happen there. Inside a scene, wrap a wait in `rec.cut`. The video then cuts straight from the progress bar to the result, while the narration continues across the cut.

- Call `rec.scene` once per narrated scene, in script order. If a scene's actions take longer than its narration, the scene and its audio stretch to fit.
- The recording sets the page to 1920x1080 and draws the pointer, ring and caption. Setup done before `record`, such as signing in, is not in the video.
- Use local development data or seeded demo accounts. Never record production customer data, secrets or another person's account unless the user explicitly asks for it.
- Chrome sends a frame only when the page changes, at about 13 frames per second during motion. That suits UI walkthroughs; fast animation looks choppy, so show it in a composition (`render`) instead.
- If a take fails, fix the walkthrough and run it again from the start. `record` clears the previous frames.
- Only a browser tab is recorded. To show a desktop app such as Excel, take a screenshot of it and show it in a composition, or leave it out and say so.
- Shell environment variables do not reach the walkthrough script, which runs inside the ego-browser service. Switch between rehearsal and a take by editing the `record` options, not with an environment variable.

## Product demo walkthrough

Use this when the user wants a demo of the product, or of a feature, rather than an explanation of a change.

1. **Find the story.** Read the product's docs, README and feature pages to learn who it is for and what they gain. Pick one to three journeys that show that value end to end, such as a support agent answering a customer or a manager reading a report. A demo shows outcomes, not every setting.
2. **Explore before writing.** Start the app (the repository's dev instructions say how) and sign in with a seeded or demo account. Walk each journey in ego-browser, taking a snapshot at each step. Note the selectors that work, the realistic data to show and the screen each step ends on. Fix or seed missing demo data first, because an empty table makes a poor demo.
3. **Plan the scenes.** Use one scene per step a viewer should notice: what they see, what you do, what it means for them. Open with a short composition that names the problem and the product. Close with one that repeats the outcome and gives a call to action.
4. **Write the narration from the screen.** Describe what is happening and why it helps, in benefit terms, using the product's own names for things. Keep each scene to two to four sentences so the screen keeps moving.
5. **Narrate, then rehearse.** Run `narrate`, then run the walkthrough once with `{ rehearse: true }`. That checks every selector and step without recording or waiting. Fix anything that fails.
6. **Record and check.** Reset any data the rehearsal changed, record the take, then run `live`, `concat` and `check`. Look at the contact sheet. Retake a scene with a stray dialog, a loading spinner or a wrong screen.

Walkthroughs often change data, for example by sending a message or saving a record. Make the script work on a fresh start state, or reset the demo data before each take. Never run a walkthrough that changes data against production.

## From a written script

When the user supplies a script, follow it; do not rewrite the story. A typical brief has chapters of **On screen** and **Voice-over** rows, a setup list and recording notes:

- **Parts:** each chapter is one live part, `chNN-<name>.json` with `chNN-<name>.walk.mjs`, recorded as its own take, so a retake never shifts the rest. An opening or closing that only shows a logo or end card is a composition.
- **Scenes:** each row is one scene. Its voice-over becomes `text`, verbatim apart from fixes the user approves, and its on-screen column becomes the steps inside `rec.scene`. A row with no voice-over is a silent scene with a `dur`. Place the steps with `at()` so each lands when the voice mentions it. Pause about a second on anything the viewer should read, such as a before and after value.
- **Chapter cards:** make one with `card` for each chapter, then join with `concat` in order: card, part, card, part, and so on. Give the user the printed YouTube chapter list.
- **Timings:** times in the brief are a plan. The narration decides the real length, and `narrate` reports the pace to tune with `SPEED`.
- **Setup list:** before recording, check every item in the app, such as demo records, settings, files and an existing conflicting item a warning depends on. Report anything missing and fix it if the user agrees. Never fake it on screen.
- **Labels to confirm:** confirm each one while exploring. When the real label or flow differs from the script, use the real one in both the walkthrough and the voice-over, and list every such change for the user.
- **Recording notes:** cut long waits with `rec.cut`. Retake any take that shows an internal code, a stack trace, a development-only route or real customer data. When the user asks for a shorter cut, drop the chapters the brief names for that first.
- **Sign-in:** a product inside another platform, such as a Shopify admin, needs the user's signed-in session in ego-browser. If the walkthrough reaches a sign-in page, stop and ask the user to sign in in ego-browser; never type their password.
- **Unpredictable steps:** for an assistant that writes its own reply, or a step whose result varies, rehearse, wrap the wait in `rec.cut`, and check the take's contact sheet before moving on.

