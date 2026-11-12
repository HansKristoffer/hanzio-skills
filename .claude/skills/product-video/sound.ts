// Sound for product videos: the effect kit, synthesized here so it needs no key and comes out the
// same on every run, and the measurements the mix uses to place and level sounds nobody in the
// loop can hear. Everything is 48 kHz stereo.

export const RATE = 48000

/** The level a 0 dB cue is calibrated to: its loudest 50 ms, in dBFS. Kit sounds sit around it by design. */
export const REFERENCE_LEVEL = -18

export type Stereo = { left: Float32Array; right: Float32Array }

/** What the mix and the agent need to know about a sound without hearing it. */
export type SoundCard = {
	seconds: number
	/** Seconds in at which the sound is loudest (10 ms window): the mix puts this moment on the cue time. */
	anchor: number
	/** Its loudest 50 ms, in dBFS: what "how loud" means for a short sound. */
	level: number
	/** Highest sample, in dBFS. */
	peak: number
	/** Share of the energy under 120 Hz (rumble) and over 8 kHz (air, or hiss), 0-1. */
	low: number
	high: number
}

const samples = (seconds: number) => Math.round(seconds * RATE)
const db = (ratio: number) => 20 * Math.log10(Math.max(ratio, 1e-9))

/** Deterministic white noise in [-1, 1): the same seed gives the same sound. */
function noise(seconds: number, seed: number) {
	const out = new Float32Array(samples(seconds))
	let state = seed
	for (let i = 0; i < out.length; i++) {
		state = (state + 0x6d2b79f5) | 0
		let t = Math.imul(state ^ (state >>> 15), 1 | state)
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
		out[i] = ((t ^ (t >>> 14)) >>> 0) / 2147483648 - 1
	}
	return out
}

/** A sine whose frequency and loudness follow `freq(t)` and `amp(t)`. */
function tone(seconds: number, freq: (t: number) => number, amp: (t: number) => number) {
	const out = new Float32Array(samples(seconds))
	let phase = 0
	for (let i = 0; i < out.length; i++) {
		const t = i / RATE
		phase += (2 * Math.PI * freq(t)) / RATE
		out[i] = Math.sin(phase) * amp(t)
	}
	return out
}

/** A smooth rise from 0 to 1 over `seconds`, so nothing starts with a digital click. */
const attack = (t: number, seconds: number) => (t >= seconds ? 1 : 0.5 - 0.5 * Math.cos((Math.PI * t) / seconds))

/**
 * A state-variable filter (Zavalishin's, stable while its cutoff moves): low, band or high pass at
 * `cutoff` Hz, which may change per sample. 12 dB per octave; run it twice for a steeper edge.
 */
function filter(input: Float32Array, mode: 'low' | 'band' | 'high', cutoff: number | ((i: number) => number), q = 0.707) {
	const out = new Float32Array(input.length)
	const k = 1 / q
	let ic1 = 0
	let ic2 = 0
	let g = 0
	let a1 = 0
	let a2 = 0
	let a3 = 0
	const tune = (hz: number) => {
		g = Math.tan((Math.PI * Math.min(hz, RATE * 0.45)) / RATE)
		a1 = 1 / (1 + g * (g + k))
		a2 = g * a1
		a3 = g * a2
	}
	if (typeof cutoff === 'number') tune(cutoff)
	for (let i = 0; i < input.length; i++) {
		if (typeof cutoff === 'function' && i % 16 === 0) tune(cutoff(i))
		const v3 = input[i] - ic2
		const v1 = a1 * ic1 + a2 * v3
		const v2 = ic2 + a2 * ic1 + a3 * v3
		ic1 = 2 * v1 - ic1
		ic2 = 2 * v2 - ic2
		out[i] = mode === 'low' ? v2 : mode === 'band' ? v1 : input[i] - k * v1 - v2
	}
	return out
}

/**
 * A struck object: `strike` (a short burst) rings a set of resonances, each `{ hz, ring, gain }`
 * with `ring` the seconds it takes to fall to a third. A noise strike makes each hit a little
 * irregular, which is what separates a tap from a synthesizer beep.
 */
