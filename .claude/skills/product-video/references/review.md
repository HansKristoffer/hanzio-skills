# Review

Clean, smooth, error-free cuts still get rejected for being basic, empty or slow. Judge the actual frames, measure what can be measured, and never grade your own work as finished. Adapted from the Gauntlet loop in [motion-video-kit](https://github.com/echris6/motion-video-kit) (MIT).

## While building

Use `bun $SKILL/video.ts stills <build>/film.html --every 0.5` (or `--at 2.3,2.5,2.7` around a transition) after every meaningful change, and look at the contact sheet. It renders in seconds. Render the full film only when the stills look right.

## Quality bar

Measured by `check`:

| Check | Target |
| --- | --- |
| Frozen time | Under about 1 s per 30 s; no hold over 0.6 s except the end card |
| Loudness | About -14 LUFS music-led, -16 narrated; true peak at or below -1 dBFS |
| Loudness range | About 3 LU or more for energetic films |

Judged on frames:

- No empty frames: no blank band before a title lands, no lone element in an empty field.
- Frame 0 is a finished composition.
- No text collisions, including mid-transition: text never crosses text, and wipes never splice two titles.
- Equal spacing and shared left edges in lists and rows.
- The lead subject fills 60-85 % of the frame in feature beats.
- Labels and callouts sit on the thing they name.
- Transitions carry an object or match a direction; never an unrelated slide-in after another.
- Imagery is bright and clear unless the brand is dark.
- On mute, a first-time viewer can say what the product does and the one next action. The CTA is readable at phone size for at least 1.5 s.
- Every claim is true and sourced, or the film is labelled as a concept.

## The critic loop

After a full render and `check`, get an independent review. Spawn a fresh agent: the Agent tool, `delegate_task`, or another model. Give it only the video path, the brief and this file's quality bar. Never give it your reasoning or a list of what you think you fixed.

```
You are an independent, harsh critic of a short product video. You did not make it.
Judge rendered pixels and measured audio, not intentions.

Video: <absolute path> (<seconds> s, <size>, 60 fps, with audio).
What it is: <product, audience, the one message, the CTA>. Brand: <colors, type>.
Benchmark: premium SaaS launch films on X and YouTube.
Quality bar: <paste the quality bar above>.
<For a verification round: the previous report is at <path>. For each item, give FIXED / PARTLY / STILL PRESENT.>

Method: extract frames with ffmpeg: a contact sheet every 0.25 s, plus every frame (1/60 s)
in a window of ±0.3 s around each transition (<times>). Look at them. Run
`bun <SKILL>/video.ts check <video>` for frozen time and loudness.

Report in under 600 words, also written to <path>:
1. Per beat: time range, what is on screen, what is weak.
2. Defects with timestamps: empty frames, collisions, holds, pops, misaligned labels, unreadable text.
3. The 5 changes that would improve it most, concrete enough to implement.
End with SHIP or ONE MORE PASS.
```

Fix the largest gaps first; do not average a weak opening away with strengths elsewhere. Re-render, then send the new cut and the previous report to a new critic for verification. Stop at SHIP, when the remaining items are cosmetic, or after three rounds, and tell the user what is still open.

## Delivering

Tell the user the output path, length and size. Say what the critic found and what changed, the `check` numbers, and anything unverified (for example: "nobody listened to the mix; measured only"). For a concept film about someone else's product, repeat that it is unofficial.
