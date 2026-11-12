# Audio

Audio makes otherwise strong visuals feel amateur more than anything else. Adapted in part from [motion-video-kit](https://github.com/echris6/motion-video-kit) (MIT).

Nobody in this loop hears the film. The mix is therefore placed and levelled by measurement, and you read the result: the effects table that `render` prints, `<part>/sound.png`, and the loudness `check` reports. Tell the user that the sound was measured and not listened to.

## Music

- **Match the music to the audience, not to "tech launch".** Developer and SaaS launches: confident, modern, 110-125 BPM, tight drums, warm bass, bright plucks. Consumer and home services: warm, acoustic-leaning, about 85 BPM, major key. Finance, health, legal: restrained, piano or soft pads with a steady pulse.
- `bun $SKILL/video.ts music assets/music.mp3 --seconds <film length> --prompt "..."` generates a bed with ElevenLabs Music. It asks for 4 s extra, strips a quiet start, cuts to length and prints the loudness of each second.
- Prompt it as a production brief: genre, tempo, instruments, energy curve, "starts immediately on the first beat, no intro", "clear resolved final hit at <end card time>, then a short ring-out", "instrumental, no vocals". Never name artists or brands.
- Read the loudness by second. Regenerate when the first second is more than about 6 dB under the rest (a slow start), when there is a dip under a key scene, or a fade before the end card.
- Avoid vocals, humming, vinyl crackle, ukulele or whistling stock, trailer hits, EDM drops and anything "epic".
- Declare it in the composition: `Film.create({ music: 'assets/music.mp3', musicGain: -8 })`. Under narration use about `-14`, and the music ducks automatically while someone speaks.
- A track the user supplies works the same way. Check its licence.
- **Edit the music to the picture.** `film.dip(from, to, gainDb)` pulls the music down with short ramps: hold it back (about -8 dB) under the hook so the groove arrives with the product, and cut a dead stop (about -24 dB for 0.3-0.4 s) just before the logo hit. Cut on beats where you can: at 120 BPM a beat falls every 0.5 s.

## Sound effects

`bun $SKILL/video.ts sfx --kit <build>/sfx` writes the kit. It is synthesized by the skill, so it needs no key, is the same on every run, and every sound is built to sit beside the others:

| Sound | Use it for |
| --- | --- |
| `click` | A pointer click: a soft, close tap |
| `tick` | A value or status changing: a tiny glassy tap |
| `pop` | Something appearing: a card, a row, a tooltip |
| `whoosh` | A scene transition: soft air that swells, peaks and falls away |
| `swipe` | A quick move: a camera pan, a card sliding |
| `hit` | The logo, or the one big moment: a soft, deep impact |
| `shimmer` | A success state: a short bright sparkle |

Place a sound with `film.cue(t, 'click')`, where `t` is **the time of the visual event**: the frame the pointer presses, the frame the cut happens, the frame the logo lands. The mix puts the sound's loudest moment on `t`, so a click sounds on the press and a whoosh, which swells first, peaks on the cut. Take `t` from the timeline: the tween's own time for a click or a landing, the middle of the move for a transition (a 0.55 s fly-through from 2.3 s passes the camera at about 2.55 s). Leave out the lead time a sound needs; the mix adds it.

`film.cue(t, sound, gainDb, { pitch, pan, at })`:

- **`gainDb`**: 0 sits in the mix. The effects are levelled against the music (8 dB lower under a voice), and each kit sound carries its own designed level, so 0 is right for most cues. Use -3 to -6 for repeats and small UI sounds in a busy passage, +3 to +6 to feature one moment, never more.
- **`pitch`** in semitones: step it up across a run of the same sound (three cards landing: 0, 2, 4), so the run rises instead of repeating.
- **`pan`** from -1 (left) to 1 (right), for an event at the side of the frame. Keep it within about 0.6.
- **`at: 'start'`** starts the sound on `t` instead of peaking there.
- `Film.create({ effectsGain: -3 })` moves every effect at once, when the user finds them too present or too shy.

Rules:

- **Sparse and clean:** one whoosh per real transition; small UI sounds only on real actions (a click on a cursor click, a pop when a card lands, a tick when a value changes); one `hit` on the logo. A motion without a visible event gets no sound.
- If the music resolves on the logo, leave the `hit` out.
- **A sound the kit lacks:** `sfx <build>/sfx/<name>.wav "<description>" --seconds 0.6` generates it with ElevenLabs, cuts its leading silence, removes rumble and sets it to the kit's level. Describe the source and the character ("short paper slide, dry, close, no bass"). Read the line it prints: `loudest at` should be near 0 for a tap and inside the sound for a swell; a high share of low energy means rumble, so regenerate with "no bass". `check <sound>` measures any sound file, including one the user supplies.

## Reading the mix

`render` prints one line per cue with its level against what plays under it at that moment:

```
effects (13), each with its level against the bed under it; a 0 dB cue is set to sit in the mix:
    4.60s click    -2 dB
    9.80s pop      -6 dB
   16.20s hit      +18 dB (the music is dipped here)
```

- Between about -8 and +6 dB an effect is audible and belongs to the mix. "buried" and "stands far out" lines name a cue to change: adjust that cue's gain by the amount it is off, then `render --audio-only` and read the table again.
- `<part>/sound.png` is the mix as a picture: time left to right, pitch upward, loudness as brightness, a green line at each cue and a blue band over each music dip. Check that each line sits on its sound, that the music is present from the first second, that the dead stop before the logo shows as a dark gap, and that the picture does not fade before the end card.

## Mix and master

`render` mixes narration, music (ducked under the voice) and cues, then masters to about -14 LUFS integrated for music-led films and -16 LUFS for narrated ones, true peak at or below -1 dBFS. `check` measures the result.

- Loudness range of about 3 LU or more for energetic films; a flat wall of sound reads as stock.
- Measurements cannot judge taste. Offer the user a music-only alternative (`effectsGain: -60`) if they are unsure about the effects.
