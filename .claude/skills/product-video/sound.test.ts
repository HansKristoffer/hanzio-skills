import { describe, expect, test } from 'bun:test'
import { KIT_SOUNDS, RATE, atLevel, kitSound, loudest, soundCard, trimmed, wav, type Stereo } from './sound.ts'

const names = Object.keys(KIT_SOUNDS)

describe('the kit', () => {
	test('has the sounds the templates and docs name', () => {
		expect(names).toEqual(['click', 'tick', 'pop', 'whoosh', 'swipe', 'hit', 'shimmer'])
	})

	test.each(names)('%s is the same on every run, finite and under full scale', (name) => {
		const sound = kitSound(name)
		expect(wav(kitSound(name)).equals(wav(sound))).toBe(true)
		expect(sound.left.every(Number.isFinite) && sound.right.every(Number.isFinite)).toBe(true)
		expect(soundCard(sound).peak).toBeLessThan(-1)
	})

	test.each(['click', 'tick', 'pop', 'hit', 'shimmer'])('%s is loudest as it starts, so it lands on its cue', (name) => {
		expect(soundCard(kitSound(name)).anchor).toBeLessThan(0.03)
	})

	test.each(['whoosh', 'swipe'])('%s swells to a peak inside itself and carries no rumble', (name) => {
		const card = soundCard(kitSound(name))
		expect(card.anchor).toBeGreaterThan(card.seconds * 0.25)
		expect(card.anchor).toBeLessThan(card.seconds * 0.6)
		expect(card.low).toBeLessThan(0.02)
	})

	test('keeps its designed balance: the hit over the whoosh over the tick', () => {
		const level = (name: string) => soundCard(kitSound(name)).level
		expect(level('hit')).toBeGreaterThan(level('whoosh') + 4)
		expect(level('whoosh')).toBeGreaterThan(level('tick') + 3)
	})
})

/** A 1 kHz burst `seconds` long after `lead` seconds of silence. */
function burst(lead: number, seconds: number, gain: number): Stereo {
	const left = new Float32Array(Math.round((lead + seconds + 0.2) * RATE))
	for (let i = Math.round(lead * RATE); i < Math.round((lead + seconds) * RATE); i++) left[i] = Math.sin((2 * Math.PI * 1000 * i) / RATE) * gain
	return { left, right: left.slice() }
}

describe('preparing a sound', () => {
	test('trimmed cuts the silence before a sound, so it starts on its cue', () => {
		const cut = trimmed(burst(0.07, 0.1, 0.5))
		expect(soundCard(cut).anchor).toBeLessThan(0.06)
		expect(cut.left.length / RATE).toBeLessThan(0.15)
	})

	test('trimmed keeps at most the asked length', () => {
		expect(trimmed(burst(0, 1, 0.5), -60, 0.3).left.length / RATE).toBeLessThanOrEqual(0.3)
	})

	test('atLevel sets the loudest 50 ms, and turns a peaky sound down instead of clipping it', () => {
		expect(loudest(atLevel(burst(0, 0.3, 0.1), -18), 0.05).level).toBeCloseTo(-18, 1)
		const loud = atLevel(burst(0, 0.3, 0.1), 6)
		expect(soundCard(loud).peak).toBeLessThanOrEqual(-0.99)
	})

	test('wav writes 24-bit stereo at 48 kHz', () => {
		const file = wav(burst(0, 0.01, 0.5))
		expect(file.toString('ascii', 0, 4)).toBe('RIFF')
		expect(file.readUInt32LE(24)).toBe(48000)
		expect(file.readUInt16LE(34)).toBe(24)
		expect(file.length).toBe(44 + Math.round(0.21 * RATE) * 6)
	})
})
