// Records a Playwright page in time with a narrated part, with the helpers a product
// walkthrough needs. `bun video.ts walk <part>.walk.mjs` opens the browser and hands the
// script a `record()` that returns these helpers (see references/walkthrough.md).
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// Scrolls and pointer glides are captured one screenshot per frame at this rate, however
// long each screenshot takes, so they play back smoothly instead of at the capture rate.
const FPS = 60
const easeInOut = (p) => (p < 0.5 ? 4 * p ** 3 : 1 - (-2 * p + 2) ** 3 / 2)
const easeOut = (p) => 1 - (1 - p) ** 3
const clamp = (value, min, max) => Math.min(max, Math.max(min, value))

// Waits for the page to paint what was just changed, or 100 ms in a tab that does not
// paint on its own.
const PAINTED = 'new Promise((resolve) => { requestAnimationFrame(() => requestAnimationFrame(resolve)); setTimeout(resolve, 100) })'

// Runs in the top document of the recorded page: a pointer the recorder moves frame by frame
// (the real one is not in the screenshots), a highlight ring and a caption. The pointer and
// caption survive same-origin navigation through sessionStorage. Only the helpers move the
// pointer: mouse events stop at an iframe's edge, so following them would strand it there.
const OVERLAY_SCRIPT = `(() => {
	if (window.top !== window || window.__video) return
	const style = 'position:fixed;z-index:2147483647;pointer-events:none;'
	const make = (css) => {
		const el = document.createElement('div')
		el.style.cssText = style + css
		document.documentElement.appendChild(el)
		return el
	}
	const mount = () => {
		let point = JSON.parse(sessionStorage.getItem('__videoPointer') || 'null')
		const dot = make('left:-40px;top:-40px;width:26px;height:26px;margin:-13px 0 0 -13px;border-radius:50%;background:rgba(20,20,20,.35);border:2px solid #fff;box-shadow:0 2px 10px rgba(0,0,0,.35);transition:transform .15s')
		const ring = make('border:3px solid #ffb020;border-radius:14px;box-shadow:0 0 0 9999px rgba(0,0,0,.28);opacity:0;transition:opacity .3s,left .3s,top .3s,width .3s,height .3s')
		const caption = make('left:50%;bottom:48px;transform:translateX(-50%);max-width:1400px;padding:16px 28px;border-radius:16px;background:rgba(15,17,21,.88);color:#fff;font:600 28px/1.3 -apple-system,Helvetica,Arial,"Liberation Sans","DejaVu Sans",sans-serif;box-shadow:0 10px 40px rgba(0,0,0,.35);opacity:0;transition:opacity .3s')
		window.__video = {
			move(x, y) {
				dot.style.left = x + 'px'
				dot.style.top = y + 'px'
				point = [x, y]
			},
			where: () => point,
			press(down) { dot.style.transform = down ? 'scale(.7)' : '' },
			ring(box) {
				if (!box) { ring.style.opacity = '0'; return }
				Object.assign(ring.style, { left: box.x - 8 + 'px', top: box.y - 8 + 'px', width: box.width + 16 + 'px', height: box.height + 16 + 'px', opacity: '1' })
			},
			caption(text) {
				if (text) sessionStorage.setItem('__videoCaption', text)
				else sessionStorage.removeItem('__videoCaption')
				caption.textContent = text || ''
				caption.style.opacity = text ? '1' : '0'
			}
		}
		if (point) window.__video.move(...point)
		// Kept for the next page when this one goes, not on every step of a glide.
		addEventListener('pagehide', () => point && sessionStorage.setItem('__videoPointer', JSON.stringify(point)))
		window.__video.caption(sessionStorage.getItem('__videoCaption'))
	}
	document.documentElement ? mount() : addEventListener('DOMContentLoaded', mount)
})()`

/**
 * The flags for a headless Chromium that draws a frame only when `frameDriver` asks for one.
 * Playwright's own headless Chromium takes them; Google Chrome does not.
 */
