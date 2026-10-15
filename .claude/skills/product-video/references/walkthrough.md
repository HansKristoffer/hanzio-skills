# Live walkthroughs

A live part records the real product in Chrome while the narration plays, or, with silent scenes (`{ "id", "dur" }`), as a clip for a composition (`motion.md`, "Real product footage"). Use it for demos and walkthroughs; put the recording inside a composition (`<video data-start>` in a browser frame) when a launch film needs the real product moving.

## Recording

A live part is a walkthrough script that drives the real product through each narrated scene, in Google Chrome through Playwright, so it needs nothing beyond `bun` and Chrome. Save it as `<build>/<part>.walk.mjs` so every take reruns the same steps, and run it with `bun $SKILL/video.ts walk <build>/<part>.walk.mjs`. A take is assembled into `<part>/video.mp4` on its own; `live <part>.json` reassembles it later.

```js
// <build>/demo.walk.mjs: the default export gets the page, at 1920x1080, and `record`.
export default async ({ page, record }) => {
  await page.goto("http://localhost:5173/cases")          // reach the start state before recording
  await page.waitForSelector("[data-testid=case-list]")

  const rec = await record()                                // records the part named after this file
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
}
```

| `walk` flag | Does |
| --- | --- |
| `--rehearse` | Runs the steps without recording or waiting for the narration, to check selectors and flow in seconds. |
| `--scale 3` | Records at 3x (5760x3240) instead of 2x, for a clip a composition will zoom into past about 2x. |
| `--headless` | No window. The default shows the window where there is a display (some sign-in and bot checks require one); on a server without one it is always headless. |

**Signing in.** Chrome runs with the skill's own profile (`~/.cache/product-video/chrome`, separate from the user's everyday Chrome; `VIDEO_PROFILE` points elsewhere, for example a second account). Its logins persist across takes and repositories. When a product needs a sign-in, such as a Shopify admin, run `bun $SKILL/video.ts browse <url>` in the background and ask the user to sign in in the window it opens and then close it; never type their password. The profile can be open in only one window at a time, so wait for that window to close before a `walk`. `browse` also saves the sign-ins to `~/.cache/product-video/chrome-state.json`. On a server, which has no window to sign in with, ask the user to run `browse` on their own computer and copy that file to the same path on the server; every `walk` there loads it.

**Exploring.** A script with any other name runs in the same browser without recording, for example `explore.mjs` printing `await page.locator("body").ariaSnapshot()` and saving `page.screenshot({ path, scale: "device" })` at each step.

