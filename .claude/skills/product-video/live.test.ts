import { describe, expect, test } from 'bun:test'
// @ts-expect-error a plain module without types
import { frameDriver } from './live.mjs'

type Frame = { at: number; shot: boolean }

/**
 * A browser that draws only when asked, as `frameDriver` sees it: `damage(n)` says whether
 * frame n changes the picture, `ahead(n)` how far the page's clock runs on by itself during it.
 */
function fakeBrowser({ damage = () => false, ahead = () => 0, steppable = true }: { damage?: (frame: number) => boolean; ahead?: (frame: number) => number; steppable?: boolean } = {}) {
	const frames: Frame[] = []
	const base = 5_000_000
	let clock = 0 // the page's clock, in ms since it opened
	let budgets = 0
	let expired = () => {}
	const cdp = {
		on(_event: string, handler: () => void) {
			expired = handler
		},
		async send(method: string, params: { frameTimeTicks: number; screenshot?: object; budget: number }) {
			if (method === 'HeadlessExperimental.beginFrame') {
				if (!steppable) throw new Error("'HeadlessExperimental.beginFrame' wasn't found")
				const last = frames.at(-1)
				// The real browser never answers a new frame that is not later than the last.
				if (last && !params.screenshot && params.frameTimeTicks <= last.at) return new Promise(() => {})
				frames.push({ at: params.frameTimeTicks, shot: Boolean(params.screenshot) })
				return { hasDamage: damage(budgets), screenshotData: params.screenshot ? Buffer.from(`frame ${budgets}`).toString('base64') : undefined }
			}
			if (method === 'Emulation.setVirtualTimePolicy') {
				budgets += 1
				clock += params.budget + ahead(budgets)
				setTimeout(expired, 0)
				return { virtualTimeTicksBase: base }
			}
			if (method === 'Runtime.evaluate') return { result: { value: [1_700_000_000_000, Math.round(clock * 10) / 10] } }
			throw new Error(`unexpected ${method}`)
		}
	}
	const page = { context: () => ({ newCDPSession: async () => cdp }), isClosed: () => false }
	return { page, frames, base, clockAt: () => base + clock }
}

describe('frameDriver', () => {
	test('is null in a browser that draws on its own', async () => {
		expect(await frameDriver(fakeBrowser({ steppable: false }).page)).toBeNull()
	})

	test('draws every frame later than the last, one frame of video apart', async () => {
		const browser = fakeBrowser()
		const driver = await frameDriver(browser.page)
		await driver.sleep(100)
		await driver.close()
		const times = browser.frames.slice(1).map((frame) => frame.at)
		expect(times.length).toBeGreaterThanOrEqual(6)
		for (let index = 1; index < times.length; index++) expect(times[index] - times[index - 1]).toBeCloseTo(1000 / 60, 0)
		expect(driver.now()).toBeCloseTo(times.length / 60, 5)
	})

	test('keeps the frames up with a page whose clock runs ahead', async () => {
		// A write to sessionStorage moves the page's clock on by 10 ms. An animation started then
		// stands still until the frames reach that time, so no frame may be drawn before the clock.
		const browser = fakeBrowser({ ahead: (frame) => (frame > 3 && frame <= 9 ? 10 : 0) })
		const driver = await frameDriver(browser.page)
		await driver.sleep(250)
		await driver.close()
		const drawn = browser.frames.at(-1) as Frame
		expect(drawn.at).toBeGreaterThanOrEqual(browser.clockAt() - 1000 / 60)
		expect(drawn.at - browser.base).toBeGreaterThan(driver.now() * 1000 + 50)
	})

	test('captures a frame only when it changed the picture, by drawing it a second time', async () => {
		const browser = fakeBrowser({ damage: (frame) => frame === 4 || frame === 5 })
		const driver = await frameDriver(browser.page)
		await driver.sleep(34)
		const stored: number[] = []
		driver.capture((seconds: number) => stored.push(Math.round(seconds * 60)))
		await driver.sleep(100)
		await driver.close()
		// The first frame after capture starts is kept whether or not it changed; then 4 and 5.
		expect(stored).toEqual([3, 4, 5])
		const shots = browser.frames.filter((frame) => frame.shot)
		expect(shots.length).toBe(3)
		// Each kept frame is the frame drawn just before it, at the same time.
		for (const shot of shots) expect(browser.frames[browser.frames.indexOf(shot) - 1]).toEqual({ at: shot.at, shot: false })
	})

	test('steps a motion one frame per call, and sleeps count those frames', async () => {
		const browser = fakeBrowser()
		const driver = await frameDriver(browser.page)
		const before = Math.round(driver.now() * 60)
		const seen: number[] = []
		const slept = driver.sleep(1000 / 60 * 5).then(() => Math.round(driver.now() * 60))
		await driver.steps(8, async (index: number) => {
			seen.push(index)
		})
		expect(seen).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
		expect(Math.round(driver.now() * 60) - before).toBeGreaterThanOrEqual(8)
		expect((await slept) - before).toBe(5)
		await driver.close()
	})
})