function struck(seconds: number, strike: Float32Array, modes: { hz: number; ring: number; gain: number }[]) {
	const out = new Float32Array(samples(seconds))
	for (const { hz, ring, gain } of modes) {
		const r = Math.exp(-1 / (ring * RATE))
		const b1 = 2 * r * Math.cos((2 * Math.PI * hz) / RATE)
		const b2 = -r * r
		const mode = new Float32Array(out.length)
		let y1 = 0
		let y2 = 0
		let top = 0
		for (let i = 0; i < mode.length; i++) {
			const y = (strike[i] ?? 0) + b1 * y1 + b2 * y2
			y2 = y1
			y1 = y
			mode[i] = y
			top = Math.max(top, Math.abs(y))
		}
		for (let i = 0; i < out.length; i++) out[i] += (mode[i] / (top || 1)) * gain
	}
	return out
}

/**
 * The burst that strikes: a rounded pulse `width` seconds wide plus `grit` of noise, `seconds`
 * long. A wider pulse and less grit is a softer mallet.
 */
function strike(seconds: number, seed: number, grit = 0.5, width = 0.001) {
	const hiss = noise(seconds, seed)
	return hiss.map((value, i) => {
		const t = i / RATE
		const pulse = t < width ? 0.5 - 0.5 * Math.cos((2 * Math.PI * t) / width) : 0
		return (pulse + value * grit) * Math.exp(-t / (seconds / 4))
	})
}

/** Adds `source * gain` into `target` from `at` seconds on. */
function add(target: Float32Array, source: Float32Array, gain = 1, at = 0) {
	const offset = samples(at)
	for (let i = 0; i < source.length && i + offset < target.length; i++) target[i + offset] += source[i] * gain
}

/**
 * A small room around a dry sound, which is what makes it sit in a film instead of on top of it:
 * four damped echoes and two diffusers per side, the right side slightly longer than the left so
 * the tail is wide. `seconds` is how long the tail takes to die (60 dB), `mix` how much of it.
 */
function room(dry: Float32Array, { seconds, mix, size = 1, damp = 0.35 }: { seconds: number; mix: number; size?: number; damp?: number }): Stereo {
	const side = (spread: number) => {
		const out = new Float32Array(dry.length)
		for (const ms of [29.7, 37.1, 41.1, 43.7]) {
			const delay = Math.round((ms * size * spread * RATE) / 1000)
			const feedback = 10 ** ((-3 * delay) / RATE / seconds)
			const line = new Float32Array(delay)
			let held = 0
			for (let i = 0; i < dry.length; i++) {
				const echo = line[i % delay]
				held = echo * (1 - damp) + held * damp
				line[i % delay] = dry[i] + held * feedback
				out[i] += echo * 0.25
			}
		}
		for (const ms of [5, 1.7]) {
			const delay = Math.round((ms * size * spread * RATE) / 1000)
			const line = new Float32Array(delay)
			for (let i = 0; i < out.length; i++) {
				const echo = line[i % delay]
				const input = out[i]
				line[i % delay] = input + echo * 0.5
				out[i] = echo - input * 0.5
			}
		}
		return out
	}
	const left = side(1)
	const right = side(1.07)
	for (let i = 0; i < dry.length; i++) {
		left[i] = dry[i] + left[i] * mix
		right[i] = dry[i] + right[i] * mix
	}
	return { left, right }
}

/**
 * Air moving past: noise through a band that sweeps up to `high` Hz and back down while the
 * loudness swells and falls, peaking `peakAt` (0-1) of the way through. The pitch leads the
 * loudness, as a pass-by does. Mid and side noise keep it wide and still whole in mono.
 */
function sweep({ seconds, peakAt, low, high, tail, q, air, seed }: { seconds: number; peakAt: number; low: number; high: number; tail: number; q: number; air: number; seed: number }): Stereo {
	const swell = (i: number) => {
		const p = i / RATE / seconds
		return p < peakAt ? (p / peakAt) ** 2.4 : Math.max(0, 1 - (p - peakAt) / (1 - peakAt)) ** 1.8
	}
	const band = (i: number) => {
		const from = i / RATE / seconds < peakAt ? low : tail
		return from * (high / from) ** (swell(i) ** 0.6)
	}
	const voice = (voiceSeed: number) => {
		const body = filter(noise(seconds, voiceSeed), 'band', band, q)
		const breath = filter(noise(seconds, voiceSeed + 101), 'high', 6500)
		const out = body.map((value, i) => (value + breath[i] * air * swell(i) ** 0.6) * swell(i))
		// Twice through the high-pass: 24 dB per octave under 150 Hz, so no rumble is left to mask the music.
		return filter(filter(out, 'high', 150), 'high', 150)
	}
	const mid = voice(seed)
	const wide = voice(seed + 7)
	const left = mid.map((value, i) => value + wide[i] * 0.45)
	const right = mid.map((value, i) => value - wide[i] * 0.45)
	return { left, right }
}