export const STEPPED_ARGS = [
	'--enable-begin-frame-control',
	'--run-all-compositor-stages-before-draw',
	'--disable-new-content-rendering-timeout',
	'--disable-threaded-animation',
	'--disable-threaded-scrolling',
	'--disable-checker-imaging',
	'--disable-image-animation-resync'
]

/**
 * Steps a page started with `STEPPED_ARGS` one frame of the video at a time: each tick moves
 * the page's clock (timers, animations, transitions) on by 1/60 s and draws that frame, so the
 * page's own motion is recorded at 60 fps however long a screenshot takes. A tick never runs
 * faster than a real frame, so a hold lasts as long as it would for a viewer and the server
 * never looks slower than it is. A frame is only captured when it changed the picture, which
 * the browser reports, so a page holding still costs nothing.
 *
 * Runs from the moment the page opens to the moment it closes, since the page draws nothing
 * without it. Returns null when the browser draws on its own.
 */
export async function frameDriver(page) {
	const cdp = await page.context().newCDPSession(page)
	const frameMs = 1000 / FPS
	let base = 0 // where the page's clock started, in the browser's ticks; a new one after a move to another site
	let at = 0 // the time of the frame being drawn, in those ticks
	// Each tick draws at a later time than the last, or the browser never answers. Within a tick
	// the frame can be drawn again at the same time, to keep it once it is known to have changed.
	const draw = (shot) =>
		cdp.send('HeadlessExperimental.beginFrame', {
			frameTimeTicks: at,
			interval: frameMs,
			...(shot && { screenshot: { format: 'jpeg', quality: 95, optimizeForSpeed: true } })
		})
	try {
		await Promise.race([draw(false), wait(5000).then(() => Promise.reject(new Error('no frame')))])
	} catch {
		return null
	}

	// The document's own clock, read after every step: some work in a page (a write to
	// sessionStorage, a cookie read) moves its clock on by itself, and an animation started at
	// a time the frames have not reached yet stands still until they do.
	const pageClock = () =>
		cdp.send('Runtime.evaluate', { expression: '[performance.timeOrigin, performance.now()]', returnByValue: true }).then(
			(reply) => reply.result?.value ?? null,
			() => null
		)
	let anchor = null // { origin, now, at }: a reading of a document's clock and the frame time it stood for
	let expired
	cdp.on('Emulation.virtualTimeBudgetExpired', () => expired?.())
	async function advance() {
		const done = new Promise((resolve) => {
			expired = resolve
		})
		const { virtualTimeTicksBase } = await cdp.send('Emulation.setVirtualTimePolicy', { policy: 'advance', budget: frameMs })
		// A page busy for seconds, or one replaced mid-frame, must not stop the recording.
		await Promise.race([done, wait(3000)])
		let next = at + frameMs
		if (virtualTimeTicksBase !== base) {
			base = virtualTimeTicksBase
			next = Math.max(next, base + frameMs)
			anchor = null
		}
		// The clock is rounded to 0.1 ms, so the frame is put 0.2 ms late rather than risk early.
		const clock = await pageClock()
		if (clock && anchor?.origin === clock[0]) next = Math.max(at + 0.01, anchor.at + clock[1] - anchor.now + 0.2)
		else if (clock) anchor = { origin: clock[0], now: clock[1], at: next }
		at = next
	}

	let frames = 0
	let sink = null // gets (seconds, jpeg) for each captured frame
	let fresh = false // capture the next frame whether or not it changed
	const sleepers = []
	async function tick() {
		const started = performance.now()
		await advance()
		// Draw first, keep second: asking for the picture of a frame that was not drawn yet stops
		// the page's animations from being served.
		const { hasDamage } = await draw(false)
		frames += 1
		const keep = sink
		if (keep && (hasDamage || fresh)) {
			fresh = false
			keep(frames / FPS, Buffer.from((await draw(true)).screenshotData, 'base64'))
		}
		for (let index = sleepers.length - 1; index >= 0; index--) {
			if (sleepers[index].at <= frames) sleepers.splice(index, 1)[0].resolve()
		}
		const spare = frameMs - (performance.now() - started)
		if (spare > 0) await wait(spare)
	}

	let running = true
	// A frame lost to a page that is going away is skipped; a closed page ends the stepping.
	const step = () =>
		tick().catch(async () => {
			if (page.isClosed()) running = false
			else await wait(50)
		})
	let owner = null // a motion the recorder steps itself
	let inFlight = Promise.resolve()
	const loop = (async () => {
		while (running) {
			if (owner) {
				await owner
				continue
			}
			inFlight = step()
			await inFlight
		}
		for (const sleeper of sleepers.splice(0)) sleeper.resolve()
	})()

	return {
		/** Seconds of video since the page opened. */
		now: () => frames / FPS,
		/** Waits `ms` of video time. */
		sleep(ms) {
			if (ms <= 0 || !running) return Promise.resolve()
			return new Promise((resolve) => sleepers.push({ at: frames + Math.max(1, Math.round(ms / frameMs)), resolve }))
		},
		/** Sends every frame that changes the picture to `store(seconds, jpeg)`, starting with the next; null stops. */
		capture(store) {
			sink = store
			fresh = Boolean(store)
		},
		/** Runs `apply(index)` before each of the next `count` frames, for a motion the recorder drives. */
		async steps(count, apply) {
			let release
			owner = new Promise((resolve) => {
				release = resolve
			})
			await inFlight
			try {
				for (let index = 1; index <= count && running; index++) {
					await apply(index)
					await step()
				}
			} finally {
				owner = null
				release()
			}
		},
		async close() {
			running = false
			await loop
		}
	}
}

