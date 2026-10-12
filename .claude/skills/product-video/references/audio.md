# Audio

Audio makes otherwise strong visuals feel amateur more than anything else. Adapted in part from [motion-video-kit](https://github.com/echris6/motion-video-kit) (MIT).

## Music

- **Match the music to the audience, not to "tech launch".** Developer and SaaS launches: confident, modern, 110-125 BPM, tight drums, warm bass, bright plucks. Consumer and home services: warm, acoustic-leaning, about 85 BPM, major key. Finance, health, legal: restrained, piano or soft pads with a steady pulse.
- `bun $SKILL/video.ts music assets/music.mp3 --seconds <film length> --prompt "..."` generates a bed with ElevenLabs Music. It asks for 4 s extra, strips a quiet start, cuts to length and prints momentary loudness per second.
- Prompt it as a production brief: genre, tempo, instruments, energy curve, "starts immediately on the first beat, no intro", "clear resolved final hit at <end card time>, then a short ring-out", "instrumental, no vocals". Never name artists or brands.
- Read the per-second loudness. Regenerate when there is a quiet start, a dip under a key scene, or a fade before the end card.
- Avoid vocals, humming, vinyl crackle, ukulele or whistling stock, trailer hits, EDM drops and anything "epic".
- Declare it in the composition: `Film.create({ music: 'assets/music.mp3', musicGain: -8 })`. A generated bed is mastered loud, and at -8 the effects still cut through; under narration use about `-14`, and the music ducks automatically while someone speaks.
- A track the user supplies works the same way. Check its licence.
- **Edit the music to the picture.** `film.dip(from, to, gainDb)` pulls the music down with short ramps: hold it back (about -8 dB) under the hook so the groove arrives with the product, and cut a dead stop (about -24 dB for 0.3-0.4 s) just before the logo hit. Cut on beats where you can: at 120 BPM a beat falls every 0.5 s.

## Sound effects

- `bun $SKILL/video.ts sfx --kit <build>/sfx` generates a starter set: `whoosh`, `swipe`, `click`, `pop`, `tick`, `hit`, `shimmer`. `sfx <build>/sfx/<name>.mp3 "<description>" --seconds 0.6` makes a specific one. Every effect is high-passed, low-passed and faded so it does not rumble, hiss or click.
- Place them with `film.cue(t, 'whoosh', gainDb)` at the exact frame of the visual event. Every generated effect sits at the same average level, so a gain of 0 is a clear, normal accent; use -3 to -6 for small UI sounds and repeats, never more than +3.
- **Sparse and clean:** one soft whoosh per real transition; small UI sounds only on real actions (a click on a cursor click, a pop when a card lands, a tick when a value changes); one `hit` on the logo. Never an effect on every motion.
- Repeated sounds keep the same level. Soften sounds that land within 0.15 s of each other by about -4 dB, so they do not stack.
- If the music resolves on the logo, do not add a separate musical sting on top.
- When an effect sounds wrong, regenerate it with a more specific description ("short, no bass, crisp, dry") rather than turning everything up.

## Mix and master

`render` mixes narration, music (ducked under the voice) and cues, then masters to about -14 LUFS integrated for music-led films and -16 LUFS for narrated ones, true peak at or below -1 dBFS. `check` measures the result.

- Loudness range of about 3 LU or more for energetic films; a flat wall of sound reads as stock.
- Say honestly what was measured and what nobody listened to. Measurements cannot judge taste, so offer the user a music-only alternative (`musicGain` up, no cues) if they are unsure about the effects.
