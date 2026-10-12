// Records an ego-browser Page at 1920x1080 in time with a narrated part, with the
// helpers a product walkthrough needs. Import it inside an `ego-browser nodejs`
// script (see SKILL.md, "Live part"), then run `bun video.ts live <part>.json`.
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// Runs in every document of the recorded tab: a pointer that glides to each click (the
// real one is not in the screencast), a highlight ring and a caption that survives
// same-origin navigation through sessionStorage.
const OVERLAY_SCRIPT = `(() => {
	if (window.__video) return
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
		addEventListener('mousemove', (e) => { dot.style.left = e.clientX + 'px'; dot.style.top = e.clientY + 'px' }, true)
		addEventListener('mousedown', () => { dot.style.transform = 'scale(.7)' }, true)
		addEventListener('mouseup', () => { dot.style.transform = '' }, true)
		window.__video = {
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
	return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
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
	let running = !rehearse
	let pump = Promise.resolve()

	if (!rehearse) {
		await rm(framesDir, { recursive: true, force: true })
		await mkdir(framesDir, { recursive: true })
		await page.events() // drop events buffered before the recording
		await page.cdp('Page.startScreencast', { format: 'jpeg', quality: 85, maxWidth: 1920, maxHeight: 1080 })

		// Chrome sends a frame whenever the page changes and waits for the ack before the next.
		pump = (async () => {
			while (running) {
				for (const event of await page.events()) {
					if (event.method !== 'Page.screencastFrame') continue

					const file = `${String(frames.length).padStart(6, '0')}.jpg`
					frames.push({ file, t: event.params.metadata.timestamp })
					writes.push(writeFile(join(framesDir, file), Buffer.from(event.params.data, 'base64')))
					await page.cdp('Page.screencastFrameAck', { sessionId: event.params.sessionId })
				}
				await sleep(10)
			}
		})()
	}

	/**
	 * Runs `act` while the scene's narration plays and holds until the narration ends.
	 * `act` gets `at(fraction)`, which waits until that share of the narration has passed.
	 */
	async function scene(id, act = async () => {}) {
		const planned = timing.find((entry) => entry.id === id)
		if (!planned && !rehearse) throw new Error(`no narrated scene "${id}" in timing.json`)

		const start = Date.now() / 1000
		const at = async (fraction) => {
			if (rehearse) return
			const left = start + planned.dur * fraction - Date.now() / 1000
			if (left > 0) await sleep(left * 1000)
		}

		if (rehearse) console.log(`scene ${id}${planned ? '' : ' (not narrated yet)'}`)
		await act(at)
		await at(1)
		scenes.push({ id, start, end: Date.now() / 1000 })
	}

	async function box(selector, smooth = false) {
		const found = await page.evaluate(`(${locate})(${JSON.stringify(selector)}, ${smooth})`)
		if (!found) throw new Error(`nothing visible matches ${selector}`)
		return found
	}

	/** Glides the pointer to an element and returns its box. */
	async function pointAt(selector) {
		const found = await box(selector)
		await page.mouse.move(found.x + found.width / 2, found.y + found.height / 2)
		await sleep(rehearse ? 0 : 550)
		return found
	}

	/** Glides to an element and clicks it, so viewers see where the click happens. */
	async function click(selector) {
		const found = await pointAt(selector)
		await page.mouse.click(found.x + found.width / 2, found.y + found.height / 2)
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
		if (rehearse) return { rehearsed: scenes.map((entry) => entry.id) }

		await Promise.all(writes)
		await writeFile(join(partDir, 'recording.json'), JSON.stringify({ frames, scenes }))
		return { frames: frames.length, scenes: scenes.length }
	}

	return { scene, pointAt, click, type, highlight, caption, scrollTo, stop }
}
