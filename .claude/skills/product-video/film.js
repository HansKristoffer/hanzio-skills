// Deterministic film runtime for product-video compositions. The renderer injects GSAP,
// SplitText, CustomEase and this file, then calls `film.seek(t)` for every frame, so every
// visual state must be a pure function of time: put all motion on `film.tl`, never use
// setTimeout, requestAnimationFrame, Date.now() or unseeded randomness.
;(() => {
	const { gsap, SplitText, CustomEase } = window
	gsap.registerPlugin(SplitText, CustomEase)

	// Launch-film easing: arrive fast and settle long so the landing reads; leave accelerating.
	CustomEase.create('land', 'M0,0 C0.12,0.9 0.25,1 1,1')
	CustomEase.create('leave', 'M0,0 C0.6,0 0.9,0.35 1,1')
	CustomEase.create('swap', 'M0,0 C0.7,0 0.2,1 1,1')

	// Seeks a clip and waits until that frame is on screen. The target sits 1 ms inside the
	// frame: a time exactly on a frame boundary rounds either way, which shows one frame twice
	// and skips the next, so a smooth scroll in the clip would strobe in the film.
	const seekVideo = (video, time) =>
		new Promise((resolve) => {
			// A hidden clip is not seeked: it presents no frame, so the wait would only time out.
			if (video.checkVisibility?.({ opacityProperty: true, visibilityProperty: true }) === false) return resolve()
			const target = Math.min(Math.max(time, 0) + 0.001, Math.max((video.duration || 0) - 0.001, 0))
			if (Math.abs(video.currentTime - target) < 0.0005) return resolve()
			const presented = () => {
				if (!video.requestVideoFrameCallback) return resolve()
				video.requestVideoFrameCallback(() => resolve())
				setTimeout(resolve, 60) // a frame already on screen (a 30 fps clip in a 60 fps film) fires none
			}
			video.addEventListener('seeked', presented, { once: true })
			video.currentTime = target
		})

	const Film = {
		/**
		 * Starts the film. `duration` in seconds; a narrated film can leave it out and use
		 * `Film.scenes()`. `music` is a path relative to the HTML file, `musicGain` in dB.
		 * Build the timeline inside `build(film)`; it runs after fonts and images load.
		 */
		create({ duration, music, musicGain = -6, narrationGain = 0, build }) {
			const tl = gsap.timeline({ paused: true })
			const film = {
				tl,
				cues: [],
				audio: { music, musicGain, narrationGain, dips: [] },
				duration: duration ?? Film.scenes().total,
				ready: false,
				/** A sound effect at time `t`: a file name in `sfx/` without extension, gain in dB. */
				cue(t, sound, gain = 0) {
					film.cues.push({ t, sound, gain })
				},
				/**
				 * Pulls the music down by `gain` dB between `from` and `to`: a dead stop before a
				 * big hit, or a breath under a key line. A flat wall of music reads as stock.
				 */
				dip(from, to, gain = -24) {
					film.audio.dips.push({ from, to, gain })
				},
				async seek(t) {
					// A hair past the requested time, so a set placed exactly there (or at 0) applies.
					tl.time(Math.min(t, film.duration) + 1e-6, false)
					// Stray CSS animations follow the same clock; prefer GSAP for anything that matters.
					for (const animation of document.getAnimations()) {
						animation.pause()
						animation.currentTime = t * 1000
					}
					// <video data-start="3.2" data-from="1.5" data-rate="2" data-until="9">: starts at
					// 3.2 s on the film clock, playing the clip from 1.5 s in at double speed, and
					// holds its 9 s frame from then on (a beat that ends on its payoff).
					const videos = [...document.querySelectorAll('video[data-start]')]
					await Promise.all(
						videos.map((video) => {
							const { start, from = 0, rate = 1, until = Infinity } = video.dataset
							const clipTime = (t - Number(start)) * Number(rate) + Number(from)
							return seekVideo(video, Math.min(clipTime, Number(until)))
						})
					)
				}
			}
			window.film = film

			const images = [...document.images].map((image) => image.decode().catch(() => {}))
			const videos = [...document.querySelectorAll('video')].map(
				(video) =>
					new Promise((resolve) => {
						video.muted = true
						video.pause()
						if (video.readyState >= 2) resolve()
						else video.addEventListener('loadeddata', resolve, { once: true })
					})
			)
			Promise.all([document.fonts.ready, ...images, ...videos]).then(async () => {
				await build?.(film)
				film.duration = duration ?? Math.max(Film.scenes().total, tl.duration())
				await film.seek(0)
				film.ready = true
			})
			return film
		},

		/** Narrated scenes from `<part>.json`: `{ total, <id>: { start, dur, end } }`. */
		scenes() {
			const result = { total: 0 }
			for (const scene of window.TIMING ?? []) {
				result[scene.id] = { start: result.total, dur: scene.dur, end: result.total + scene.dur }
				result.total += scene.dur
			}
			return result
		},

		/**
		 * The film time at which a `<video data-start data-from data-rate>` reaches `clipTime`,
		 * so captions and cues follow the clip's marks (`live` prints them) instead of guesses.
		 */
		clipAt(video, clipTime) {
			const el = typeof video === 'string' ? document.querySelector(video) : video
			const { start, from = 0, rate = 1 } = el.dataset
			return Number(start) + (clipTime - Number(from)) / Number(rate)
		},

		/** Shows `el` from `from` to `to` with a hard cut, so scenes can share one stage. */
		show(tl, el, from, to) {
			tl.set(el, { autoAlpha: 0 }, 0)
			tl.set(el, { autoAlpha: 1 }, from)
			if (to !== undefined) tl.set(el, { autoAlpha: 0 }, to)
		},

		/**
		 * Splits text for staggering; `mask` keeps each line clipped so words rise into view.
		 * Gradient text (`background-clip: text`) does not paint through transformed children,
		 * so each piece inside it gets the gradient itself.
		 */
		split(el, type = 'words') {
			const split = SplitText.create(el, { type: `lines,${type}`, mask: 'lines' })
			// A mask the height of the line box clips descenders (y, g, p) in a tight line-height;
			// extend it below the baseline without moving the layout.
			for (const mask of split.masks ?? []) Object.assign(mask.style, { paddingBottom: '0.22em', marginBottom: '-0.22em' })
			const repainted = new Set()
			for (const piece of [...split.words, ...split.chars]) {
				const painted = piece.parentElement?.closest('[style*="background-clip"], .gradient-text')
				if (!painted || painted === piece) continue
				const style = getComputedStyle(painted)
				Object.assign(piece.style, {
					backgroundImage: style.backgroundImage,
					backgroundSize: `${painted.offsetWidth}px 100%`,
					backgroundPosition: `${painted.getBoundingClientRect().left - piece.getBoundingClientRect().left}px 0`,
					webkitBackgroundClip: 'text',
					backgroundClip: 'text',
					color: 'transparent'
				})
				repainted.add(painted)
			}
			// Otherwise the container paints the gradient a second time, offset once it moves.
			for (const painted of repainted) painted.style.backgroundImage = 'none'
			return split
		},

		/**
		 * Kinetic headline: words rise through a mask with a stagger, and leave upward at `out`.
		 * Returns the words; `words.gone` is the film time the last word has left. A single word
		 * swapping in place may start the next at `gone - 0.05` (a slot roll, no empty frame);
		 * a title of several words or lines starts the next at `gone`, or the two splice.
		 */
		headline(tl, el, at, { out, stagger = 0.06, outDur = 0.35 } = {}) {
			const { words } = Film.split(el)
			// The entry must finish before the exit starts: two tweens on one property cancel.
			const room = out === undefined ? 0.7 : out - at - stagger * (words.length - 1)
			tl.from(words, { yPercent: 115, duration: Math.max(0.12, Math.min(0.7, room)), ease: 'land', stagger }, at)
			if (out !== undefined) {
				const ease = outDur < 0.25 ? 'power2.in' : 'leave'
				tl.to(words, { yPercent: -115, duration: outDur, ease, stagger: stagger / 2 }, out)
				words.gone = out + outDur + (stagger / 2) * (words.length - 1)
			}
			return words
		},

		/** Supporting elements arrive: lift, sharpen and fade in with a stagger. */
		rise(tl, els, at, { stagger = 0.08, y = 40, blur = 10 } = {}) {
			tl.from(els, { y, autoAlpha: 0, filter: `blur(${blur}px)`, duration: 0.8, ease: 'land', stagger }, at)
		},

		/** Elements leave accelerating, so the next composition can arrive. */
		leave(tl, els, at, { y = -30, blur = 8 } = {}) {
			tl.to(els, { y, autoAlpha: 0, filter: `blur(${blur}px)`, duration: 0.35, ease: 'leave' }, at)
		},

		/**
		 * Foreground fly-through: `el` scales toward the camera, blurs and fades, revealing what
		 * is underneath. Use it for a logo, a mark or a short word; a full-width headline clips at
		 * the frame edges, so lift it out with `Film.leave` instead.
		 */
		flyThrough(tl, el, at, { dur = 0.55, scale = 3 } = {}) {
			tl.to(el, { scale, autoAlpha: 0, filter: 'blur(14px)', duration: dur, ease: 'leave' }, at)
		},

		/**
		 * A slow push so a held graphic (type, a number, an end card) never freezes. Never on
		 * product footage, a screenshot or a camera that focuses: they hold still between moves.
		 */
		drift(tl, el, from, to, { scale = 1.04, x, y } = {}) {
			// Only the properties asked for, so an exit tween on x or y can share the element.
			const start = { scale: 1, ...(x === undefined ? {} : { x: 0 }), ...(y === undefined ? {} : { y: 0 }) }
			const end = { scale, ...(x === undefined ? {} : { x }), ...(y === undefined ? {} : { y }) }
			tl.fromTo(el, start, { ...end, duration: to - from, ease: 'none' }, from)
		},

		/** A product surface swings in from a 3D tilt and lands flat; give its parent a perspective. */
		tilt(tl, el, at, { rotateX = 24, rotateY = -14, y = 120, dur = 1.2 } = {}) {
			tl.from(el, { rotateX, rotateY, y, scale: 0.86, autoAlpha: 0, duration: dur, ease: 'land' }, at)
		},

		/**
		 * Moves the camera onto a region and holds it there, still, until the next move. `camera` is
		 * a positioned wrapper that nothing else transforms (no drift on it or inside it): it scales
		 * and pans so the region sits in the middle of its parent's frame. `target` is an element
		 * inside the camera, or `[video, mark]`: the name of a mark in the clip's marks (a click
		 * centres on the pointer, framed to its element) or a box `{ x, y, width, height }` in the
		 * clip's pixels. The region fills `fill` of the frame, or `scale` sets the zoom. The camera
		 * stops at the clip's edges (or its own), so the region may sit off-centre near an edge, and
		 * never enlarges a clip past its recorded pixels: it caps the zoom there and warns.
		 * `Film.focus(tl, camera, null, at)` zooms back out; focus again to pan to the next action.
		 * Returns the region's box in the frame once the move ends, to place a callout beside it.
		 */
		focus(tl, camera, target, at, { fill = 0.6, scale, dur = 1, ease = 'swap' } = {}) {
			if (!target) {
				tl.to(camera, { transformOrigin: '0 0', scale: 1, x: 0, y: 0, duration: dur, ease }, at)
				return
			}
			const frame = camera.offsetParent
			// Layout offsets, not rendered boxes, so tweens already on the timeline do not skew them.
			const offset = (el) => {
				let x = 0
				let y = 0
				for (let node = el; node && node !== camera; node = node.offsetParent) {
					x += node.offsetLeft
					y += node.offsetTop
				}
				return { x, y }
			}

			let region
			let bounds = { x: 0, y: 0, width: camera.offsetWidth, height: camera.offsetHeight }
			let limit = Number.POSITIVE_INFINITY
			let source
			if (Array.isArray(target)) {
				const media = typeof target[0] === 'string' ? document.querySelector(target[0]) : target[0]
				const shown = Film.contentBox(media)
				const origin = offset(media)
				const box = typeof target[1] === 'string' ? Film.clipMark(media, target[1]).region : target[1]
				if (!box) throw new Error(`mark "${target[1]}" has no element to frame: give rec.mark a selector`)
				region = { x: origin.x + shown.x + box.x * shown.ratio, y: origin.y + shown.y + box.y * shown.ratio, width: box.width * shown.ratio, height: box.height * shown.ratio }
				// Inset by 2 px, so a border or shadow just outside the clip never shows at the frame's edge.
				bounds = { x: origin.x + Math.max(0, shown.x) + 2, y: origin.y + Math.max(0, shown.y) + 2, width: Math.min(media.offsetWidth, shown.width) - 4, height: Math.min(media.offsetHeight, shown.height) - 4 }
				limit = 1 / shown.ratio
				source = media.getAttribute('src')
			} else {
				region = { ...offset(target), width: target.offsetWidth, height: target.offsetHeight }
			}

			let zoom = scale ?? Math.min((frame.clientWidth * fill) / region.width, (frame.clientHeight * fill) / region.height)
			if (zoom > limit + 0.01) {
				console.warn(`Film.focus at ${at.toFixed(2)}s: ${source} turns soft past ${limit.toFixed(2)}x and was asked for ${zoom.toFixed(2)}x; capped. Record it with 'walk --scale 3' or zoom less.`)
				zoom = limit
			}

			// Centre the region, then keep the bounds covering the frame (or inside it, when smaller).
			const place = (size, origin, start, length, centre) => {
				const wanted = size / 2 - origin - centre * zoom
				const a = size - origin - (start + length) * zoom
				const b = -origin - start * zoom
				return Math.min(Math.max(a, b), Math.max(Math.min(a, b), wanted))
			}
			const x = place(frame.clientWidth, camera.offsetLeft, bounds.x, bounds.width, region.x + region.width / 2)
			const y = place(frame.clientHeight, camera.offsetTop, bounds.y, bounds.height, region.y + region.height / 2)
			tl.to(camera, { transformOrigin: '0 0', scale: zoom, x, y, duration: dur, ease }, at)
			// Where the region lands in the frame once the move ends: put a callout beside it.
			return {
				x: camera.offsetLeft + x + region.x * zoom,
				y: camera.offsetTop + y + region.y * zoom,
				width: region.width * zoom,
				height: region.height * zoom
			}
		},

		/**
		 * Where a `<video>` or `<img>` draws its picture inside its own box, honouring object-fit:
		 * `{ x, y, width, height }` in CSS pixels and `ratio`, CSS pixels per source pixel.
		 */
		contentBox(media) {
			const sourceWidth = media.videoWidth || media.naturalWidth
			const sourceHeight = media.videoHeight || media.naturalHeight
			const fit = getComputedStyle(media).objectFit
			const across = media.offsetWidth / sourceWidth
			const down = media.offsetHeight / sourceHeight
			const ratio = fit === 'cover' ? Math.max(across, down) : fit === 'fill' ? across : Math.min(across, down)
			const width = sourceWidth * ratio
			const height = sourceHeight * ratio
			return { x: (media.offsetWidth - width) / 2, y: (media.offsetHeight - height) / 2, width, height, ratio }
		},

		/**
		 * A mark of a clip, from the `<clip>.marks.json` that `live` and `crop` write beside it:
		 * `t` is the film time it happens, `clipTime` the clip's own, and `region` the box to frame
		 * in the clip's pixels (around the pointer for a click). End a beat on a mark with
		 * `video.dataset.until = mark.clipTime + 0.6`: the clip holds that frame.
		 */
		clipMark(video, name) {
			const el = typeof video === 'string' ? document.querySelector(video) : video
			const src = el.getAttribute('src')
			const marks = window.CLIPS?.[src]?.marks ?? []
			const mark = marks.find((entry) => entry.name === name)
			if (!mark) throw new Error(`no mark "${name}" for ${src}; it has: ${marks.map((entry) => entry.name).join(', ') || 'no marks file'}`)
			if (!mark.box && !mark.point) return { t: Film.clipAt(el, mark.t), clipTime: mark.t, region: null }
			const box = mark.box ?? { x: mark.point.x - 1, y: mark.point.y - 1, width: 2, height: 2 }
			const region = mark.point ? { ...box, x: mark.point.x - box.width / 2, y: mark.point.y - box.height / 2 } : box
			return { t: Film.clipAt(el, mark.t), clipTime: mark.t, region }
		},

		/** Cards arrive one after another and stack; earlier cards recede. */
		stack(tl, cards, at, { gap = 0.45, offset = 26 } = {}) {
			cards.forEach((card, index) => {
				const t = at + index * gap
				// One filter list throughout (blur, then brightness): GSAP interpolates mismatched lists
				// number by number, which flashed a receding card nearly black.
				tl.fromTo(card, { y: 260, autoAlpha: 0, scale: 0.94, filter: 'blur(8px) brightness(1)' }, { y: 0, autoAlpha: 1, scale: 1, filter: 'blur(0px) brightness(1)', duration: 0.7, ease: 'land', immediateRender: index > 0 }, t)
				cards.slice(0, index).forEach((earlier, back) => {
					const depth = index - back
					tl.to(earlier, { y: -offset * depth, scale: 1 - 0.05 * depth, filter: `blur(0px) brightness(${1 - 0.12 * depth})`, duration: 0.6, ease: 'land' }, t)
					// A covered card keeps its edge but not its text, which would read through: it goes
					// just before the new card arrives, so two titles never cross.
					if (depth === 1) tl.to(earlier.children, { autoAlpha: 0, duration: 0.12 }, t - 0.12)
				})
			})
		},

		/** Swaps the text of `el` at `at` with a quick pop, e.g. a status changing state. */
		swap(tl, el, at, text) {
			const before = el.textContent
			tl.to(el, { scale: 0.6, autoAlpha: 0, duration: 0.15, ease: 'leave' }, at)
			tl.set(el, { textContent: text }, at + 0.15)
			tl.fromTo(el, { scale: 0.6, autoAlpha: 0 }, { scale: 1, autoAlpha: 1, duration: 0.35, ease: 'back.out(2)', immediateRender: false }, at + 0.15)
			return before
		},

		/** Counts `el` from `from` to `to` with `decimals` places (8.4: `decimals: 1`); shows `from` until then. */
		counter(tl, el, at, { from = 0, to, dur = 1.2, decimals = 0 } = {}) {
			const value = { n: from }
			const show = () => {
				el.textContent = value.n.toFixed(decimals)
			}
			show()
			tl.to(value, { n: to, duration: dur, ease: 'land', onUpdate: show }, at)
		},

		/**
		 * A cursor that glides between points and clicks. Points: `{ at, x, y, click, dur }`, with
		 * x and y in the cursor's parent coordinates and `dur` the glide that ends at `at`.
		 * Clicks pulse the cursor and its `.ripple`.
		 */
		cursor(tl, cursor, points) {
			tl.set(cursor, { x: points[0].x, y: points[0].y }, 0)
			for (const point of points.slice(1)) {
				const glide = point.dur ?? 0.7
				tl.to(cursor, { x: point.x, y: point.y, duration: glide, ease: 'swap' }, point.at - glide)
				if (!point.click) continue
				tl.to(cursor, { scale: 0.82, duration: 0.08, yoyo: true, repeat: 1, ease: 'power2.out' }, point.at)
				const ripple = cursor.querySelector('.ripple')
				if (ripple) tl.fromTo(ripple, { scale: 0.2, autoAlpha: 0.6 }, { scale: 2.4, autoAlpha: 0, duration: 0.5, ease: 'power2.out' }, point.at)
			}
		}
	}

	window.Film = Film
})()