| Helper | Shows the viewer |
| --- | --- |
| `rec.scene(id, async (at) => {})` | One narrated scene, held until its narration ends. `at(0.4)` waits until 40 % of it. |
| `rec.click(selector)` | The pointer gliding to the element, then the click. An element out of view is scrolled in smoothly first. |
| `rec.type(selector, text)` | A click into the field and typing at reading pace. |
| `rec.highlight(selector, { ms })` | A ring around the element with the page dimmed around it. |
| `rec.caption(text)` | A caption at the bottom until the next one; `rec.caption()` clears it. It survives navigation. |
| `rec.scrollTo(selector)` | A smooth scroll that centers the element, captured at 60 fps. |
| `rec.pointAt(selector)` | The pointer moving there and hovering, without clicking. It rests just past the end of a line of text so it never covers the words; `{ beside: false }` rests in the middle. |
| `rec.mark(name, selector?)` | Nothing: notes the moment (and the element's box) so `live` prints its time in the video and a ready `crop=`, and a composition can aim its camera at it. Mark every result a composition will time against: a reply arriving, a card landing, a state changing. Clicks are marked on their own. Mark after waiting for something specific (`waitForFunction` on the final text or element), not on a pause in streaming, which also happens mid-reply. A mark with a selector waits up to 5 s for its element to hold still and fade in, and is timed when it has, so a toast or dialog is marked when it shows. A mark's box is where the element was at that moment; when the page scrolls on afterwards, mark the region again once it settles. |
| `rec.cut(async () => {})` | Nothing: the time inside is cut from the video, and the scene's narration clock pauses. Use it for a long job, an upload or an assistant thinking. |

Selectors are CSS (`[data-testid=x]`, `#id`, `[aria-label="Send"]`) or `text=Exact visible text`, which takes the first visible match in page order (`text*=part of it` matches a fragment, for long messages), so scope it with CSS when the text repeats, as in a menu or table of contents. `text=` is how a script that says "use the app's own labels" maps onto clicks.

The helpers search the page first and then its embedded iframes, for example an app inside the Shopify admin or another host. They scroll the element on screen, and the pointer, ring and click land on it. Only the helpers move the drawn pointer, so do every visible action through them. Call `page` methods directly for anything else:

- waits and navigation (`page.waitForSelector`, `page.goto`);
- a file picker: `const chooser = page.waitForEvent("filechooser"); await rec.click("text=Add file"); await (await chooser).setFiles("/abs/price-list.xlsx")`, or `page.setInputFiles(selector, path)` for a drop zone;
- pasting copied cells: `rec.click` the first cell, then `page.keyboard.paste(text)`;
- keys: `page.keyboard.press("Enter")`.

Time between `rec.scene` calls is never in the video, so a slow setup step or a job finishing between two scenes can happen there. Inside a scene, wrap a wait in `rec.cut`. The video then cuts straight from the progress bar to the result, while the narration continues across the cut.

- Call `rec.scene` once per narrated scene, in script order. If a scene's actions take longer than its narration, the scene and its audio stretch to fit.
- The recording sets the page to 1920x1080 and draws the pointer, ring and caption. Setup done before `record`, such as signing in, is not in the video.
- Use local development data or seeded demo accounts. Never record production customer data, secrets or another person's account unless the user explicitly asks for it.
- The recorder takes 2x screenshots (3840x2160) while the page acts on its own, at 10-30 frames per second with a GPU (1-3 on a server without one, where the page's own animations look choppy), and keeps a frame only when the page changed. Scrolls and pointer glides are captured one screenshot per frame at 60 fps; the extra time that takes is cut from the video and the narration clock waits for it. Fast animation of the page's own still looks choppy, so show it in a composition (`render`) instead.
- Scroll with `rec.scrollTo` or let `rec.click` bring the element in; a scroll done with `page` methods jumps or plays at the capture rate.
- If a take fails, fix the walkthrough and run it again from the start. `record` clears the previous frames.
- Only a browser tab is recorded. To show a desktop app such as Excel, take a screenshot of it and show it in a composition, or leave it out and say so.
- `record({ cursor: false })` leaves the drawn pointer out, for a clip where nothing is clicked.

## Product demo walkthrough

Use this when the user wants a demo of the product, or of a feature, rather than an explanation of a change.

1. **Find the story.** Read the product's docs, README and feature pages to learn who it is for and what they gain. Pick one to three journeys that show that value end to end, such as a support agent answering a customer or a manager reading a report. A demo shows outcomes, not every setting.
2. **Explore before writing.** Start the app (the repository's dev instructions say how) and sign in with a seeded or demo account. Walk each journey with an exploring script (above), printing an aria snapshot and saving a screenshot at each step. Note the selectors that work, the realistic data to show and the screen each step ends on. Fix or seed missing demo data first, because an empty table makes a poor demo.
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
- **Sign-in:** a product inside another platform, such as a Shopify admin, needs the user's signed-in session in the video profile. If the walkthrough reaches a sign-in page, stop and ask the user to sign in through `browse` (above); never type their password.
- **Actions consume their state.** Approving, sending or deleting changes the product, so the next take starts somewhere else. Rehearse with `{ rehearse: true }` first, record the action once, and know how to restore the start state (a seeder, a second demo record) before you start.
- **Look for strings that break the film:** seed or test labels, a language other than the film's, internal ids. Choose the crop around them, or fix the demo data; never cover them with a graphic.
- **An AI answer or live data differs on every take.** Read the take's final frames before using it (`live` and `crop` previews make that quick), keep the take you checked, and never let a caption claim what the answer does not say.
- **Unpredictable steps:** for an assistant that writes its own reply, or a step whose result varies, rehearse, wrap the wait in `rec.cut`, and check the take's contact sheet before moving on.

