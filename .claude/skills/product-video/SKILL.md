---
name: product-video
description: Make narrated product videos in any repository, voiced by ElevenLabs. Covers explainers of a change, feature or release with animated HTML scenes, and product demos recorded as live walkthroughs of the real product in ego-browser, or both. Use when asked for a product video, product demo, explainer, walkthrough, demo video or screen recording with voice-over.
---

# Product video

A video is one or more **parts** joined in order. Each part is a script of scenes, narrated first, then recorded so every scene lasts exactly as long as its narration:

- **Slides**: an HTML page with one animated scene per narrated scene, recorded in headless Chrome. Use it to explain an idea, a flow or a before and after.
- **Live**: a scripted ego-browser session on the real product, screencast at 1920x1080 while the narration plays. Use it to show the feature working.

`SKILL` below means the absolute path of the folder holding this file, for example `~/.claude/skills/product-video`. Every command is `bun $SKILL/video.ts <command>`.

## Where things go

- Build files go in `<repo>/.video-build/<slug>/`. `init` adds that folder to `.git/info/exclude`, so it never shows in `git status` and is never committed. Outside a git repository, the current directory is the root.
- The finished video goes to `<repo>/<slug>.mp4`. It is also excluded from git; commit it only when asked.
- Requires `bun` and `ffmpeg`. Slides use the installed Google Chrome, or a Playwright Chromium; `video.ts` installs `playwright-core` into `$SKILL` on first use. Live parts need the `ego-browser` CLI (ego lite) and its skill.

## Voice

Narration uses ElevenLabs (`eleven_v4_turbo`, voice Sarah). The key is `ELEVENLABS_API_KEY` from the environment, otherwise from `$SKILL/.env` (one line, `ELEVENLABS_API_KEY=...`, mode 600, gitignored). Never print the key, copy it into a repository or show it in a reply. Without a key, narration falls back to macOS `say`, and the command says so.

Optional environment: `VOICE=<ElevenLabs voice id>`, `MODEL=<model id>`, `LANGUAGE=da` (ISO 639-1, for non-English narration), `SAY_VOICE=<say voice>`.

## Workflow

1. **Understand what to show.** For a change, read the diff, the PR, the feature docs and the UI it touches. For a product demo, follow **Product demo walkthrough** below. Decide the story in 4-12 scenes, and which parts are slides and which are live.
2. **Start the build.** `bun $SKILL/video.ts init <slug>` prints the build folder and output path. It creates `slides.json` and `slides.html` to edit. Add another part by adding `<name>.json` (and `<name>.html` for slides).
3. **Write the script.** A part's JSON is `[{ "id": "intro", "text": "..." }]`. Write the text to be heard: plain spoken sentences, two to five per scene, one idea per scene, the product's own terms, no symbols or abbreviations the voice will misread. Write it in the audience's language.
4. **Narrate.** `bun $SKILL/video.ts narrate <build>/<part>.json` writes `<part>/audio/` and `<part>/timing.json` with each scene's length. Re-run it after any text change.
5. **Make each part** (below).
6. **Join.** `bun $SKILL/video.ts concat <repo>/<slug>.mp4 <build>/<part>/video.mp4 ...`. Any clip can be a part, such as a logo intro the project already has. Parts are scaled to 1920x1080, and silent clips get a silent track.
7. **Check it.** `bun $SKILL/video.ts check <repo>/<slug>.mp4` writes a 12-frame contact sheet; look at it. Then tell the user the path and length, and say if the narration fell back to `say`.

## Slides part

Edit `<part>.html`, which starts from `template.html`:

- One `<section class="scene" data-id="...">` per scene, in the same order as the JSON. Recording fails on a mismatch.
- `data-f="0.4"` reveals an element 40 % into the scene's narration, so visuals land when the voice mentions them. Use `.r` to rise in, `.pop` to pop in, and `.glow` to pulse.
- Restyle the `:root` variables to the project's brand: its colors, font and logo. Prefer the real product over invented UI, for example screenshots taken with ego-browser and placed in the build folder as `<img class="shot" src="shots/x.png">`. A mock card or chat bubble is fine for an idea the product cannot show.
- Keep text large and short. The narration carries the detail, and the screen carries the structure.

`bun $SKILL/video.ts preview <build>/<part>.json` screenshots every scene in its finished state into `<part>/preview.png`. Look at it and fix overflow and layout before recording, because recording runs in real time. Then run `bun $SKILL/video.ts slides <build>/<part>.json` to write `<part>/video.mp4`.

## Live part

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
| `rec.pointAt(selector)` | The pointer moving there without clicking. |

Selectors are CSS (`[data-testid=x]`, `#id`, `[aria-label="Send"]`) or `text=Exact visible text`, which takes the first visible match in page order, so scope it with CSS when the text repeats, as in a menu or table of contents. The helpers act through the pointer, so a viewer sees every step. Call `page` methods directly for anything else, such as waits and navigation.

- Call `rec.scene` once per narrated scene, in script order. If a scene's actions take longer than its narration, the scene and its audio stretch to fit.
- The recording sets the page to 1920x1080 and draws the pointer, ring and caption. Setup done before `record`, such as signing in, is not in the video.
- Use local development data or seeded demo accounts. Never record production customer data, secrets or another person's account unless the user explicitly asks for it.
- Chrome sends a frame only when the page changes, at about 13 frames per second during motion. That suits UI walkthroughs; fast animation looks choppy, so show it in a slides part.
- If a take fails, fix the walkthrough and run it again from the start. `record` clears the previous frames.
- Shell environment variables do not reach the walkthrough script, which runs inside the ego-browser service. Switch between rehearsal and a take by editing the `record` options, not with an environment variable.

## Product demo walkthrough

Use this when the user wants a demo of the product, or of a feature, rather than an explanation of a change.

1. **Find the story.** Read the product's docs, README and feature pages to learn who it is for and what they gain. Pick one to three journeys that show that value end to end, such as a support agent answering a customer or a manager reading a report. A demo shows outcomes, not every setting.
2. **Explore before writing.** Start the app (the repository's dev instructions say how) and sign in with a seeded or demo account. Walk each journey in ego-browser, taking a snapshot at each step. Note the selectors that work, the realistic data to show and the screen each step ends on. Fix or seed missing demo data first, because an empty table makes a poor demo.
3. **Plan the scenes.** Use one scene per step a viewer should notice: what they see, what you do, what it means for them. Open with a short slides part that names the problem and the product. Close with a short slides part that repeats the outcome and gives a call to action.
4. **Write the narration from the screen.** Describe what is happening and why it helps, in benefit terms, using the product's own names for things. Keep each scene to two to four sentences so the screen keeps moving.
5. **Narrate, then rehearse.** Run `narrate`, then run the walkthrough once with `{ rehearse: true }`. That checks every selector and step without recording or waiting. Fix anything that fails.
6. **Record and check.** Reset any data the rehearsal changed, record the take, then run `live`, `concat` and `check`. Look at the contact sheet. Retake a scene with a stray dialog, a loading spinner or a wrong screen.

Walkthroughs often change data, for example by sending a message or saving a record. Make the script work on a fresh start state, or reset the demo data before each take. Never run a walkthrough that changes data against production.

## Reuse

Each part folder keeps its audio, so after a script change only that part needs `narrate` and recording again, followed by `concat`. Delete `<repo>/.video-build/<slug>` when the video is final, unless the user wants to iterate later.
