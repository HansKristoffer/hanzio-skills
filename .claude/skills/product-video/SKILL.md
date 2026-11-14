---
name: product-video
description: Make professional product videos in any repository, from code-built motion graphics rendered frame by frame at 60 fps, live Chrome recordings of the real product, ElevenLabs narration and music, a designed sound-effect kit, checked by measurement and an independent critic. Covers SaaS launch films in the style seen on X, feature explainers, product demos and chaptered walkthroughs. Use when asked for a product video, launch video, promo, explainer, demo, walkthrough or screen recording with voice-over.
---

# Product video

Every video is one or more **parts** joined in order:

- **Composition**: an HTML page animated with GSAP on one timeline and rendered frame by frame, so every frame is exact. It can be music-led (a launch film) or timed to narration (an explainer), and it can embed real screenshots and recorded clips.
- **Live**: a scripted Chrome session on the real product, recorded while the narration plays (`references/walkthrough.md`).

`SKILL` below means the absolute path of the folder holding this file, for example `~/.claude/skills/product-video`. Every command is `bun $SKILL/video.ts <command>`.

Read only the reference the current step needs:

| Step | Read |
| --- | --- |
| Brand, logo, colors, fonts, real product imagery, a product from the internet | `references/assets.md` |
| Storyboard and building a composition | `references/motion.md` |
| Music, sound effects, narration mix | `references/audio.md` |
| The quality bar, the critic loop, delivering | `references/review.md` |
| Recording the real product, demos, a chaptered written script, a silent clip as proof for a pull request | `references/walkthrough.md` |

## Choose the mix

Most videos combine graphics and real product footage; the balance depends on what is being made. Decide it in the brief, before the storyboard.

| Video | Spine | Real product | Graphics |
| --- | --- | --- | --- |
| Launch film (15-45 s, X, landing page) | One composition | Real UI captures and short live clips (2-4 s each) inside frames, zoomed onto the detail that matters | Hook, kinetic type, transitions, numbers, end card |
| Feature or release explainer (30-90 s, narrated) | Narrated composition | Before and after captures, a clip of the new flow | Diagrams, cause and effect, labels, end card |
| Product demo (1-3 min) | Live recording of the real flow | The whole journey, in real time | An opening composition (problem, promise), captions and highlights, an end card |
| Walkthrough, onboarding, help (chaptered) | Live parts, one per chapter | Every step | Chapter cards, captions, highlights |

Rules for the mix:

- **Footage proves, graphics explain.** Show the product doing the work with real footage; use graphics for what footage cannot show: the idea, the structure, the before and after, the number, the brand. Graphics never fake a product state.
- **Clip over screenshot when something happens over time** (an agent working, data updating, a flow completing); a screenshot when the point is a still detail the camera zooms into.
- **Every product shot is framed by graphics** (a window or device frame, a title, a callout) so it belongs to the film, and graphics hand over to footage with a matched move, not a cut to a raw screen recording.
- **Footage keeps its real speed or close to it** (`data-rate` up to about 2 to fit a beat); never speed up text a viewer must read.

How the pieces combine: record a silent clip as a live part, then play it inside a composition with `<video data-start data-from data-rate>` (`references/motion.md`, "Real product footage"), or join whole live parts and compositions with `concat` (demos and walkthroughs).

## What good looks like

The bar is a professionally edited launch film: the real product, the brand's own look, motion that never stops and never collides, sound that lands on the action, and every claim true. A clean render with no bugs is not enough; basic, empty or slow cuts fail. That is why every film goes through stills, measurement and an independent critic before it is delivered.

## See what you made

You cannot watch the film or hear it. After every change, run the cheapest command that shows its effect, and read what it prints and the image it writes before changing anything else. From fastest to slowest:

| To see | Run | You get |
| --- | --- | --- |
| The layout at chosen moments, and defects across the whole film, without rendering | `stills <part>.html` with `--at 4.6,7.1`, `--around 2.3` or `--every 0.5` | Contact sheets with each tile labelled by its time, the full-size frames, and the `lint` findings |
| A transition frame by frame | `stills <part>.html --around <time>` | 13 frames, 0.05 s apart, across that moment |
| The motion of one beat you changed | `render <part>.html --draft --from 9 --to 12.5`, then `stills <part>/video.mp4 --around <time>` | Only that stretch redrawn into the last draft |
| Whether the whole film moves, holds and sounds right | `render <part>.html --draft`, then `check <part>/video.mp4` | Frozen time, judder, loudness second by second, a contact sheet; `render` prints each effect's level against the music and writes `<part>/sound.png` |
| The sound alone, after changing a cue, a gain or the music | `render <part>.html --audio-only` | The effects table and the sound picture again, in seconds |