/** Every kit sound: how it is built and the level its loudest 50 ms sits at, in dBFS. */
const KIT: Record<string, { level: number; what: string; build: () => Stereo }> = {
	click: {
		level: -20,
		what: 'a soft, close tap for a pointer click',
		build: () => {
			// Short rings, so it reads as a tap and not as a note.
			const tap = struck(0.2, strike(0.005, 11, 0.8), [
				{ hz: 380, ring: 0.012, gain: 0.8 },
				{ hz: 1250, ring: 0.008, gain: 0.6 },
				{ hz: 2600, ring: 0.005, gain: 0.35 },
				{ hz: 4300, ring: 0.003, gain: 0.2 }
			])
			return room(filter(tap, 'low', 9000), { seconds: 0.16, mix: 0.12, size: 0.4 })
		}
	},
	tick: {
		level: -25,
		what: 'a tiny glassy tap for a value or status changing',
		build: () => {
			const tap = struck(0.16, strike(0.002, 23, 0.3), [
				{ hz: 2200, ring: 0.011, gain: 1 },
				{ hz: 3350, ring: 0.006, gain: 0.4 },
				{ hz: 5200, ring: 0.003, gain: 0.18 }
			])
			return room(filter(tap, 'high', 900), { seconds: 0.14, mix: 0.1, size: 0.35 })
		}
	},
	pop: {
		level: -21,
		what: 'a round bubble for something appearing: a card, a row, a tooltip',
		build: () => {
			// A bubble's pitch rises as it opens.
			const bubble = tone(0.3, (t) => 760 - 380 * Math.exp(-t / 0.022), (t) => attack(t, 0.002) * Math.exp(-t / 0.04))
			const overtone = tone(0.3, (t) => 2 * (760 - 380 * Math.exp(-t / 0.022)), (t) => attack(t, 0.002) * Math.exp(-t / 0.022))
			const out = new Float32Array(samples(0.3))
			add(out, bubble)
			add(out, overtone, 0.14)
			add(out, filter(strike(0.003, 31), 'band', 3000, 1.2), 0.12)
			return room(out, { seconds: 0.2, mix: 0.12, size: 0.45 })
		}
	},
	whoosh: {
		level: -20,
		what: 'soft air for a scene transition; it swells, peaks on the cut and falls away',
		build: () => {
			const { left, right } = sweep({ seconds: 0.75, peakAt: 0.45, low: 320, high: 2400, tail: 520, q: 0.8, air: 0.16, seed: 41 })
			// The room is fed the two sides separately, so the width survives it.
			return { left: room(left, { seconds: 0.35, mix: 0.1 }).left, right: room(right, { seconds: 0.35, mix: 0.1 }).right }
		}
	},
	swipe: {
		level: -23,
		what: 'a short, light pass for a quick move: a camera pan, a card sliding',
		build: () => sweep({ seconds: 0.34, peakAt: 0.4, low: 800, high: 4600, tail: 1400, q: 1, air: 0.22, seed: 53 })
	},
	hit: {
		level: -13,
		what: 'a soft, deep impact for the logo or the one big moment',
		build: () => {
			const out = new Float32Array(samples(1.5))
			const sub = tone(1.5, (t) => 46 + 70 * Math.exp(-t / 0.035), (t) => attack(t, 0.004) * Math.exp(-t / 0.22))
			// Soft clipping adds harmonics above the sub. With the knock and the thud beside it, half the
			// weight sits over 120 Hz, where a phone speaker can play it.
			add(out, sub.map((value) => Math.tanh(value * 2.2) / Math.tanh(2.2)), 0.7)
			add(out, struck(0.8, strike(0.006, 61, 0.8), [
				{ hz: 132, ring: 0.09, gain: 1 },
				{ hz: 264, ring: 0.05, gain: 0.7 },
				{ hz: 520, ring: 0.025, gain: 0.35 }
			]), 0.9)
			add(out, filter(noise(0.5, 63), 'low', 700).map((value, i) => value * attack(i / RATE, 0.002) * Math.exp(-i / RATE / 0.05)), 0.8)
			add(out, filter(noise(0.6, 67), 'band', 2600, 0.6).map((value, i) => value * Math.exp(-i / RATE / 0.09)), 0.1)
			return room(filter(out, 'high', 28), { seconds: 1.3, mix: 0.2, damp: 0.55 })
		}
	},
	shimmer: {
		level: -22,
		what: 'a bright, short sparkle for a success state',
		build: () => {
			const out = new Float32Array(samples(1.3))
			// A rising major arpeggio of small bells, the first the loudest so the sparkle starts on the cue.
			for (const [index, hz] of [1568, 2093, 2637, 3136, 4186].entries()) {
				const ring = 0.2 - index * 0.02
				const bell = struck(1.3 - index * 0.045, strike(0.004, 71 + index, 0.08, 0.003), [
					{ hz, ring, gain: 1 },
					{ hz: hz * 1.004, ring, gain: 0.5 },
					{ hz: hz * 2.76, ring: ring * 0.3, gain: 0.1 }
				])
				add(out, bell, 1 - index * 0.16, index * 0.045)
			}
			const air = filter(noise(0.7, 79), 'high', 9000).map((value, i) => value * attack(i / RATE, 0.08) * Math.exp(-i / RATE / 0.3))
			add(out, air, 0.04)
			// The strikes carry a thump the bells do not need.
			return room(filter(filter(out, 'high', 800), 'high', 800), { seconds: 1.1, mix: 0.3, damp: 0.2 })
		}
	}
}

