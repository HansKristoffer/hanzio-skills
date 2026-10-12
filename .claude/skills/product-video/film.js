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

	const seekVideo = (video, time) =>
		new Promise((resolve) => {
			const target = Math.min(Math.max(time, 0), Math.max((video.duration || 0) - 0.001, 0))
			if (Math.abs(video.currentTime - target) < 0.0005) return resolve()
			video.addEventListener('seeked', resolve, { once: true })
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
					// <video data-start="3.2" data-from="1.5" data-rate="2">: starts at 3.2 s on the
					// film clock, playing the clip from 1.5 s in at double speed.
					const videos = [...document.querySelectorAll('video[data-start]')]
					await Promise.all(
						videos.map((video) => {
							const { start, from = 0, rate = 1 } = video.dataset
							return seekVideo(video, (t - Number(start)) * Number(rate) + Number(from))
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

		/** A slow push so a held composition never freezes. */
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
		 * Moves the camera onto a region: `camera` (a positioned wrapper) scales so `target`,
		 * somewhere inside it, fills `fill` of the frame width, centred. Uses layout offsets,
		 * not rendered boxes, so tweens already on the timeline do not skew the measurement.
		 */
		focus(tl, camera, target, at, { fill = 0.6, dur = 1.1, ease = 'swap' } = {}) {
			const frame = camera.offsetParent
			let x = 0
			let y = 0
			for (let node = target; node && node !== camera; node = node.offsetParent) {
				x += node.offsetLeft
				y += node.offsetTop
			}
			const scale = (frame.clientWidth * fill) / target.offsetWidth
			const cx = x + target.offsetWidth / 2
			const cy = y + target.offsetHeight / 2
			tl.to(
				camera,
				{
					transformOrigin: '0 0',
					scale,
					x: frame.clientWidth / 2 - camera.offsetLeft - cx * scale,
					y: frame.clientHeight / 2 - camera.offsetTop - cy * scale,
					duration: dur,
					ease
				},
				at
			)
		},

		/** Cards arrive one after another and stack; earlier cards recede. */
		stack(tl, cards, at, { gap = 0.45, offset = 26 } = {}) {
			cards.forEach((card, index) => {
				const t = at + index * gap
				tl.from(card, { y: 260, autoAlpha: 0, scale: 0.94, filter: 'blur(8px)', duration: 0.7, ease: 'land' }, t)
				cards.slice(0, index).forEach((earlier, back) => {
					const depth = index - back
					tl.to(earlier, { y: -offset * depth, scale: 1 - 0.05 * depth, filter: `brightness(${1 - 0.12 * depth})`, duration: 0.6, ease: 'land' }, t)
					// A covered card keeps its edge but not its text, which would read through.
					if (depth === 1) tl.to(earlier.children, { autoAlpha: 0, duration: 0.3 }, t)
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

		/** Counts `el` from `from` to `to`; renders whole numbers. */
		counter(tl, el, at, { from = 0, to, dur = 1.2 } = {}) {
			tl.fromTo(el, { textContent: from }, { textContent: to, snap: { textContent: 1 }, duration: dur, ease: 'land' }, at)
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
