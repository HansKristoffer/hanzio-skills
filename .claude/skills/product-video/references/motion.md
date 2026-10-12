# Motion

How to build a composition that reads as a professionally edited launch film rather than a slideshow. The grammar is adapted from [motion-video-kit](https://github.com/echris6/motion-video-kit) (MIT), which distilled it from 28 professional SaaS launch films.

## The render contract

`video.ts render` loads the HTML, injects GSAP (with SplitText and CustomEase) and `film.js`, and calls `film.seek(t)` for every frame at 60 fps. Every visual state must therefore be a pure function of time:

- Put every motion on `film.tl`, the paused master timeline, inside `build(film)`.
- Never use `setTimeout`, `setInterval`, `requestAnimationFrame`, `Date.now()`, CSS transitions or `Math.random()` without a fixed seed. A CSS animation is tolerated (seek pauses it at the film time) but GSAP is better.
- Never let two tweens drive the same property of the same element at the same time; they cancel each other. End a drift where the exit begins, or wrap the element: camera > push > subject, one transform per wrapper.
- Measure layout (`offsetLeft`, `getBoundingClientRect`) at the top of `build`, before any `from()` tween moves things.
- A `<video data-start="3.2" src="assets/clip.mp4">` plays from 3.2 s on the film clock, seeked frame by frame. Use it for a recorded live walkthrough (`<part>/video.mp4`) inside a browser or device frame.
- Size comes from `<meta name="film-size" content="1920x1080">`. Use `1080x1920` for vertical social cuts and `1080x1080` for square.

## Real product footage

A recorded clip plays inside a composition on the film clock, frame-exact:

1. Write a silent part, for example `clip-agents.json` with `[{ "id": "agents", "dur": 9 }]`, and run `narrate` on it (no key needed for silent parts).
2. Record it with a walkthrough script (`references/walkthrough.md`): reach the start state before `record`, then do the action inside `rec.scene`. Pass `{ cursor: false }` when nothing is clicked. Start with the subject just out of view when the product animates on arrival, so the animation happens on camera.
3. `bun $SKILL/video.ts live clip-agents.json` prints every `rec.mark` and click with its time in the clip and a `crop=W:H:X:Y` for the marked element (also in `clip-agents/marks.json`). Mark the region you will crop to (the widget, the panel) as well as the events. Crop: `ffmpeg -i clip-agents/video.mp4 -vf "crop=W:H:X:Y" -an -c:v libx264 -crf 16 -pix_fmt yuv420p assets/clip-agents.mp4`, then check one frame of the result for anything outside the subject at its edges.
4. Play it in a frame: `<video src="assets/clip-agents.mp4" data-start="13.3" data-from="1.15" data-rate="0.85" muted></video>`. `data-start` is the film time it begins, `data-from` the clip's in-point, `data-rate` its speed.
5. Time the beat from the marks, never by hand: `const sent = Film.clipAt('#agents video', 5.0)` is the film time the clip reaches its 5.0 s mark; put the caption, the cue and the camera push there.

The screencast captures about 13 frames per second during motion, so prefer clips where the UI changes in steps (text streaming, panels filling, states changing) over fast scrolling, and let the composition provide the smooth camera motion around it.

## Six rules

1. **The foreground becomes the transition.** A headline, logo or shape scales through the camera, blurred and fading, while the next scene is already in place underneath (`Film.flyThrough`). There is never an empty gap between scenes.
2. **One persistent actor.** A cursor, card, window or shape keeps its identity across shots. Unrelated reveals in sequence feel like a slideshow, however well each one is animated.
3. **Density comes from hierarchy.** One primary move (camera or subject), supporting staggers (cards, labels), and fine tertiary detail (a status that changes, a count, a highlight), all overlapping. Do not start and stop the whole frame on every beat.
4. **Change speed; do not drift at a constant rate.** Fast arrival, a readable landing, an accelerating exit. That is what the `land` and `leave` eases do.
5. **Hard cuts are fine** when subject, scale or direction match and the motion continues after the cut.
6. **Show cause and effect.** A click produces a state, a prompt produces a result, a scan produces findings. Every animated action visibly produces something.

## Composition

- The lead subject fills 60-85 % of the frame in feature beats. A small card in a big empty field reads as cheap.
- Vary the composition: wide product, UI close-up (`Film.focus`), typographic impact, card stack, big number, end card. Do not repeat "heading above three cards".
- One or two reading targets at a time.
- Frame 0 is a finished composition, not a half-entered word.
- New text enters only after the outgoing text has cleared. Text never crosses text, and never sits on busy footage without a backing.
- Keep one wipe direction and one title position through a sequence of similar shots.
- Use real product imagery wherever the product appears (see `assets.md`). A built mock is for ideas the product cannot show.

## Lessons from critic rounds

These come up in nearly every first cut; build them in from the start.

- **Overlap every handover.** The next beat's subject starts rising while the last one leaves (about 0.3 s of overlap, matching direction: out upward, in from below). A frame that shows only the background reads as a dropout.
- **Text never crosses text.** The outgoing title leaves 0.3 s before the stage does; the incoming title enters after it. Titles that swap in one place use `Film.headline(..., { out, outDur: 0.15 })`, which returns `words.gone`, the time its last word has left: start a single swapped word at `gone - 0.05` so no frame is empty, and a title of several words or lines at `gone`, or the two splice into one line.
- **Show the payoff of every claim.** If a beat says an agent opens a PR, the camera ends on the PR. A claim with no visible result reads as filler.
- **Callouts belong to their subject.** Keep them outside the zooming camera at screen size (at least 32 px), place them beside, never on top of, a ring or highlight on the thing they name, and let them leave just before that subject does. Check the ring's position on a still with the target outlined (`outline: 3px solid red` on the spot).
- **Zoomed captures fade at the edges.** A full-frame overlay that fades to the background over the outer 7 % stops cropped words from being cut off hard.
- **Before a camera move into the product, the title makes way.** Text on top of busy UI is unreadable; the title leaves, and the product fills the frame.
- **Fly through compact things, lift wide text out.** A logo, a mark or a short word can scale through the camera; a full-width headline clips at the frame edges, so it leaves with `Film.leave` (lift and blur) while the next scene rises.
- **End a clip beat on its payoff.** When a recorded clip finishes its action, cut to the next beat within about 0.5 s, and make sure the crossfade into it has finished before the action starts.
- **A footage beat needs its own camera move.** Screen footage changes in small regions, so `check` reads it as frozen; give the frame a drift of about 8-10 % plus a push onto the payoff (eased out over 2-3 s, not a fast landing that then sits still).
- **A claim stays on screen until its proof appears.** "Answers straight away" must still be up when the answer lands. Cut a wait out of a clip with a jump cut: two `<video>` elements of the same clip in one frame, the first playing up to the action, the second from just before the result (`Film.show` switches them). Speed up typing with `data-rate`, not the answer.
- **A dark logo intro over a living background:** `mix-blend-mode: lighten` on the video drops its flat dark field and keeps the letters, so the end card does not jump to a flat colour.
- **Check the first and last frames of every video asset.** A logo intro or a recorded clip often starts empty or ends on a dead frame; set `data-from` past the lead-in so the beat opens on something.
- **Size for a phone.** On a 1080p frame, anything that must be read is at least 28 px, callouts at least 32 px; the CTA is a 48-60 px pill held at least 1.8 s; a concept label is at least 24 px and not dimmed.

## Pacing

- About 12-15 compositions in 30 s; beats of 1.4-3.5 s.
- No motionless stretch over 0.6 s; a held beat still gets a slow 3-5 % push (`Film.drift`) plus a tertiary change. `check` measures this.
- Hold longest on the frames that carry the message: the product doing its job, the number, the CTA.
- End card: 1.5-2 s readable, gently drifting, music resolving on it.
- Launch films: 15-45 s, music-led, no narration, every claim on screen. Explainers: as long as the narration needs.

## The Film helpers

| Helper | Mechanism |
| --- | --- |
| `Film.show(tl, el, from, to)` | Hard-cut a layer in and out; layers share one stage. |
| `Film.headline(tl, el, at, { out })` | Kinetic type: words rise through a line mask with a stagger and leave upward at `out`. Gradient text survives the split. |
| `Film.rise(tl, els, at)` / `Film.leave(tl, els, at)` | Supporting elements lift, sharpen and fade in; they leave accelerating. |
| `Film.flyThrough(tl, el, at)` | Foreground fly-through transition. |
| `Film.drift(tl, el, from, to, { scale, x, y })` | A slow push so holds stay alive. |
| `Film.tilt(tl, el, at)` | A product surface swings in from a 3D tilt; give a parent a `perspective`. |
| `Film.focus(tl, camera, target, at, { fill })` | The camera moves onto a region of the UI (selection to expansion). |
| `Film.cursor(tl, cursor, points)` | A cursor that glides and clicks, with a ripple. |
| `Film.swap(tl, el, at, text)` | A value or status changes state with a pop. |
| `Film.stack(tl, cards, at)` | Cards arrive and stack; covered cards recede. |
| `Film.counter(tl, el, at, { to })` | A number counts up. |
| `film.cue(t, sound, gainDb)` | A sound effect from `sfx/` at `t` (see `audio.md`). |
| `film.dip(from, to, gainDb)` | Pulls the music down, e.g. a dead stop before the logo hit. |

Raw GSAP is always available for anything else (`tl.to`, `tl.from`, `tl.fromTo`, eases `land`, `leave`, `swap`, `SplitText`).

## Mechanisms worth borrowing

- **Selection to expansion:** a selected card or row expands into the detailed view of the next beat.
- **Materializing result:** a shell appears first, then its regions fill in order (`#result` in the launch template).
- **Persistent rails:** a line or path survives a text swap and connects two states.
- **Continuous canvas:** the camera travels over one layout; the selected item stays sharp while neighbours blur.
- **Card stack or fan:** screens arrive and occlude; one becomes a collection, or the collection resolves to one.
- **Wall to one actor:** information overload collapses to one clear subject. Good for "before" versus "after".
- **Logo as portal:** the brand shape grows until its inside becomes the next frame.
- **Colour-field takeover:** a soft gradient fills the frame for a brand handoff. Use once.
- **Request, picker, confirmation:** a request stays anchored while a sheet rises, a choice is made and the state confirms.

Borrow mechanisms, never another brand's layouts, footage or logos.
