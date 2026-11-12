// Reads a composition's layout through time and reports what a viewer would see as a defect,
// without rendering a frame: `video.ts lint` and `stills` inject this after film.js and call
// `Film.lint()`. It steps the film 20 times a second, so a finding carries the times to look at.
;(() => {
	const STEP = 0.05

	/** A short name for an element: its id, or its tag and classes, and the start of its text. */
	const name = (el) => {
		const tag = el.id ? `#${el.id}` : el.tagName.toLowerCase() + [...el.classList].slice(0, 2).map((cls) => `.${cls}`).join('')
		const text = (el.getAttribute('aria-label') ?? el.textContent ?? '').trim().replace(/\s+/g, ' ')
		return text ? `${tag} "${text.length > 28 ? `${text.slice(0, 27)}…` : text}"` : tag
	}

	/** Consecutive sample times as `from-to` ranges at least `min` seconds long. */
	const spans = (times, min) => {
		const out = []
		for (const t of times) {
			const last = out.at(-1)
			if (last && t - last[1] < STEP * 1.5) last[1] = t
			else out.push([t, t])
		}
		return out.map(([from, to]) => [from, to + STEP]).filter(([from, to]) => to - from >= min - 1e-6)
	}
	const range = ([from, to]) => `${from.toFixed(2)}-${to.toFixed(2)}s`
	const ranges = (times, min) => spans(times, min).map(range).join(', ')

	/** Everything about one element at the current film time that the checks read. */
	const look = (el, frame, cache) => {
		if (cache.has(el)) return cache.get(el)
		const style = getComputedStyle(el)
		const above = el.parentElement && el.parentElement !== document.documentElement ? look(el.parentElement, frame, cache) : null
		const rect = el.getBoundingClientRect()
		let box = { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom }
		// What an ancestor clips (a line mask, a window with overflow hidden) the viewer never sees.
		if (above?.clip) box = { left: Math.max(box.left, above.clip.left), top: Math.max(box.top, above.clip.top), right: Math.min(box.right, above.clip.right), bottom: Math.min(box.bottom, above.clip.bottom) }
		const clips = /hidden|clip|scroll|auto/.test(style.overflowX + style.overflowY)
		const blur = Number(style.filter.match(/blur\(([\d.]+)px\)/)?.[1] ?? 0)
		const seen = {
			rect,
			box,
			clip: clips ? box : above?.clip,
			opacity: (above?.opacity ?? 1) * Number(style.opacity),
			blur: Math.max(blur, above?.blur ?? 0),
			hidden: style.visibility === 'hidden' || style.display === 'none' || Boolean(above?.hidden && style.visibility !== 'visible'),
			size: Number.parseFloat(style.fontSize) * (el.offsetHeight ? rect.height / el.offsetHeight : 1),
			style
		}
		seen.inFrame = { left: Math.max(seen.box.left, 0), top: Math.max(seen.box.top, 0), right: Math.min(seen.box.right, frame.width), bottom: Math.min(seen.box.bottom, frame.height) }
		seen.area = Math.max(0, seen.inFrame.right - seen.inFrame.left) * Math.max(0, seen.inFrame.bottom - seen.inFrame.top)
		seen.visible = !seen.hidden && seen.opacity > 0.05 && seen.area > 4
		cache.set(el, seen)
		return seen
	}

	/** True when an opaque element that is not part of `block` is painted over the point. */
	const covered = (block, x, y) => {
		const top = document.elementFromPoint(x, y)
		if (!top || block.contains(top) || top.contains(block)) return false
		for (let el = top; el && !el.contains(block); el = el.parentElement) {
			const style = getComputedStyle(el)
			const alpha = Number(style.backgroundColor.match(/rgba?\([^)]*?(?:,\s*([\d.]+))?\)$/)?.[1] ?? 1)
			const painted = style.backgroundColor !== 'rgba(0, 0, 0, 0)' && alpha > 0.85
			if ((painted || style.backgroundImage !== 'none') && Number(style.opacity) >= 0.5) return true
		}
		return false
	}

	/**
	 * `Film.lint()`: the findings, one line each. `data-lint="ui"` on a built product mock keeps
	 * its small interface text out of the type-size check.
	 */
	window.Film.lint = async () => {
		const film = window.film
		const frame = { width: innerWidth, height: innerHeight }
		const floor = (28 * Math.min(frame.width, frame.height)) / 1080
		const findings = []

		// Text is anything with words of its own; SplitText pieces report as the block they came from.
		const blockOf = (el) => (el.getAttribute('aria-hidden') === 'true' && el.closest('[aria-label]')) || el
		const media = [...document.querySelectorAll('img, video, svg, canvas')]
		const all = [...document.body.querySelectorAll('*')].filter((el) => !['SCRIPT', 'STYLE'].includes(el.tagName))
		const hasText = (el) => [...el.childNodes].some((node) => node.nodeType === 3 && node.textContent.trim())

		const blank = []
		const still = []
		const crossing = new Map()
		const small = new Map()
		const cutOff = new Map()
		const shown = new Map()
		let before = ''

		for (let t = 0; t <= film.duration + 1e-6; t += STEP) {
			await film.seek(t, { clips: false })
			const cache = new Map()
			const texts = []
			let print = ''
			for (const el of all) {
				const seen = look(el, frame, cache)
				if (!seen.visible) continue
				print += `${Math.round(seen.rect.left * 2)},${Math.round(seen.rect.top * 2)},${Math.round(seen.rect.width * 2)},${Math.round(seen.rect.height * 2)},${seen.opacity.toFixed(2)},${seen.blur.toFixed(1)};`
				if (hasText(el)) {
					texts.push({ el, block: blockOf(el), seen })
					print += el.textContent
				}
			}
			// A clip that is playing changes the frame, whatever the layout does.
			for (const video of document.querySelectorAll('video[data-start]')) {
				const { start, from = 0, rate = 1, until = Infinity } = video.dataset
				const clipTime = Math.min((t - Number(start)) * Number(rate) + Number(from), Number(until), video.duration || Infinity)
				if (look(video, frame, cache).visible) print += `clip${Math.max(clipTime, 0).toFixed(2)};`
			}
			if (print === before) still.push(t)
			before = print

			const readable = texts.filter(({ seen }) => seen.opacity >= 0.5 && seen.blur < 3)
			const pictures = media.filter((el) => look(el, frame, cache).visible && look(el, frame, cache).area > frame.width * frame.height * 0.005)
			if (texts.length === 0 && pictures.length === 0) blank.push(t)

			const note = (map, key, text) => {
				if (!map.has(key)) map.set(key, { text, times: [] })
				map.get(key).times.push(t)
			}
			const blocks = new Map()
			for (const item of readable) {
				const ui = item.el.closest('[data-lint~="ui"]')
				if (!blocks.has(item.block)) blocks.set(item.block, [])
				blocks.get(item.block).push(item)
				note(shown, item.block, name(item.block))
				if (!ui && item.seen.size < floor - 0.5) note(small, item.block, `${name(item.block)} at ${Math.round(item.seen.size)} px`)
				const { box } = item.seen
				const outside = box.left < -4 || box.top < -4 || box.right > frame.width + 4 || box.bottom > frame.height + 4
				if (!ui && outside) note(cutOff, item.block, name(item.block))
			}
			// Two blocks of readable text on the same pixels, neither painted over by something opaque.
			const entries = [...blocks.entries()]
			for (let a = 0; a < entries.length; a++) {
				for (let b = a + 1; b < entries.length; b++) {
					const [blockA, itemsA] = entries[a]
					const [blockB, itemsB] = entries[b]
					if (blockA.contains(blockB) || blockB.contains(blockA)) continue
					const hit = itemsA.some((one) =>
						itemsB.some((two) => {
							const p = one.seen.inFrame
							const q = two.seen.inFrame
							const width = Math.min(p.right, q.right) - Math.max(p.left, q.left)
							const height = Math.min(p.bottom, q.bottom) - Math.max(p.top, q.top)
							if (width <= 2 || height <= 2) return false
							if (width * height < 0.15 * Math.min(one.seen.area, two.seen.area)) return false
							const x = Math.max(p.left, q.left) + width / 2
							const y = Math.max(p.top, q.top) + height / 2
							return !covered(blockA, x, y) && !covered(blockB, x, y)
						})
					)
					if (hit) note(crossing, `${name(blockA)}|${name(blockB)}`, `${name(blockA)} and ${name(blockB)}`)
				}
			}
		}
		await film.seek(0)

		const blankSpans = spans(blank, 0.1)
		if (blank[0] === 0 && !blankSpans.some(([from]) => from === 0)) blankSpans.unshift([0, STEP])
		for (const span of blankSpans) findings.push(`empty frame ${range(span)}: no text or imagery on screen`)
		for (const { text, times } of crossing.values()) {
			const when = ranges(times, 0.1)
			if (when) findings.push(`text crosses text ${when}: ${text}`)
		}
		for (const { text, times } of cutOff.values()) {
			const when = ranges(times, 0.15)
			if (when) findings.push(`text cut off at the frame edge ${when}: ${text}`)
		}
		const tiny = [...small.values()].map((entry) => ({ ...entry, when: ranges(entry.times, 0.5) })).filter((entry) => entry.when)
		for (const { text, when } of tiny.slice(0, 3)) findings.push(`text under ${Math.round(floor)} px ${when}: ${text}`)
		if (tiny.length > 3) findings.push(`text under ${Math.round(floor)} px: ${tiny.length - 3} more elements (mark a built product mock with data-lint="ui")`)
		for (const [block, { text, times }] of shown) {
			const total = times.length * STEP
			if (total < 0.4 && (block.textContent ?? '').trim().length > 3) findings.push(`text on screen for only ${total.toFixed(2)}s at ${times[0].toFixed(2)}s: ${text}`)
		}
		for (const span of spans(still, 0.6)) {
			const end = span[1] >= film.duration - STEP
			findings.push(`nothing moves ${range(span)}${end ? ' (the end card may hold; give it a drift)' : ''}`)
		}

		// Two tweens on one property of one element at the same time cancel each other.
		const SETTINGS = new Set(['duration', 'ease', 'delay', 'stagger', 'onUpdate', 'onComplete', 'onStart', 'immediateRender', 'overwrite', 'repeat', 'yoyo', 'repeatDelay', 'startAt', 'id', 'data', 'lazy', 'paused', 'runBackwards', 'transformOrigin', 'parent', 'callbackScope', 'keyframes'])
		const alias = { autoAlpha: 'opacity', scaleX: 'scale', scaleY: 'scale' }
		const driven = new Map()
		for (const tween of film.tl.getChildren(true, true, false)) {
			if (tween.duration() < 0.02) continue
			let start = tween.startTime()
			for (let parent = tween.parent; parent && parent !== film.tl; parent = parent.parent) start = parent.startTime() + start / parent.timeScale()
			const end = start + tween.totalDuration()
			for (const target of tween.targets()) {
				if (!(target instanceof Element)) continue
				for (const key of Object.keys(tween.vars)) {
					if (SETTINGS.has(key)) continue
					const prop = alias[key] ?? key
					if (!driven.has(target)) driven.set(target, new Map())
					const runs = driven.get(target)
					if (!runs.has(prop)) runs.set(prop, [])
					runs.get(prop).push([start, end])
				}
			}
		}
		const clashes = new Set()
		for (const [target, runs] of driven) {
			for (const [prop, list] of runs) {
				list.sort((a, b) => a[0] - b[0])
				for (let i = 1; i < list.length; i++) {
					const overlap = Math.min(list[i - 1][1], list[i][1]) - list[i][0]
					if (overlap > 0.02) clashes.add(`two tweens drive ${prop} of ${name(target)} at once ${list[i][0].toFixed(2)}-${(list[i][0] + overlap).toFixed(2)}s: one cancels the other`)
				}
			}
		}
		findings.push(...[...clashes].slice(0, 8))

		// A large blur is redrawn on every frame, in software on a server.
		for (const el of all) {
			const style = getComputedStyle(el)
			const blur = Number(style.filter.match(/blur\(([\d.]+)px\)/)?.[1] ?? 0)
			const backdrop = style.backdropFilter && style.backdropFilter !== 'none'
			const share = (el.offsetWidth * el.offsetHeight) / (frame.width * frame.height)
			if ((blur >= 40 || backdrop) && share > 0.08 && !film.tl.getTweensOf(el).some((tween) => 'filter' in tween.vars)) {
				findings.push(`slow to render: ${name(el)} has ${backdrop ? 'a backdrop-filter' : `blur(${blur}px)`} over ${Math.round(share * 100)}% of the frame; a radial-gradient gives the same soft field at no cost`)
			}
		}

		for (const cue of film.cues) if (cue.t > film.duration) findings.push(`cue ${cue.sound} at ${cue.t}s is after the film ends (${film.duration.toFixed(2)}s)`)
		return findings
	}
})()