/**
 * The element for a CSS selector, or for `text=Save as test` the smallest visible element
 * whose text is exactly that. Serialized into each document it searches, so it must stay
 * self-contained.
 */
function find(selector) {
	const visible = (el) => {
		const rect = el.getBoundingClientRect()
		// Left of the page is off-canvas (a closed drawer, a copy for small screens): no scroll
		// reaches it, and the pointer aims at the centre. Content to the right may sit in a
		// carousel that a scroll brings in.
		const onCanvas = rect.left + rect.width / 2 > 0
		return rect.width > 0 && rect.height > 0 && onCanvas && getComputedStyle(el).visibility !== 'hidden'
	}

	if (selector.startsWith('text=') || selector.startsWith('text*=')) {
		// `text=` matches the whole text, `text*=` any part of it; the innermost match wins.
		const partial = selector.startsWith('text*=')
		const wanted = selector.slice(partial ? 6 : 5).trim().toLowerCase()
		const matches = [...document.querySelectorAll('body *')].filter((node) => {
			const text = node.textContent?.trim().toLowerCase() ?? ''
			return visible(node) && (partial ? text.includes(wanted) : text === wanted)
		})
		return matches.find((node) => !matches.some((other) => other !== node && node.contains(other))) ?? null
	}
	return [...document.querySelectorAll(selector)].find(visible) ?? null
}

/** The element's box in this document's viewport, and whether a fixed layer covers it. Self-contained. */
function measure(find, selector) {
	const el = find(selector)
	if (!el) return null
	const rect = el.getBoundingClientRect()
	// A loading screen or a dialog, a fixed layer, can sit over an element the DOM reports as
	// visible. A sibling on top inside the same row (a stretched link, say) does not count.
	const top = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
	let layer = top
	while (layer && getComputedStyle(layer).position !== 'fixed') layer = layer.parentElement
	const covered = Boolean(layer) && !layer.contains(el)
	// An element fading in (a toast, a dialog) is in the DOM before the viewer can see it.
	let opacity = 1
	for (let node = el; node; node = node.parentElement) opacity *= Number(getComputedStyle(node).opacity)
	return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, covered, faded: opacity < 0.9 }
}

