// Records an ego-browser Page at 1920x1080 in time with a narrated part, with the
// helpers a product walkthrough needs. Import it inside an `ego-browser nodejs`
// script (see SKILL.md, "Live part"), then run `bun video.ts live <part>.json`.
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const now = () => Date.now() / 1000

// Runs in the top document of the recorded tab: a pointer that glides to each target
// (the real one is not in the screencast), a highlight ring and a caption that
// survives same-origin navigation through sessionStorage. Only the helpers move the
// pointer: mouse events stop at an iframe's edge, so following them would strand it there.
const OVERLAY_SCRIPT = `(() => {
	if (window.top !== window || window.__video) return
	const style = 'position:fixed;z-index:2147483647;pointer-events:none;'
	const ease = 'cubic-bezier(.2,.8,.2,1)'
	const make = (css) => {
		const el = document.createElement('div')
		el.style.cssText = style + css
		document.documentElement.appendChild(el)
		return el
	}
	const mount = () => {
		const dot = make('left:-40px;top:-40px;width:26px;height:26px;margin:-13px 0 0 -13px;border-radius:50%;background:rgba(20,20,20,.35);border:2px solid #fff;box-shadow:0 2px 10px rgba(0,0,0,.35);transition:left .45s ' + ease + ',top .45s ' + ease + ',transform .15s')
		const ring = make('border:3px solid #ffb020;border-radius:14px;box-shadow:0 0 0 9999px rgba(0,0,0,.28);opacity:0;transition:opacity .3s,left .3s,top .3s,width .3s,height .3s')
		const caption = make('left:50%;bottom:48px;transform:translateX(-50%);max-width:1400px;padding:16px 28px;border-radius:16px;background:rgba(15,17,21,.88);color:#fff;font:600 28px/1.3 -apple-system,Helvetica,Arial,sans-serif;box-shadow:0 10px 40px rgba(0,0,0,.35);opacity:0;transition:opacity .3s')
		const move = (x, y) => { dot.style.left = x + 'px'; dot.style.top = y + 'px' }
		window.__video = {
			move,
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
		window.__video.caption(sessionStorage.getItem('__videoCaption'))
	}
	document.documentElement ? mount() : addEventListener('DOMContentLoaded', mount)
})()`

/**
 * Finds the element for a CSS selector, or for `text=Save as test` the smallest visible
 * element whose text is exactly that, scrolls it into view and returns its box.
 * Serialized into each document it searches, so it must stay self-contained.
 */
function locate(selector, smooth) {
	const visible = (el) => {
		const rect = el.getBoundingClientRect()
		return rect.width > 0 && rect.height > 0 && getComputedStyle(el).visibility !== 'hidden'
	}

	let el
	if (selector.startsWith('text=')) {
		const wanted = selector.slice(5).trim().toLowerCase()
		const matches = [...document.querySelectorAll('body *')].filter(
			(node) => visible(node) && node.textContent?.trim().toLowerCase() === wanted
		)
		el = matches.find((node) => !matches.some((other) => other !== node && node.contains(other)))
	} else {
		el = [...document.querySelectorAll(selector)].find(visible)
	}
	if (!el) return null

	el.scrollIntoView(smooth ? { behavior: 'smooth', block: 'center' } : { block: 'nearest', inline: 'nearest' })
	const rect = el.getBoundingClientRect()
	// A loading overlay or a dialog can sit over an element the DOM reports as visible.
	const top = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
	const covered = Boolean(top) && !el.contains(top) && !top.contains(el)
	return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, covered }
}

/**
 * `rehearse: true` runs the same walkthrough without recording or waiting for the
 * narration, to check selectors and flow quickly before a take.
 */