- **`lint` reads the layout through time, 20 times a second, without drawing a frame.** It reports empty frames, text crossing text, text cut off at the frame's edge, type under 28 px, stretches where nothing moves, two tweens fighting over one property, and filters that make every frame slow to draw, each with its time. Look at every finding with `stills --at <time>`, then fix it or decide it is intended. `data-lint="ui"` on a built product mock keeps its interface-sized text out of the type check.
- **A sheet shows at most 28 frames at 480 px each.** Read a full-size frame from `<part>/stills/` when a detail matters: small text, an edge, an alignment.
- **Redraw only what changed.** `--from` and `--to` reuse every other chunk of the last render with the same `--fps` and `--scale`. A change that moves later beats (a new duration, a shifted scene) needs a whole render. `check` marks a video as NOT FINAL while it mixes chunks from different versions of the composition.
- **The final render is whole and at full quality** (`render <part>.html`, 60 fps, drawn at twice the pixels), followed by `check`.

## Where things go

- Build files go in `<repo>/.video-build/<slug>/`. `init` adds that folder to `.git/info/exclude`, so it never shows in `git status`. Outside a git repository, the current directory is the root.
- The finished video goes to `<repo>/<slug>.mp4`, also excluded from git; commit it only when asked.
- Requires `bun`, `ffmpeg` and a browser: Google Chrome, or Playwright's Chromium, which `video.ts` downloads on first use when Chrome is missing. `video.ts` installs its own `playwright-core` and `gsap`, and drives the browser both to render compositions and to record, read and screenshot the real product.
- **On a new machine or a server, run `bun $SKILL/video.ts doctor` first**, and `doctor --fix` to install what is missing (ffmpeg, the browser's system libraries, fonts, espeak-ng; it uses apt and sudo unless root). It works headless: without a display, `walk` and `site` run without a window. A server without a GPU draws every frame in software: `render` and `stills` stay fast by drawing in several browsers at once, and a `walk` there records the page frame by frame, so the page's own animations (a dialog fading in, a toast, a video) are smooth at 60 fps, at about 12 s of recording per second of motion (`references/walkthrough.md`, "How a take is captured"). A product behind a login needs the sign-ins from a computer with a screen: run `browse` there, sign in, close the window, and copy `~/.cache/product-video/chrome-state.json` to the same path on the server; the next `walk` there signs in from it.

## ElevenLabs key

Narration and music use ElevenLabs, and so does a sound effect the kit lacks. The sound-effect kit itself needs no key. The key is `ELEVENLABS_API_KEY` from the environment, otherwise from `$SKILL/.env` (mode 600, gitignored).

When a command exits with `NO_ELEVENLABS_KEY`, or ElevenLabs rejects the key, stop and ask the user in the chat for their ElevenLabs API key. When they paste it, store it without echoing it, then rerun the command:

```bash
printf '%s' '<key>' | bun $SKILL/video.ts set-key
```

Never repeat the key in a reply, write it into a repository or print it to a log. Without ElevenLabs, narration can use macOS `say` or espeak-ng on Linux (`narrate <part>.json --say`), and music can be a licensed track the user supplies.

## Workflow

1. **Brief.** `bun $SKILL/video.ts init <slug>` creates the build folder with `brief.md`, `film.html` (the launch template) and `assets/` and `sfx/` folders; `init <slug> --narrated` starts from the narrated explainer with `film.json`. Fill in the brief: product, audience, the one message, the CTA, true claims with sources, length, format and sound. Ask the user only for what you cannot find yourself.
2. **Brand and assets.** Start with `site <url>` on the product's website or running app, then follow `references/assets.md`: the brand's colors, type and logo, the real product imagery, and the facts, each with its source in `assets/SOURCES.md`.
3. **Storyboard.** Before building, write a table in the brief: time, what the viewer sees, what the beat says, the transition out and what carries across it. Use 12-15 compositions per 30 s and name three signature moments. Follow `references/motion.md`.
4. **Sound first for a launch film.** Write the effect kit with `sfx --kit <build>/sfx` and generate the music to the storyboard's length (`references/audio.md`). For narrated films, write `film.json` (one `{ "id", "text" }` per scene, plain spoken sentences, the product's own words) and run `narrate`, which sets each scene's length.
5. **Build** the composition from the template, one beat at a time: restyle the brand tokens, replace the mock product with the real imagery, and choreograph the beat with the Film helpers. After each beat, run `stills` on it. The beat is done when its frames show what the storyboard says and `lint` reports nothing you have not looked at and accepted.
6. **Draft.** `render <part>.html --draft`, then `check`. Fix the holds, the judder and every effect the table calls buried or standing out, redrawing only the beats you touch (`--from`, `--to`). Done when `check` meets the quality bar in `references/review.md`.
7. **Render** whole at full quality, `check` again, then run the critic loop: a fresh agent reviews the render against the quality bar; fix the largest gaps and verify with a new critic (`references/review.md`).
8. **Join and deliver.** `concat` the parts into `<repo>/<slug>.mp4` when there is more than one, run `check` once more, and report the result honestly, including that nobody has listened to the sound.