export const KIT_SOUNDS = Object.fromEntries(Object.entries(KIT).map(([name, { what }]) => [name, what]))

/** A kit sound, at its designed level, faded out at its end. */
export function kitSound(name: string): Stereo {
	const sound = KIT[name]
	if (!sound) throw new Error(`no kit sound "${name}"; the kit has: ${Object.keys(KIT).join(', ')}`)
	return atLevel(trimmed(sound.build()), sound.level)
}

/** The mean power of both sides per sample: what loudness is measured on. */
function power({ left, right }: Stereo) {
	const out = new Float64Array(left.length)
	for (let i = 0; i < out.length; i++) out[i] = (left[i] * left[i] + right[i] * right[i]) / 2
	return out
}

/** The loudest `window` seconds of a sound: its level in dBFS and the time of its middle. */
export function loudest(sound: Stereo, window: number) {
	const energy = power(sound)
	const width = Math.max(1, Math.min(energy.length, samples(window)))
	let sum = 0
	let best = 0
	let bestEnd = width
	for (let i = 0; i < energy.length; i++) {
		sum += energy[i]
		if (i >= width) sum -= energy[i - width]
		if (i >= width - 1 && sum > best) {
			best = sum
			bestEnd = i + 1
		}
	}
	return { level: db(Math.sqrt(best / width)), time: (bestEnd - width / 2) / RATE }
}

/** Measures a sound: see `SoundCard`. */
export function soundCard(sound: Stereo): SoundCard {
	const energy = power(sound)
	let top = 0
	let total = 0
	for (let i = 0; i < energy.length; i++) {
		top = Math.max(top, Math.abs(sound.left[i]), Math.abs(sound.right[i]))
		total += energy[i]
	}
	const share = (mode: 'low' | 'high', hz: number) => {
		const band = { left: filter(filter(sound.left, mode, hz), mode, hz), right: filter(filter(sound.right, mode, hz), mode, hz) }
		return Math.min(1, power(band).reduce((sum, value) => sum + value, 0) / (total || 1))
	}
	return {
		seconds: sound.left.length / RATE,
		anchor: loudest(sound, 0.01).time,
		level: loudest(sound, 0.05).level,
		peak: db(top),
		low: share('low', 120),
		high: share('high', 8000)
	}
}

/**
 * Cuts the silence before a sound (keeping 2 ms, so it starts on its cue) and after it, keeps at
 * most `longest` seconds, and fades the last 30 ms so the end never clicks.
 */
export function trimmed({ left, right }: Stereo, floorDb = -60, longest = Number.POSITIVE_INFINITY): Stereo {
	let top = 0
	for (let i = 0; i < left.length; i++) top = Math.max(top, Math.abs(left[i]), Math.abs(right[i]))
	const floor = top * 10 ** (floorDb / 20)
	const loud = (i: number) => Math.abs(left[i]) > floor || Math.abs(right[i]) > floor
	let start = 0
	while (start < left.length - 1 && !loud(start)) start++
	let end = left.length - 1
	while (end > start && !loud(end)) end--
	start = Math.max(0, start - samples(0.002))
	end = Math.min(left.length, end + samples(0.03), start + samples(longest))
	const cut = { left: left.slice(start, end), right: right.slice(start, end) }
	const fade = Math.min(samples(0.03), cut.left.length)
	for (let i = 0; i < fade; i++) {
		const gain = i / fade
		cut.left[cut.left.length - 1 - i] *= gain
		cut.right[cut.right.length - 1 - i] *= gain
	}
	return cut
}

