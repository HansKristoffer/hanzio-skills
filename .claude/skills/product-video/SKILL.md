---
name: product-video
description: Make professional product videos in any repository, from code-built motion graphics rendered frame by frame at 60 fps, live ego-browser recordings of the real product, ElevenLabs narration, music and sound effects, checked by measurement and an independent critic. Covers SaaS launch films in the style seen on X, feature explainers, product demos and chaptered walkthroughs. Use when asked for a product video, launch video, promo, explainer, demo, walkthrough or screen recording with voice-over.
---

# Product video

Every video is one or more **parts** joined in order:

- **Composition**: an HTML page animated with GSAP on one timeline and rendered frame by frame, so every frame is exact. It can be music-led (a launch film) or timed to narration (an explainer), and it can embed real screenshots and recorded clips.
- **Live**: a scripted ego-browser session on the real product, screencast while the narration plays (`references/walkthrough.md`).

`SKILL` below means the absolute path of the folder holding this file, for example `~/.claude/skills/product-video`. Every command is `bun $SKILL/video.ts <command>`.

Read only the reference the current step needs:

| Step | Read |
| --- | --- |
| Brand, logo, colors, fonts, real product imagery, a product from the internet | `references/assets.md` |
| Storyboard and building a composition | `references/motion.md` |
| Music, sound effects, narration mix | `references/audio.md` |
| Checking stills, measuring, the critic loop, delivering | `references/review.md` |
| Recording the real product, demos, a chaptered written script | `references/walkthrough.md` |

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

## Where things go

- Build files go in `<repo>/.video-build/<slug>/`. `init` adds that folder to `.git/info/exclude`, so it never shows in `git status`. Outside a git repository, the current directory is the root.
- The finished video goes to `<repo>/<slug>.mp4`, also excluded from git; commit it only when asked.
- Requires `bun` and `ffmpeg`, and Google Chrome or a Playwright Chromium. `video.ts` installs its own `playwright-core` and `gsap` on first use. Live parts need the `ego-browser` CLI and its skill; ego-browser is also the way to read brands and capture product screenshots.

## ElevenLabs key

Narration, music and sound effects use ElevenLabs. The key is `ELEVENLABS_API_KEY` from the environment, otherwise from `$SKILL/.env` (mode 600, gitignored).

When a command exits with `NO_ELEVENLABS_KEY`, or ElevenLabs rejects the key, stop and ask the user in the chat for their ElevenLabs API key. When they paste it, store it without echoing it, then rerun the command:

```bash
printf '%s' '<key>' | bun $SKILL/video.ts set-key
```

Never repeat the key in a reply, write it into a repository or print it to a log. Without ElevenLabs, narration can use macOS `say` (`narrate <part>.json --say`), and music can be a licensed track the user supplies.

## Workflow

1. **Brief.** `bun $SKILL/video.ts init <slug>` creates the build folder with `brief.md`, `film.html` (the launch template) and `assets/` and `sfx/` folders; `init <slug> --narrated` starts from the narrated explainer with `film.json`. Fill in the brief: product, audience, the one message, the CTA, true claims with sources, length, format and sound. Ask the user only for what you cannot find yourself.
2. **Brand and assets.** Follow `references/assets.md`: the brand's colors, type and logo, the real product imagery, and the facts, each with its source in `assets/SOURCES.md`.
3. **Storyboard.** Before building, write a table in the brief: time, what the viewer sees, what the beat says, the transition out and what carries across it. Use 12-15 compositions per 30 s and name three signature moments. Follow `references/motion.md`.
4. **Sound first for a launch film.** Generate the music to the storyboard's length, and the effect kit (`references/audio.md`). For narrated films, write `film.json` (one `{ "id", "text" }` per scene, plain spoken sentences, the product's own words) and run `narrate`, which sets each scene's length.
5. **Build** the composition from the template: restyle the brand tokens, replace the mock product with the real imagery, and choreograph each beat with the Film helpers. Check `stills` after every meaningful change.
6. **Render** a draft with `render --fps 15` (four times faster) and `check` it: frozen time and loudness read the same. Fix the holds, then render at 60 fps and `check` again.
7. **Critic loop.** A fresh agent reviews the render against the quality bar; fix the largest gaps and verify with a new critic (`references/review.md`).
8. **Join and deliver.** `concat` the parts into `<repo>/<slug>.mp4` when there is more than one, run `check` once more, and report the result honestly.

## Commands

| Command | Does |
| --- | --- |
| `init <slug> [--narrated]` | Creates the build folder, git-excluded, from a template. |
| `narrate <part>.json [--say]` | Voices each scene into `<part>/timing.json`; reports words per minute. `SPEED=0.7-1.2` slows or speeds it up. Also `VOICE`, `MODEL`, `LANGUAGE`. |
| `music <out.mp3> --seconds N --prompt "..."` | A music bed from ElevenLabs Music, trimmed to start on the beat; prints loudness per second. |
| `sfx --kit <dir>` / `sfx <out.mp3> "<description>" [--seconds 0.6]` | Clean sound effects from ElevenLabs. |
| `stills <part>.html [--every 0.5 \| --at 1,2.5]` | Frames at chosen times and a contact sheet, in seconds. |
| `render <part>.html [--fps 60] [--audio-only]` | The composition rendered frame by frame, mixed with its narration, music and cues, to `<part>/video.mp4`. `--audio-only` remixes the sound onto the last frames. |
| `live <part>.json` | A recorded live walkthrough assembled to `<part>/video.mp4`. |
| `card <out.mp4> <title> [--eyebrow x] [--style <part>.html]` | A chapter title card in the brand's style. |
| `concat <out.mp4> <part.mp4>...` | Joins parts, embeds chapters from cards and prints YouTube chapters. |
| `check <video.mp4>` | Contact sheet, frozen time and loudness. |

## Reuse

Each part folder keeps its audio and frames, so a change needs only that part re-rendered, then `concat`. Delete `<repo>/.video-build/<slug>` when the video is final, unless the user wants to iterate later.