## Commands

| Command | Does |
| --- | --- |
| `init <slug> [--narrated]` | Creates the build folder, git-excluded, from a template. |
| `narrate <part>.json [--say]` | Voices each scene into `<part>/timing.json`; reports words per minute. `--say` is a keyless draft voice: macOS `say`, or espeak-ng on Linux. `SPEED=0.7-1.2` slows or speeds it up. Also `VOICE`, `MODEL`, `LANGUAGE`. |
| `music <out.mp3> --seconds N --prompt "..."` | A music bed from ElevenLabs Music, trimmed to start on the beat; prints loudness second by second. |
| `sfx --kit <dir>` | The designed effect kit (`click`, `tick`, `pop`, `whoosh`, `swipe`, `hit`, `shimmer`), synthesized locally: no key, the same on every run. Prints each sound's measurements. |
| `sfx <out.wav> "<description>" [--seconds 0.6]` | One effect the kit lacks, from ElevenLabs, trimmed, cleaned and levelled like the kit. |
| `site <url> [--out dir]` | A website or running app read for a film: brand colours and type, logo, web fonts with `fonts.css`, and a 2x screenshot of every section, with a short summary. |
| `stills <part>.html\|<video>.mp4 [--every 0.5 \| --at 1,2.5 \| --around 2.3]` | Frames at chosen times as labelled contact sheets, drawn in parallel, from a composition (with `lint`) or from any rendered video. |
| `lint <part>.html` | The defects a viewer would see, found from the layout through time without drawing a frame. |
| `render <part>.html [--draft] [--from s --to s] [--audio-only] [--fps 60] [--scale 2] [--workers N]` | The composition rendered frame by frame at twice the pixels and scaled down so text and footage stay sharp, mixed with its narration, music and cues, to `<part>/video.mp4`. Quarter-second chunks render in parallel browsers (half the cores, up to 32). `--draft` is 30 fps at 1x. `--from` and `--to` redraw that stretch only. Music or effects not made yet are left out with a warning; `--audio-only` remixes the sound onto the last frames. |
| `browse [url]` | Chrome with the video profile, for the user to sign in once; waits until the window closes. |
| `walk <part>.walk.mjs [--rehearse] [--scale 3] [--headless] [--realtime]` | Runs a walkthrough script in that Chrome and records the part to `<part>/video.mp4` at 60 fps, with its marks in `<part>/video.marks.json`. Any other script name runs without recording. |
| `live <part>.json` | Reassembles a recorded part from its frames. |
| `crop <part>.json <mark\|W:H:X:Y> <out.mp4> [--pad 8] [--at 1]` | A recorded part cropped to a mark's element or a box, with a preview frame to check the edges. |
| `card <out.mp4> <title> [--eyebrow x] [--style <part>.html]` | A chapter title card in the brand's style. |
| `concat <out.mp4> <part.mp4>...` | Joins parts, embeds chapters from cards and prints YouTube chapters. |
| `check <video.mp4>` | A contact sheet beside the video, frozen time, judder (frames that stall mid-motion), loudness overall and second by second, and whether the render is final. `check <sound.wav>` measures one sound. |
| `doctor [--fix]` | Checks this machine (bun, ffmpeg, browser and its codecs, fonts, display, key, sign-ins) and prints each fix; `--fix` installs what it can. |

## Reuse

Each part folder keeps its audio and frames, so a change needs only that part re-rendered, then `concat`. Delete `<repo>/.video-build/<slug>` when the video is final, unless the user wants to iterate later.