/**
 * Plans the scroll that brings `rect` (a box inside `el`, in its own pixels; all of `el` when
 * left out) into view, through every scroller between `el` and the page, inner first. Centres
 * it when `center` is set or it is not fully in view. Stores the moves for `stepScroll` and
 * returns the longest one and where the box ends up. Self-contained.
 */
function planScroll(el, rect, center) {
	const margin = 48
	const own = el.getBoundingClientRect()
	const box = rect
		? { x: own.x + rect.x, y: own.y + rect.y, width: rect.width, height: rect.height }
		: { x: own.x, y: own.y, width: own.width, height: own.height }
	const root = document.scrollingElement ?? document.documentElement

	// The distance one axis of a scroller moves: none when the box is already inside its view.
	const travel = (start, size, viewStart, viewSize, position, max) => {
		const inside = start >= viewStart + margin && start + size <= viewStart + viewSize - margin
		if (inside && !center) return 0
		const wanted = size > viewSize - margin * 2 ? start - viewStart - margin : start + size / 2 - (viewStart + viewSize / 2)
		return Math.min(max - position, Math.max(-position, wanted))
	}
	const scrolls = (node, overflow, scrollSize, clientSize) =>
		scrollSize > clientSize + 1 && (node === root ? overflow !== 'hidden' : /auto|scroll|overlay/.test(overflow))

	const moves = []
	for (let node = el.parentElement; node; node = node.parentElement) {
		const style = getComputedStyle(node)
		const canX = scrolls(node, style.overflowX, node.scrollWidth, node.clientWidth)
		const canY = scrolls(node, style.overflowY, node.scrollHeight, node.clientHeight)
		if (!canX && !canY) continue

		const r = node.getBoundingClientRect()
		const view = node === root
			? { x: 0, y: 0, width: innerWidth, height: innerHeight }
			: { x: r.x + node.clientLeft, y: r.y + node.clientTop, width: node.clientWidth, height: node.clientHeight }
		const dx = canX ? travel(box.x, box.width, view.x, view.width, node.scrollLeft, node.scrollWidth - node.clientWidth) : 0
		const dy = canY ? travel(box.y, box.height, view.y, view.height, node.scrollTop, node.scrollHeight - node.clientHeight) : 0
		if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue

		moves.push({ node, from: [node.scrollLeft, node.scrollTop], by: [dx, dy] })
		box.x -= dx
		box.y -= dy
	}
	window.__videoScroll = moves
	return { distance: Math.max(0, ...moves.map(({ by }) => Math.hypot(by[0], by[1]))), box }
}

/** Puts every planned scroller `fraction` of the way along its move. Self-contained. */
function stepScroll(fraction) {
	for (const { node, from, by } of window.__videoScroll ?? []) {
		node.scrollTo({ left: from[0] + by[0] * fraction, top: from[1] + by[1] * fraction, behavior: 'instant' })
	}
}

/**
 * `rehearse: true` runs the same walkthrough without recording or waiting for the
 * narration, to check selectors and flow quickly before a take. The page's device scale
 * (set where the browser is opened) is the recording's density. With a `driver` (from
 * `frameDriver`) the recording runs on the page's stepped clock instead of the wall clock.
 */