export async function record(page, partDir, { cursor = true, rehearse = false } = {}) {
	const timingFile = join(partDir, 'timing.json')
	const timing = existsSync(timingFile) ? JSON.parse(await readFile(timingFile, 'utf8')) : []
	if (!rehearse && timing.length === 0) throw new Error(`${timingFile} is missing: run narrate first`)

	await page.cdp('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false })
	if (cursor) {
		await page.cdp('Page.addScriptToEvaluateOnNewDocument', { source: OVERLAY_SCRIPT })
		await page.evaluate(OVERLAY_SCRIPT)
	}

	const framesDir = join(partDir, 'frames')
	const frames = []
	const writes = []
	const scenes = []
	const cuts = []
	const marks = []
	const replies = new Map()
	let current = null
	let running = true

	if (!rehearse) {
		await rm(framesDir, { recursive: true, force: true })
		await mkdir(framesDir, { recursive: true })
	}
	await page.events() // drop events buffered before the recording
	if (!rehearse) {
		await page.cdp('Page.startScreencast', { format: 'jpeg', quality: 85, maxWidth: 1920, maxHeight: 1080 })
	}

	// One reader for every CDP event: screencast frames (Chrome sends one whenever the page
	// changes and waits for the ack) and replies from embedded frames.
	const pump = (async () => {
		while (running) {
			for (const event of await page.events()) {
				if (event.method === 'Page.screencastFrame') {
					const file = `${String(frames.length).padStart(6, '0')}.jpg`
					frames.push({ file, t: event.params.metadata.timestamp })
					writes.push(writeFile(join(framesDir, file), Buffer.from(event.params.data, 'base64')))
					await page.cdp('Page.screencastFrameAck', { sessionId: event.params.sessionId })
				} else if (event.method === 'Target.receivedMessageFromTarget') {
					const message = JSON.parse(event.params.message)
					const key = `${event.params.sessionId}:${message.id}`
					replies.get(key)?.(message)
					replies.delete(key)
				}
			}
			await sleep(10)
		}
	})()

	// Embedded apps (a Shopify app inside the admin, say) live in cross-origin iframes the
	// page session cannot evaluate in, so each gets its own session, reached through the page.
	const frameSessions = new Map()
	let messageId = 0

	async function evaluateInFrame(targetId, expression) {
		let sessionId = frameSessions.get(targetId)
		if (!sessionId) {
			;({ sessionId } = await page.cdp('Target.attachToTarget', { targetId, flatten: false }))
			frameSessions.set(targetId, sessionId)
		}

		const id = ++messageId
		const reply = new Promise((resolve) => replies.set(`${sessionId}:${id}`, resolve))
		const message = { id, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }
		await page.cdp('Target.sendMessageToTarget', { sessionId, message: JSON.stringify(message) })

		const answer = await Promise.race([reply, sleep(5000).then(() => null)])
		if (!answer || answer.error) {
			frameSessions.delete(targetId)
			return null
		}
		return answer.result.result.value
	}

	/** Where an iframe's content starts, in top-level viewport pixels. */
	async function frameOrigin(targetId) {
		const { backendNodeId } = await page.cdp('DOM.getFrameOwner', { frameId: targetId })
		const { object } = await page.cdp('DOM.resolveNode', { backendNodeId })
		const { result } = await page.cdp('Runtime.callFunctionOn', {
			objectId: object.objectId,
			functionDeclaration: 'function () { const r = this.getBoundingClientRect(); return { x: r.x + this.clientLeft, y: r.y + this.clientTop } }',
			returnByValue: true
		})
		return result.value
	}

	/** The element's box in top-level viewport pixels, searching the page, then its iframes. */
	async function box(selector, smooth = false) {
		const expression = `(${locate})(${JSON.stringify(selector)}, ${smooth})`
		let inPage = await page.evaluate(expression)
		// Wait out an overlay, so a click lands and a mark measures what the viewer sees.
		for (let tries = 0; inPage?.covered && tries < 50; tries++) {
			await sleep(100)
			inPage = await page.evaluate(expression)
		}
		if (inPage?.covered) console.warn(`${selector} is still covered by another element`)
		if (inPage) return inPage

		// ponytail: direct child iframes only; recurse through parentId if an app nests frames.
		const { targetInfos } = await page.cdp('Target.getTargets')
		const childFrames = targetInfos.filter((target) => target.type === 'iframe' && target.parentId === page.targetId)
		const inFrameExpression = `(${locate})(${JSON.stringify(selector)}, false)`
		for (const frame of childFrames) {
			const inFrame = await evaluateInFrame(frame.targetId, inFrameExpression)
			if (!inFrame) continue

			// Scrolling inside the frame does not move the page around it, so bring the element on screen.
			let origin = await frameOrigin(frame.targetId)
			const middle = origin.y + inFrame.y + inFrame.height / 2
			const offscreen = origin.y + inFrame.y < 0 || origin.y + inFrame.y + inFrame.height > 1080
			if (smooth || offscreen) {
				await page.evaluate(([top, isSmooth]) => scrollBy({ top, behavior: isSmooth ? 'smooth' : 'instant' }), [middle - 540, smooth])
				origin = await frameOrigin(frame.targetId)
			}
			return { ...inFrame, x: inFrame.x + origin.x, y: inFrame.y + origin.y }
		}

		throw new Error(`nothing visible matches ${selector}`)
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
		await act()
		const end = now()
		cuts.push({ start, end })
		if (current) current.cut += end - start
	}

	/**
	 * Notes when something happens, and optionally where: `live` reports each mark's time in
	 * the finished video and a ready crop for its element, so nobody hunts through frames.
	 */
	async function mark(name, selector) {
		const t = now()
		const found = selector ? await box(selector) : undefined
		marks.push({ name, t, box: found && { x: found.x, y: found.y, width: found.width, height: found.height } })
	}

	/** Glides the pointer to an element and returns its box. */
	async function pointAt(selector) {
		const found = await box(selector)
		const x = found.x + found.width / 2
		const y = found.y + found.height / 2
		await page.evaluate(([px, py]) => window.__video?.move(px, py), [x, y])
		await page.mouse.move(x, y)
		await sleep(rehearse ? 0 : 550)
		return { x, y }
	}

	/** Glides to an element and clicks it, so viewers see where the click happens. */
	async function click(selector) {
		const { x, y } = await pointAt(selector)
		await page.evaluate(() => window.__video?.press(true))
		marks.push({ name: `click ${selector}`, t: now() })
		await page.mouse.click(x, y)
		await page.evaluate(() => window.__video?.press(false))
		await sleep(rehearse ? 0 : 250)
	}

	/** Clicks a field and types into it at a readable pace. */
	async function type(selector, text, { delay = 45 } = {}) {
		await click(selector)
		await page.keyboard.type(text, { delay: rehearse ? 0 : delay })
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

	/** Smoothly scrolls an element to the middle of the screen. */
	async function scrollTo(selector) {
		await box(selector, true)
		await sleep(rehearse ? 0 : 900)
	}

	async function stop() {
		running = false
		await pump
		if (!rehearse) await page.cdp('Page.stopScreencast')
		await page.evaluate(() => {
			window.__video?.caption(null)
			window.__video?.ring(null)
		})
		await page.cdp('Emulation.clearDeviceMetricsOverride')
		for (const sessionId of frameSessions.values()) {
			await page.cdp('Target.detachFromTarget', { sessionId }).catch(() => {})
		}
		if (rehearse) return { rehearsed: scenes.map((entry) => entry.id) }

		await Promise.all(writes)
		await writeFile(join(partDir, 'recording.json'), JSON.stringify({ frames, scenes, cuts, marks }))
		return { frames: frames.length, scenes: scenes.length, cuts: cuts.length }
	}

	return { scene, cut, mark, pointAt, click, type, highlight, caption, scrollTo, stop }
}