/**
 * Scales a sound so its loudest 50 ms sits at `level` dBFS, and lower when a sample would pass
 * -1 dBFS: turned down, never limited, so a transient keeps its shape.
 */
export function atLevel(sound: Stereo, level: number): Stereo {
	const card = soundCard(sound)
	const gain = 10 ** (Math.min(level - card.level, -1 - card.peak) / 20)
	return { left: sound.left.map((value) => value * gain), right: sound.right.map((value) => value * gain) }
}

/** A generated or recorded effect without what makes it sound cheap: rumble under 120 Hz, cut at 24 dB per octave. */
export function withoutRumble({ left, right }: Stereo): Stereo {
	const clean = (side: Float32Array) => filter(filter(side, 'high', 120), 'high', 120)
	return { left: clean(left), right: clean(right) }
}

/** The level of a stretch of sound, in dBFS: what is playing under a cue. */
export function levelBetween(sound: Stereo, from: number, to: number) {
	const energy = power(sound)
	const start = Math.max(0, samples(from))
	const end = Math.min(energy.length, samples(to))
	let sum = 0
	for (let i = start; i < end; i++) sum += energy[i]
	return end > start ? db(Math.sqrt(sum / (end - start))) : -120
}

/** A 48 kHz, 24-bit stereo WAV file. */
export function wav({ left, right }: Stereo) {
	const bytes = left.length * 6
	const out = Buffer.alloc(44 + bytes)
	out.write('RIFF', 0)
	out.writeUInt32LE(36 + bytes, 4)
	out.write('WAVEfmt ', 8)
	out.writeUInt32LE(16, 16)
	out.writeUInt16LE(1, 20) // PCM
	out.writeUInt16LE(2, 22)
	out.writeUInt32LE(RATE, 24)
	out.writeUInt32LE(RATE * 6, 28)
	out.writeUInt16LE(6, 32)
	out.writeUInt16LE(24, 34)
	out.write('data', 36)
	out.writeUInt32LE(bytes, 40)
	for (let i = 0; i < left.length; i++) {
		out.writeIntLE(Math.round(Math.max(-1, Math.min(1, left[i])) * 8388607), 44 + i * 6, 3)
		out.writeIntLE(Math.round(Math.max(-1, Math.min(1, right[i])) * 8388607), 47 + i * 6, 3)
	}
	return out
}

/** Any audio file as 48 kHz stereo samples, decoded by ffmpeg. */
export async function readAudio(file: string): Promise<Stereo> {
	const decoder = Bun.spawn(['ffmpeg', '-v', 'error', '-i', file, '-f', 'f32le', '-ac', '2', '-ar', String(RATE), '-'], { stdout: 'pipe', stderr: 'pipe' })
	const raw = new Float32Array(await new Response(decoder.stdout).arrayBuffer())
	if ((await decoder.exited) !== 0) throw new Error(`cannot read ${file}: ${(await new Response(decoder.stderr).text()).trim()}`)
	const left = new Float32Array(raw.length / 2)
	const right = new Float32Array(raw.length / 2)
	for (let i = 0; i < left.length; i++) {
		left[i] = raw[i * 2]
		right[i] = raw[i * 2 + 1]
	}
	return { left, right }
}

/** One line for a sound: what an agent reads instead of listening. */
export function describeSound(card: SoundCard) {
	const notes = [
		card.low > 0.7 && 'mostly under 120 Hz, which a phone speaker does not play',
		card.peak > -1.5 && 'peaks at full scale (clipped or limited)'
	].filter(Boolean)
	return `${card.seconds.toFixed(2)}s, loudest at ${card.anchor.toFixed(2)}s, level ${card.level.toFixed(1)} dBFS, peak ${card.peak.toFixed(1)} dBFS, ${Math.round(card.low * 100)}% low / ${Math.round(card.high * 100)}% air${notes.length ? `; ${notes.join('; ')}` : ''}`
}