export async function record(page, partDir, { cursor = true, rehearse = false, driver = null } = {}) {
	const now = driver ? driver.now : () => Date.now() / 1000
	const sleep = driver ? driver.sleep : wait

	const timingFile = join(partDir, 'timing.json')
	const timing = existsSync(timingFile) ? JSON.parse(await readFile(timingFile, 'utf8')) : []
	if (!rehearse && timing.length === 0) throw new Error(`${timingFile} is missing: run narrate first`)

	const scale = await page.evaluate(() => devicePixelRatio)
	if (cursor) {
		await page.addInitScript(OVERLAY_SCRIPT)
		await page.evaluate(OVERLAY_SCRIPT)
	}

	const framesDir = join(partDir, 'frames')
	const frames = []
	const writes = []
	const scenes = []
	const cuts = []
	const marks = []
	let current = null
	let running = true

	if (!rehearse) {
		await rm(framesDir, { recursive: true, force: true })
		await mkdir(framesDir, { recursive: true })
	}

	// Screenshots in device pixels (3840x2160 at scale 2), not a screencast: Chrome's
	// screencast sends CSS-sized frames whatever the scale, so footage would turn soft on a zoom.
	let lastShot
	const store = (t, data) => {
		if (lastShot?.equals(data)) return // nothing changed; the previous frame holds
		lastShot = data
		const file = `${String(frames.length).padStart(6, '0')}.jpg`
		frames.push({ file, t })
		writes.push(writeFile(join(framesDir, file), data))
	}
	const shoot = () => page.screenshot({ type: 'jpeg', quality: 95, scale: 'device', caret: 'initial' })

	// The capture loop runs while the page acts on its own, at up to 30 fps; a stepped motion
	// takes it over once the screenshot in flight has landed. A driver captures on its own.
	let owner = null
	let inFlight = Promise.resolve()
	if (driver && !rehearse) driver.capture(store)
	const capture = (async () => {
		while (running && !rehearse && !driver) {
			if (owner) {
				await owner
				continue
			}
			const t = now()
			inFlight = shoot().then((data) => store(t, data), () => {}) // a navigation can interrupt one
			await inFlight
			await sleep(Math.max(0, 1000 / 30 - (now() - t) * 1000))
		}
	})()

	/**
	 * Plays a motion the recorder drives (a scroll, a pointer glide) at 60 fps: `apply(eased)`
	 * sets each frame, then one screenshot records it on the video's clock. The time the
	 * screenshots take beyond the motion itself is cut, and the narration clock waits for it.
	 */
	async function stepped(seconds, apply, ease = easeInOut) {
		if (rehearse) return apply(1)
		if (driver) {
			const frameCount = Math.max(1, Math.round(seconds * FPS))
			return driver.steps(frameCount, (index) => apply(ease(index / frameCount)))
		}
		let release
		owner = new Promise((resolve) => {
			release = resolve
		})
		await inFlight

		const start = now()
		const count = Math.max(1, Math.round(seconds * FPS))
		for (let index = 1; index <= count; index++) {
			await apply(ease(index / count))
			await page.evaluate(PAINTED)
			store(start + index / FPS, await shoot())
		}
		const end = now()
		const motionEnd = start + count / FPS
		if (end > motionEnd) {
			cuts.push({ start: motionEnd, end })
			if (current) current.cut += end - motionEnd
		}
		owner = null
		release()
	}

	/** Where a frame's content starts, in top-level viewport pixels, through every frame above it. */
	async function frameOrigin(frame) {
		if (!frame.parentFrame()) return { x: 0, y: 0 }
		const owner = await frame.frameElement()
		const inParent = await owner.evaluate((el) => {
			const rect = el.getBoundingClientRect()
			return { x: rect.x + el.clientLeft, y: rect.y + el.clientTop }
		})
		const above = await frameOrigin(frame.parentFrame())
		return { x: above.x + inParent.x, y: above.y + inParent.y }
	}

	/**
	 * Where the element is, in top-level viewport pixels, searching the page, then its frames
	 * (an app embedded in the Shopify admin, say), without scrolling.
	 */
	async function locate(selector) {
		const expression = `(${measure})(${find}, ${JSON.stringify(selector)})`
		for (const frame of page.frames()) {
			const found = await frame.evaluate(expression).catch(() => null)
			if (!found) continue
			const origin = await frameOrigin(frame)
			return { ...found, x: found.x + origin.x, y: found.y + origin.y, frame }
		}
		return null
	}

	/**
	 * Scrolls smoothly until the element is in view, or centred when `center` is set; inside a
	 * frame the frame scrolls and, if that is not enough, each page around it too.
	 */
	async function reveal(found, selector, center) {
		const step = (fraction) => `(${stepScroll})(${fraction})`
		const moving = []
		let frame = found.frame
		let plan = await frame.evaluate(`((el) => el ? (${planScroll})(el, null, ${center}) : null)((${find})(${JSON.stringify(selector)}))`)
		while (plan) {
			const scrolling = frame
			if (plan.distance >= 1) moving.push([plan.distance, (fraction) => scrolling.evaluate(step(fraction))])
			const parent = frame.parentFrame()
			if (!parent) break
			// The box where this frame's scroll leaves the element, brought into view around it.
			const owner = await frame.frameElement()
			plan = await owner.evaluate(
				new Function('el', 'args', `return (${planScroll})(el, { ...args.box, x: args.box.x + el.clientLeft, y: args.box.y + el.clientTop }, args.center)`),
				{ box: plan.box, center }
			)
			frame = parent
		}
		if (moving.length === 0) return
		const distance = Math.max(...moving.map(([travelled]) => travelled))
		const seconds = clamp(0.45 + distance / 2500, 0.45, 1.1)
		await stepped(seconds, (fraction) => Promise.all(moving.map(([, apply]) => apply(fraction))))
	}

	/** The element's box in top-level viewport pixels, scrolled into view and holding still. */
	async function box(selector, { center = false } = {}) {
		let found = await locate(selector)
		if (!found) throw new Error(`nothing visible matches ${selector}`)
		await reveal(found, selector, center)

		// Wait out an overlay and any entrance animation, so a click lands and a mark measures
		// what the viewer sees: the element must be uncovered, opaque and hold still for 100 ms.
		found = await locate(selector)
		for (let tries = 0; found && tries < 50; tries++) {
			await sleep(100)
			const again = await locate(selector)
			const settled = again && Math.abs(again.x - found.x) < 1 && Math.abs(again.y - found.y) < 1
			found = again
			if (settled && !again.covered && !again.faded) break
		}
		if (!found) throw new Error(`${selector} disappeared while scrolling to it`)
		if (found.covered) console.warn(`${selector} is still covered by another element`)
		if (found.faded) console.warn(`${selector} is still transparent after 5 s; the mark may be early`)
		return { x: found.x, y: found.y, width: found.width, height: found.height }
	}

	/**
	 * Runs `act` while the scene's narration plays and holds until the narration ends.
	 * `act` gets `at(fraction)`, which waits until that share of the narration has passed.
	 */
	async function scene(id, act = async () => {}) {
		const planned = timing.find((entry) => entry.id === id)
		if (!planned && !rehearse) throw new Error(`no narrated scene "${id}" in timing.json`)

		current = { start: now(), cut: 0 }
		const state = current
		const at = async (fraction) => {
			if (rehearse) return
			const left = state.start + state.cut + planned.dur * fraction - now()
			if (left > 0) await sleep(left * 1000)
		}

		if (rehearse) console.log(`scene ${id}${planned ? '' : ' (not narrated yet)'}`)
		await act(at)
		await at(1)
		scenes.push({ id, start: state.start, end: now() })
		current = null
	}

	/**
	 * Keeps a wait out of the video, such as a long job or an assistant thinking: the
	 * frames are dropped and the scene's narration clock pauses until `act` returns.
	 * Waits between scenes are left out on their own.
	 */
	async function cut(act) {
		const start = now()
		driver?.capture(null) // nothing in here is shown, so nothing needs a screenshot
		try {
			await act()
		} finally {
			if (!rehearse) driver?.capture(store)
		}
		const end = now()
		cuts.push({ start, end })
		if (current) current.cut += end - start
	}

	/**
	 * Notes when something happens, and optionally where: `live` reports each mark's time in
	 * the finished video and a ready crop for its element, so nobody hunts through frames.
	 */
	async function mark(name, selector) {
		// Timed once the element is in view and visible, which may take a scroll or a fade-in.
		const found = selector ? await box(selector) : undefined
		marks.push({ name, t: now(), box: found })
	}

	/** Glides the drawn pointer to a point, frame by frame. */
	async function glide(x, y) {
		if (!cursor) return
		const from = (await page.evaluate(() => window.__video?.where())) ?? [960, 640]
		const distance = Math.hypot(x - from[0], y - from[1])
		if (distance < 2) return
		const seconds = clamp(0.3 + distance / 3000, 0.3, 0.7)
		await stepped(seconds, (p) => page.evaluate(([px, py]) => window.__video?.move(px, py), [from[0] + (x - from[0]) * p, from[1] + (y - from[1]) * p]), easeOut)
	}

	/**
	 * Glides the pointer to an element and returns its box and the point it rests on. A hover
	 * (`beside: true`) rests just past the end of a line of text, so the pointer never covers the
	 * words the viewer is reading; a click lands in the middle.
	 */
	async function pointAt(selector, { beside = true } = {}) {
		const found = await box(selector)
		const centre = found.x + found.width / 2
		const y = found.y + found.height / 2
		let x = centre
		if (beside && found.height < 80) x = found.x + found.width + 22 > 1900 ? found.x - 22 : found.x + found.width + 22
		await glide(x, y)
		await page.mouse.move(centre, y) // the real mouse hovers the element itself, so its hover state shows
		await sleep(rehearse ? 0 : 150)
		return { x, y, box: found }
	}

	/** Glides to an element and clicks it, so viewers see where the click happens. */
	async function click(selector) {
		const { x, y, box: found } = await pointAt(selector, { beside: false })
		await page.evaluate(() => window.__video?.press(true))
		marks.push({ name: `click ${selector}`, t: now(), box: found, point: { x, y } })
		await page.mouse.click(x, y)
		// A click that leaves the page takes the pointer with it; the next page draws its own.
		await page.evaluate(() => window.__video?.press(false)).catch(() => {})
		await sleep(rehearse ? 0 : 250)
	}

	/** Clicks a field and types into it at a readable pace. */
	async function type(selector, text, { delay = 45 } = {}) {
		await click(selector)
		// One key at a time on the recording's clock, so the pace holds when frames are slow to capture.
		for (const key of text) {
			await page.keyboard.type(key)
			await sleep(rehearse ? 0 : delay)
		}
	}

	/** Rings an element and dims the rest of the page for `ms`, or until cleared with `ms: 0`. */
	async function highlight(selector, { ms = 1800 } = {}) {
		const found = await box(selector)
		await page.evaluate((b) => window.__video?.ring(b), found)
		if (ms > 0) {
			await sleep(rehearse ? 0 : ms)
			await page.evaluate(() => window.__video?.ring(null))
		}
	}

	/** Shows a caption at the bottom of the page until the next caption; `caption()` clears it. */
	async function caption(text) {
		await page.evaluate((t) => window.__video?.caption(t), text ?? null)
	}

	/** Holds for `ms` of video, which a real-time wait is not while frames are slow to capture. */
	async function pause(ms) {
		await sleep(rehearse ? 0 : ms)
	}

	/** Smoothly scrolls an element to the middle of the screen, captured at 60 fps. */
	async function scrollTo(selector) {
		await box(selector, { center: true })
		await sleep(rehearse ? 0 : 300)
	}

	async function stop() {
		running = false
		await capture
		driver?.capture(null)
		await page.evaluate(() => {
			window.__video?.caption(null)
			window.__video?.ring(null)
		})
		if (rehearse) return { rehearsed: scenes.map((entry) => entry.id) }

		await Promise.all(writes)
		await writeFile(join(partDir, 'recording.json'), JSON.stringify({ frames, scenes, cuts, marks, scale }))
		return { frames: frames.length, scenes: scenes.length, cuts: cuts.length }
	}

	return { scene, cut, mark, pointAt, click, type, highlight, caption, scrollTo, pause, stop }
}
