#!/usr/bin/env bun
// Product videos: render HTML/GSAP compositions frame by frame, record live walkthroughs of
// the real product in Chrome, voice and score them with ElevenLabs, and join the parts.
// Usage is in SKILL.md.
import { $ } from 'bun'
import { existsSync } from 'node:fs'
import { appendFile, chmod, copyFile, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { availableParallelism, homedir, tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { KIT_SOUNDS, REFERENCE_LEVEL, atLevel, describeSound, kitSound, levelBetween, readAudio, soundCard, trimmed, wav, withoutRumble, type SoundCard, type Stereo } from './sound.ts'

const SKILL_DIR = import.meta.dir
const PAD_SECONDS = 0.8
const SIZE = { width: 1920, height: 1080 }
/** Frame rate of recorded parts: scrolls and pointer glides are captured at it. */
const FPS = 60
/** The length of the pieces a composition is rendered in; each is drawn and encoded on its own. */
const CHUNK_SECONDS = 0.25
// Screen text survives a re-encode by X or YouTube only from a high-quality master. Colours are
// converted and tagged as BT.709, which players assume for HD; untagged, yellows and reds shift.
const COLOR = ['-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv']
const ENCODE = ['-c:v', 'libx264', '-preset', 'slow', '-crf', '14', '-pix_fmt', 'yuv420p', ...COLOR]
/** Scales to W:H with the sharpest filter, converting to BT.709. */
const scaleTo = (width: number, height: number) => `scale=${width}:${height}:flags=lanczos:out_color_matrix=bt709:out_range=tv`
const ELEVENLABS = 'https://api.elevenlabs.io/v1'

/** A scene without text is silent and lasts `dur` seconds (1.5 by default), e.g. a pause. */
type Scene = { id: string; text?: string; dur?: number }
type Timing = { id: string; audio: string; dur: number }[]
type Box = { x: number; y: number; width: number; height: number }
type Recording = {
	frames: { file: string; t: number }[]
	scenes: { id: string; start: number; end: number }[]
	cuts?: { start: number; end: number }[]
	marks?: { name: string; t: number; box?: Box; point?: { x: number; y: number } }[]
	scale?: number
}
/** Where things happen in a clip, in its own pixels and seconds: `<clip>.marks.json` beside the mp4. */
type ClipMarks = { width: number; height: number; marks: { name: string; t: number; box?: Box; point?: { x: number; y: number } }[] }

const [command, ...args] = process.argv.slice(2)
const commands: Record<string, (...args: string[]) => Promise<void>> = {
	init,
	narrate,
	music,
	sfx,
	'set-key': setKey,
	stills,
	lint,
	render,
	site,
	browse,
	walk,
	live,
	crop,
	card,
	concat,
	check,
	doctor
}

if (!command || !commands[command]) {
	console.error(`usage: bun video.ts <${Object.keys(commands).join('|')}> ...  (see SKILL.md)`)
	process.exit(1)
}
try {
	await commands[command](...args)
} catch (error) {
	// The message is what an agent acts on; a stack trace through this file is noise.
	console.error(`error: ${error instanceof Error ? error.message : String(error)}`)
	process.exit(1)
}

/**
 * Creates `<repo>/.video-build/<slug>/`, kept out of git through `.git/info/exclude`, with
 * a brief, `film.html` from the launch template (or the narrated explainer with
 * `--narrated`, which also writes `film.json`) and folders for assets and sound effects.
 */
async function init(slug: string, flag?: string) {
	if (!slug) throw new Error('usage: init <slug> [--narrated]')

	const gitRoot = await $`git rev-parse --show-toplevel`.nothrow().quiet().text()
	const root = gitRoot.trim() || process.cwd()
	const build = join(root, '.video-build', slug)
	await mkdir(build, { recursive: true })

	if (gitRoot.trim()) {
		// `--git-path` finds the shared exclude file from a worktree too.
		const exclude = resolve(root, (await $`git rev-parse --git-path info/exclude`.cwd(root).text()).trim())
		const current = existsSync(exclude) ? await readFile(exclude, 'utf8') : ''
		const missing = ['/.video-build/', `/${slug}.mp4`].filter((line) => !current.split('\n').includes(line))
		if (missing.length > 0) {
			await mkdir(dirname(exclude), { recursive: true })
			await appendFile(exclude, `${current.endsWith('\n') || !current ? '' : '\n'}${missing.join('\n')}\n`)
		}
	}

	await mkdir(join(build, 'assets'), { recursive: true })
	await mkdir(join(build, 'sfx'), { recursive: true })
	if (!existsSync(join(build, 'brief.md'))) await copyFile(join(SKILL_DIR, 'templates/brief.md'), join(build, 'brief.md'))

	const narrated = flag === '--narrated'
	if (!existsSync(join(build, 'film.html'))) {
		await copyFile(join(SKILL_DIR, 'templates', narrated ? 'explainer.html' : 'launch.html'), join(build, 'film.html'))
	}
	if (narrated && !existsSync(join(build, 'film.json'))) {
		const example: Scene[] = [
			{ id: 'intro', text: 'One or two sentences that say what changed and why it matters.' },
			{ id: 'how', text: 'What the user now sees or does, in plain words.' }
		]
		await writeFile(join(build, 'film.json'), `${JSON.stringify(example, null, 1)}\n`)
	}

	console.log(JSON.stringify({ root, build, output: join(root, `${slug}.mp4`) }, null, 1))
}

/**
 * Voices every scene of `<part>.json` into `<part>/audio/` and writes `<part>/timing.json`.
 * Without an ElevenLabs key it stops so the agent can ask for one; `--say` uses macOS `say`.
 */
async function narrate(partFile: string, flag?: string) {
	const useSay = flag === '--say'
	const scenes: Scene[] = await Bun.file(partFile).json()
	// An all-silent part (a product clip timed by `dur`) needs no voice and no key.
	const speaks = scenes.some((scene) => scene.text?.trim())
	const key = useSay || !speaks ? undefined : await elevenLabsKey()
	if (speaks && !key && !useSay) {
		console.error(
			'NO_ELEVENLABS_KEY: ask the user for their ElevenLabs API key, then store it with ' +
				'`bun video.ts set-key` (key on stdin). Or rerun with --say to narrate with macOS `say` or espeak-ng.'
		)
		process.exit(2)
	}

	const dir = partDir(partFile)
	const audioDir = join(dir, 'audio')
	await rm(audioDir, { recursive: true, force: true })
	await mkdir(audioDir, { recursive: true })

	const timing: Timing = []
	let words = 0
	let speaking = 0
	for (const [index, scene] of scenes.entries()) {
		const name = `${String(index).padStart(2, '0')}-${scene.id}`

		if (!scene.text?.trim()) {
			const seconds = scene.dur ?? 1.5
			const audio = join(audioDir, `${name}.wav`)
			await $`ffmpeg -v error -y -f lavfi -t ${seconds} -i anullsrc=r=48000:cl=stereo ${audio}`
			timing.push({ id: scene.id, audio, dur: seconds })
			console.log(`silent ${scene.id} (${seconds}s)`)
			continue
		}

		const audio = key
			? await speakElevenLabs(scene.text, join(audioDir, `${name}.mp3`), key)
			: await speakSay(scene.text, join(audioDir, name))
		const spoken = await duration(audio)
		words += scene.text.trim().split(/\s+/).length
		speaking += spoken

		timing.push({ id: scene.id, audio, dur: round(spoken + PAD_SECONDS) })
		console.log(`narrated ${scene.id} (${timing.at(-1)?.dur}s)`)
	}

	await writeFile(join(dir, 'timing.json'), JSON.stringify(timing, null, 1))
	const pace = speaking > 0 ? `, ${Math.round((words / speaking) * 60)} words per minute` : ''
	console.log(`total ${round(timing.reduce((sum, scene) => sum + scene.dur, 0))}s${pace}`)
}

/**
 * The frames to look at, from `--at 1.2,4`, `--around 2.3` (every 0.05 s from 0.3 s before a
 * transition to 0.3 s after it) or `--every 0.5` (the default).
 */
function stillTimes(values: { every?: string; at?: string; around?: string }, seconds: number) {
	const inside = (times: number[]) => [...new Set(times.map((t) => round(Math.min(Math.max(t, 0), seconds))))]
	if (values.at) return inside(values.at.split(',').map(Number))
	if (values.around) return inside(values.around.split(',').flatMap((t) => Array.from({ length: 13 }, (_, i) => Number(t) - 0.3 + i * 0.05)))
	const every = Number(values.every ?? 0.5)
	return inside(Array.from({ length: Math.floor(seconds / every + 1e-6) + 1 }, (_, i) => i * every))
}

/**
 * Contact sheets sized for reading: each at most 1920 px a side, which is what an agent sees
 * without the image being scaled down, with tiles as large as the number of frames allows (480 px
 * wide for a full sheet of 16:9) and each tile labelled with its time. Writes `<base>.png`, or
 * `<base>-1.png`, `<base>-2.png` when one sheet cannot hold them, and returns the paths.
 */
async function contactSheets(frames: { file: string; t: number }[], base: string, size: { width: number; height: number }) {
	const folder = dirname(base)
	for (const old of await readdir(folder)) {
		if (old === `${basename(base)}.png` || (old.startsWith(`${basename(base)}-`) && /-\d+\.png$/.test(old))) await rm(join(folder, old))
	}
	const aspect = size.width / size.height
	const most = Math.max(1, Math.floor(1920 / Math.round(Math.sqrt(480 * 270 * aspect))))
	const columns = Math.min(most, Math.ceil(Math.sqrt(frames.length)))
	let width = Math.floor(1920 / columns)
	let height = Math.round(width / aspect)
	if (height > 1900) [width, height] = [Math.round(1900 * aspect), 1900]
	const perSheet = columns * Math.max(1, Math.floor(1900 / height))

	const browser = await launchBrowser()
	const page = await browser.newPage()
	const sheets: string[] = []
	const html = `${base}.sheet.html`
	for (let first = 0; first < frames.length; first += perSheet) {
		const tiles = frames.slice(first, first + perSheet)
		const rows = Math.ceil(tiles.length / columns)
		await writeFile(
			html,
			`<!doctype html><body style="margin:0;background:#808080;display:grid;grid-template-columns:repeat(${columns},${width}px);font:700 ${Math.max(16, Math.round(width / 22))}px/1 monospace">${tiles
				.map(({ file, t }) => `<div style="position:relative;width:${width}px;height:${height}px"><img src="file://${resolve(file)}" style="width:100%;height:100%;display:block"><span style="position:absolute;left:0;top:0;padding:4px 8px;background:#ff2d55;color:#fff">${t}s</span></div>`)
				.join('')}</body>`
		)
		await page.setViewportSize({ width: columns * width, height: rows * height })
		await page.goto(`file://${resolve(html)}`)
		const sheet = frames.length > perSheet ? `${base}-${sheets.length + 1}.png` : `${base}.png`
		await page.screenshot({ path: sheet })
		sheets.push(sheet)
	}
	await browser.close()
	await rm(html, { force: true })
	return sheets
}

/** Frames of a rendered video at the given times, at most 1920 px wide, into `dir`. */
async function videoFrames(video: string, times: number[], dir: string) {
	await rm(dir, { recursive: true, force: true })
	await mkdir(dir, { recursive: true })
	const frames = times.map((t) => ({ t, file: join(dir, `${t.toFixed(2).padStart(7, '0')}.jpg`) }))
	const queue = [...frames]
	await Promise.all(
		Array.from({ length: 8 }, async () => {
			for (let frame = queue.shift(); frame; frame = queue.shift()) {
				await $`ffmpeg -v error -y -ss ${frame.t} -i ${video} -frames:v 1 -vf scale=${"'min(1920,iw)'"}:-2 -q:v 2 ${frame.file}`.nothrow()
			}
		})
	)
	return frames.filter(({ file }) => existsSync(file))
}

async function videoSize(video: string) {
	const [width, height] = (await $`ffprobe -v error -select_streams v -show_entries stream=width,height -of csv=p=0 ${video}`.text()).trim().split(',').map(Number)
	return { width, height }
}

/**
 * How many browsers to draw frames with: half the cores, up to 32. Measured on the starter
 * film at 2x: 64 cores take 37 s with 32 browsers, 46 s with 16 and 38 s with 48; 8 cores
 * take half as long with 4 browsers as with 2.
 */
function defaultWorkers() {
	return Math.min(32, Math.max(1, Math.floor(availableParallelism() / 2)))
}

/**
 * Frames to look at, as contact sheets with every tile labelled by its time, from a composition
 * (`<part>.html`, drawn in parallel without rendering the film, and linted) or from any rendered
 * video (`<video>.mp4`). `--every 0.5` is the default; `--at 1.2,4` picks moments; `--around 2.3`
 * steps through a transition, 13 frames 0.05 s apart. Full-size frames are kept beside the sheet.
 */
async function stills(file: string, ...rest: string[]) {
	if (!file) throw new Error('usage: stills <part>.html|<video>.mp4 [--every 0.5 | --at 1,2.5 | --around 2.3]')
	const { values } = parseArgs({ args: rest, options: { every: { type: 'string' }, at: { type: 'string' }, around: { type: 'string' } } })

	if (!file.endsWith('.html')) {
		const base = file.replace(/\.[^.]+$/, '.stills')
		const frames = await videoFrames(file, stillTimes(values, await duration(file)), base)
		const sheets = await contactSheets(frames, base, await videoSize(file))
		console.log(`${sheets.join('\n')}\n${frames.length} frames; full size in ${base}/`)
		return
	}

	const dir = file.replace(/\.html$/, '')
	const out = join(dir, 'stills')
	await rm(out, { recursive: true, force: true })
	await mkdir(out, { recursive: true })

	const first = await openComposition(file)
	const times = stillTimes(values, first.film.duration)
	const frames = times.map((t) => ({ t, file: join(out, `${t.toFixed(2).padStart(7, '0')}.png`) }))
	// Each browser takes the next frame until none is left: a still costs as much as a rendered frame.
	const queue = [...frames]
	const workers = Math.min(defaultWorkers(), Math.ceil(frames.length / 3))
	const pages = [first, ...(await Promise.all(Array.from({ length: workers - 1 }, () => openComposition(file))))]
	await Promise.all(
		pages.map(async ({ page }) => {
			for (let frame = queue.shift(); frame; frame = queue.shift()) {
				await seekFrame(page, frame.t)
				await page.screenshot({ path: frame.file })
			}
		})
	)
	const findings = await lintFindings(first.page, first.film)
	await Promise.all(pages.map(({ browser }) => browser.close()))

	const sheets = await contactSheets(frames, join(dir, 'stills'), first.size)
	console.log(`${sheets.join('\n')}\n${frames.length} frames; full size in ${out}/`)
	printLint(findings)
}

/**
 * Reads the composition's layout through time, without drawing a frame, for what a viewer would
 * see as a defect: empty frames, text crossing text or cut off at the frame's edge, type too small
 * for a phone, stretches where nothing moves, two tweens fighting over one property, and filters
 * that make every frame slow to draw. `lint <part>.html`; `stills` runs it too.
 */
async function lint(htmlFile: string) {
	if (!htmlFile) throw new Error('usage: lint <part>.html')
	const { browser, page, film } = await openComposition(htmlFile)
	const findings = await lintFindings(page, film)
	await browser.close()
	printLint(findings)
}

async function lintFindings(page: { evaluate<T>(fn: () => Promise<T>): Promise<T> }, film: FilmState) {
	const findings = await page.evaluate(() => (window as unknown as { Film: { lint(): Promise<string[]> } }).Film.lint())
	// Sounds that land together at the same level stack into one loud event.
	const cues = film.cues.toSorted((a, b) => a.t - b.t)
	for (const [index, cue] of cues.entries()) {
		const next = cues[index + 1]
		if (next && next.sound === cue.sound && next.t - cue.t < 0.15 && next.gain >= cue.gain) findings.push(`${cue.sound} plays at ${cue.t}s and again at ${next.t}s: within 0.15 s they stack, so give the later one about -4 dB`)
	}
	return findings
}

function printLint(findings: string[]) {
	console.log(findings.length === 0 ? 'lint: clean' : `lint: ${findings.length} to look at (stills --at <time> shows each)\n${findings.map((line) => `  ${line}`).join('\n')}`)
}

/**
 * Renders a composition frame by frame into `<part>/video.mp4` with its audio: narration
 * from `<part>.json`, the music and sound cues it declares. `render <part>.html [--draft]
 * [--from 9 --to 12.5] [--fps 60] [--scale 2] [--workers N] [--audio-only]`.
 * Frames are drawn at `--scale` times the pixels and scaled down, so text and footage stay
 * crisp and a large clip shown small does not shimmer. `--draft` is 30 fps at scale 1, several
 * times faster, for judging motion. The film is drawn in quarter-second chunks kept in
 * `<part>/chunks/`, by several browsers at once: every frame is a pure function of time, so the
 * chunks join seamlessly. `--from` and `--to` redraw only the chunks in that stretch and reuse the
 * rest, for a change that touches one beat; the result is marked as mixed until a whole render.
 * `--audio-only` remixes the sound onto the frames of the last render.
 */
async function render(htmlFile: string, ...rest: string[]) {
	const { values } = parseArgs({
		args: rest,
		options: { fps: { type: 'string' }, scale: { type: 'string' }, workers: { type: 'string' }, draft: { type: 'boolean' }, from: { type: 'string' }, to: { type: 'string' }, 'audio-only': { type: 'boolean' } }
	})
	const fps = Number(values.fps ?? (values.draft ? 30 : 60))
	const scale = Number(values.scale ?? (values.draft ? 1 : 2))
	const dir = htmlFile.replace(/\.html$/, '')
	await mkdir(dir, { recursive: true })

	const first = await openComposition(htmlFile, scale)
	const { film, size } = first
	const silent = join(dir, 'frames.mp4')
	const chunkDir = join(dir, 'chunks')
	const manifestFile = join(chunkDir, 'manifest.json')
	type Manifest = { shape: string; sources: string[] }
	const previous: Manifest | null = existsSync(manifestFile) ? await Bun.file(manifestFile).json() : null
	const mixedNote = (sources: string[]) => (new Set(sources).size > 1 ? 'mixed: some chunks were drawn from an earlier version of the composition' : '')

	if (values['audio-only']) {
		await first.browser.close()
		if (!existsSync(silent)) throw new Error(`${silent} is missing: render once without --audio-only`)
		return mux(silent, await mixAudio(htmlFile, film), join(dir, 'video.mp4'), mixedNote(previous?.sources ?? []))
	}

	const frames = Math.round(film.duration * fps)
	// A quarter of a second per chunk: small enough that a short stretch still spreads over every browser.
	const chunkFrames = Math.max(1, Math.round(fps * CHUNK_SECONDS))
	const count = Math.ceil(frames / chunkFrames)
	const shape = JSON.stringify({ fps, scale, ...size, frames, chunkFrames })
	const ranged = values.from !== undefined || values.to !== undefined
	if (ranged && previous?.shape !== shape) {
		await first.browser.close()
		throw new Error('--from and --to redraw part of the last render, and there is none with this length, --fps and --scale: render the film whole once, with the same flags')
	}
	const from = Math.max(0, Math.floor((Number(values.from ?? 0) * fps) / chunkFrames))
	const to = Math.min(count, Math.ceil((Number(values.to ?? film.duration) * fps) / chunkFrames))
	const wanted = Array.from({ length: count }, (_, index) => index).filter((index) => !ranged || (index >= from && index < to))
	const sources = ranged && previous ? previous.sources : Array.from({ length: count }, () => film.source)
	if (!ranged) await rm(chunkDir, { recursive: true, force: true })
	await mkdir(chunkDir, { recursive: true })
	const chunkFile = (index: number) => join(chunkDir, `${String(index).padStart(4, '0')}.mp4`)

	const workers = Math.max(1, Math.min(Number(values.workers ?? defaultWorkers()), wanted.length))
	// The first browser is open already; the others load the same composition.
	const pages = [first, ...(await Promise.all(Array.from({ length: workers - 1 }, () => openComposition(htmlFile, scale))))]
	const clip = await deviceClip(first.page, size, scale)

	const started = Date.now()
	const total = wanted.reduce((sum, index) => sum + Math.min(chunkFrames, frames - index * chunkFrames), 0)
	let done = 0
	// Each browser takes the next chunk until none is left, so a heavy stretch never holds one back.
	const queue = [...wanted]
	await Promise.all(
		pages.map(async ({ browser, page }) => {
			const cdp = await page.context().newCDPSession(page)
			for (let index = queue.shift(); index !== undefined; index = queue.shift()) {
				const draft = `${chunkFile(index)}.part`
				const encoder = Bun.spawn(
					['ffmpeg', '-v', 'error', '-y', '-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'mjpeg', '-i', '-', '-vf', scaleTo(size.width, size.height), ...ENCODE, '-r', String(fps), '-f', 'mp4', draft],
					{ stdin: 'pipe' }
				)
				for (let frame = index * chunkFrames; frame < Math.min((index + 1) * chunkFrames, frames); frame++) {
					await seekFrame(page, frame / fps)
					const { data } = await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 95, optimizeForSpeed: true, ...(clip && { clip }) })
					encoder.stdin.write(Buffer.from(data, 'base64'))
					await encoder.stdin.flush()
					if (++done % (fps * 5) === 0) console.log(`frame ${done}/${total}`)
				}
				encoder.stdin.end()
				if ((await encoder.exited) !== 0) throw new Error(`encoding chunk ${index} failed`)
				await rename(draft, chunkFile(index))
				sources[index] = film.source
			}
			await browser.close()
		})
	)
	await writeFile(manifestFile, JSON.stringify({ shape, sources } satisfies Manifest))

	const list = join(chunkDir, 'chunks.txt')
	await writeFile(list, Array.from({ length: count }, (_, index) => `file '${basename(chunkFile(index))}'`).join('\n'))
	await $`ffmpeg -v error -y -f concat -safe 0 -i ${list} -c copy ${silent}`
	const stretch = ranged ? ` for ${round((from * chunkFrames) / fps)}-${round(Math.min(to * chunkFrames, frames) / fps)}s` : ''
	console.log(`rendered ${total} frames${stretch} in ${round((Date.now() - started) / 1000)}s with ${workers} ${workers === 1 ? 'browser' : 'browsers'}, ${size.width * scale}x${size.height * scale} scaled to ${size.width}x${size.height} at ${fps} fps`)
	const mixed = mixedNote(sources)
	if (mixed) console.warn('this render mixes chunks from more than one version of the composition: render it whole (no --from/--to) before delivering')

	await mux(silent, await mixAudio(htmlFile, film), join(dir, 'video.mp4'), mixed)
}

/**
 * The screenshot region that returns `scale` device pixels per CSS pixel, or none when a plain
 * screenshot already does (a browser drawing at that scale itself). Chrome builds differ in
 * whether a clip counts in CSS or device pixels, so test frames decide: without this, a 2x
 * render can silently come out at 1x.
 */
async function deviceClip(page: { context(): { newCDPSession(page: unknown): Promise<{ send(method: string, params: unknown): Promise<{ data: string }> }> } }, size: { width: number; height: number }, scale: number) {
	const cdp = await page.context().newCDPSession(page)
	const width = async (clip?: object) => jpegWidth(Buffer.from((await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 50, ...(clip && { clip }) })).data, 'base64'))
	if ((await width()) === size.width * scale) return undefined
	const clip = { x: 0, y: 0, ...size, scale: 1 }
	const got = await width(clip)
	return { ...clip, scale: got > 0 ? (size.width * scale) / got : scale }
}

/** The pixel width of a JPEG, read from its frame header. */
function jpegWidth(data: Buffer) {
	for (let at = 2; at + 9 < data.length; ) {
		if (data[at] !== 0xff) return 0
		const marker = data[at + 1]
		if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return data.readUInt16BE(at + 7)
		at += 2 + data.readUInt16BE(at + 2)
	}
	return 0
}

/** Joins picture and sound into the part's video; `comment` travels in the file for `check` to read. */
async function mux(video: string, audio: string, out: string, comment = '') {
	await $`ffmpeg -v error -y -i ${video} -i ${audio} -map 0:v -map 1:a -c:v copy -c:a aac -b:a 192k -shortest -metadata comment=${comment} -movflags +faststart ${out}`
	console.log(out)
}

/** Turns the frames `live.mjs` captured into `<part>/video.mp4` with the narration. */
async function live(partFile: string) {
	const dir = partDir(partFile)
	const timing = await readTiming(dir)
	const { frames, scenes, cuts = [], marks = [], scale = 1 }: Recording = await Bun.file(join(dir, 'recording.json')).json()

	const recordedIds = scenes.map((scene) => scene.id)
	const timingIds = timing.map((scene) => scene.id)
	if (recordedIds.join() !== timingIds.join()) {
		throw new Error(`recorded scenes [${recordedIds}] do not match the script [${timingIds}]`)
	}
	if (frames.length === 0) throw new Error('the recording has no frames')

	// The video keeps only time inside scenes, minus the cuts; waits between scenes drop out.
	const kept = scenes.map((scene) => withoutCuts(scene.start, scene.end, cuts))
	const durations = kept.map((intervals) => intervals.reduce((sum, [from, to]) => sum + to - from, 0))

	const narration = await buildNarration(dir, timing, durations)
	const out = join(dir, 'video.mp4')
	const total = durations.reduce((sum, seconds) => sum + seconds, 0)
	// The video keeps the recorded density (3840x2160 at scale 2), so crops stay sharp;
	// `concat` scales parts to the film size.
	const width = SIZE.width * scale
	const height = SIZE.height * scale
	const [frameWidth] = (await $`ffprobe -v error -show_entries stream=width,height -of csv=p=0 ${join(dir, 'frames', frames[0].file)}`.text()).trim().split(',').map(Number)
	if (frameWidth < width) console.warn(`frames are ${frameWidth} pixels wide, not ${width}: the footage is enlarged and will look soft`)

	// One recorded frame per 1/60 s of video, piped in order: a frame is stored only when the page
	// changed, so each holds until the next. Not the concat demuxer, which puts every image on a
	// 1/25 s clock and turns a 60 fps scroll into 25 fps steps.
	const intervals = kept.flat()
	const encoder = Bun.spawn(
		['ffmpeg', '-v', 'error', '-y', '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'mjpeg', '-i', '-', '-i', narration, '-t', String(total), '-map', '0:v', '-map', '1:a',
			'-vf', `${scaleTo(width, height)}:force_original_aspect_ratio=decrease,pad=${width}:${height}:-1:-1:color=black`,
			'-c:v', 'libx264', '-preset', 'slow', '-crf', '12', '-pix_fmt', 'yuv420p', ...COLOR, '-c:a', 'aac', '-b:a', '160k', out],
		{ stdin: 'pipe' }
	)
	let interval = 0
	let intervalStart = 0 // video time at which `interval` begins
	let source = 0
	let cached = { file: '', data: Buffer.alloc(0) }
	for (let index = 0; index < Math.round(total * FPS); index++) {
		const videoTime = index / FPS
		while (interval < intervals.length - 1 && videoTime >= intervalStart + intervals[interval][1] - intervals[interval][0]) {
			intervalStart += intervals[interval][1] - intervals[interval][0]
			interval++
		}
		const recorded = intervals[interval][0] + videoTime - intervalStart
		// The last frame at or before that moment; a cut can jump back as well as forward.
		if (frames[source].t > recorded) source = 0
		while (source < frames.length - 1 && frames[source + 1].t <= recorded) source++
		const { file } = frames[source]
		if (cached.file !== file) cached = { file, data: await readFile(join(dir, 'frames', file)) }
		encoder.stdin.write(cached.data)
		await encoder.stdin.flush()
	}
	encoder.stdin.end()
	if ((await encoder.exited) !== 0) throw new Error('ffmpeg failed to assemble the recording')
	console.log(out)

	// Marks in video time and pixels, with a crop for each marked element (even sizes, as x264 needs).
	const videoTime = (t: number) =>
		intervals.reduce((sum, [from, to]) => sum + Math.max(0, Math.min(t, to) - from), 0)
	const even = (value: number) => Math.max(2, Math.round(value / 2) * 2)
	const scaled = (box: Box) => ({ x: box.x * scale, y: box.y * scale, width: box.width * scale, height: box.height * scale })
	const placed: ClipMarks = {
		width,
		height,
		marks: marks.map(({ name, t, box, point }) => ({
			name,
			t: round(videoTime(t)),
			...(box && { box: scaled(box) }),
			...(point && { point: { x: point.x * scale, y: point.y * scale } })
		}))
	}
	await writeFile(join(dir, 'video.marks.json'), JSON.stringify(placed, null, 2))
	for (const { name, t, box } of placed.marks) {
		const crop = box && `  crop=${even(box.width)}:${even(box.height)}:${even(box.x)}:${even(box.y)}`
		console.log(`mark ${t.toFixed(2)}s  ${name}${crop ?? ''}`)
	}
}

/**
 * Crops a recorded part to a mark's element (`live` prints them) or an explicit `W:H:X:Y`,
 * with `--pad` video pixels around it, and writes a preview frame to check the edges. The
 * part's marks move into the crop's pixels in `<out>.marks.json`, so a composition can zoom
 * onto them. `crop <part>.json <mark|W:H:X:Y> <out.mp4> [--pad 0] [--at <seconds>]`
 */
async function crop(partFile: string, region: string, output: string, ...rest: string[]) {
	if (!partFile || !region || !output) throw new Error('usage: crop <part>.json <mark|W:H:X:Y> <out.mp4> [--pad 0] [--at 1]')
	const { values } = parseArgs({ args: rest, options: { pad: { type: 'string' }, at: { type: 'string' } } })
	const dir = partDir(partFile)
	const source = join(dir, 'video.mp4')

	const marksFile = join(dir, 'video.marks.json')
	const recorded: ClipMarks | null = existsSync(marksFile) ? await Bun.file(marksFile).json() : null
	let box = region.split(':').map(Number)
	if (box.length !== 4 || box.some(Number.isNaN)) {
		const mark = recorded?.marks.find((entry) => entry.name === region)
		if (!mark?.box) throw new Error(`no mark "${region}" with an element in ${marksFile}`)
		box = [mark.box.width, mark.box.height, mark.box.x, mark.box.y]
	}

	// Pad, keep inside the frame, and keep every number even for x264.
	const [frameWidth, frameHeight] = (await $`ffprobe -v error -select_streams v -show_entries stream=width,height -of csv=p=0 ${source}`.text()).trim().split(',').map(Number)
	const pad = Number(values.pad ?? 0)
	const even = (value: number) => Math.round(value / 2) * 2
	const x = even(Math.max(0, box[2] - pad))
	const y = even(Math.max(0, box[3] - pad))
	const width = even(Math.min(frameWidth - x, box[0] + pad * 2))
	const height = even(Math.min(frameHeight - y, box[1] + pad * 2))
	const filter = `crop=${width}:${height}:${x}:${y}`

	await $`ffmpeg -v error -y -i ${source} -vf ${filter} -an -c:v libx264 -preset slow -crf 12 -pix_fmt yuv420p ${COLOR} ${output}`
	if (recorded) {
		const moved: ClipMarks = {
			width,
			height,
			marks: recorded.marks.map(({ box: markBox, point, ...mark }) => ({
				...mark,
				...(markBox && { box: { ...markBox, x: markBox.x - x, y: markBox.y - y } }),
				...(point && { point: { x: point.x - x, y: point.y - y } })
			}))
		}
		await writeFile(output.replace(/\.mp4$/, '.marks.json'), JSON.stringify(moved, null, 2))
	}
	const preview = output.replace(/\.mp4$/, '') + '.preview.png'
	await $`ffmpeg -v error -y -ss ${values.at ?? '1'} -i ${output} -frames:v 1 ${preview}`
	console.log(`${output}  ${filter}\npreview: ${preview}`)
}

/** Joins parts (recorded videos or any clip, such as a logo intro) into one video. */
async function concat(output: string, ...parts: string[]) {
	if (!output || parts.length === 0) throw new Error('usage: concat <output.mp4> <part.mp4>...')

	// The joined video takes the first part's size and the highest frame rate of any part.
	const [width, height] = (await $`ffprobe -v error -select_streams v -show_entries stream=width,height -of csv=p=0 ${parts[0]}`.text()).trim().split(',').map(Number)
	let fps = 30
	for (const part of parts) {
		const [num, den] = (await $`ffprobe -v error -select_streams v -show_entries stream=r_frame_rate -of csv=p=0 ${part}`.text()).trim().split('/').map(Number)
		fps = Math.max(fps, Math.round(num / (den || 1)))
	}

	const inputs: string[] = []
	const filters: string[] = []
	let next = 0
	for (const [index, part] of parts.entries()) {
		inputs.push('-i', part)
		const video = next++
		filters.push(
			`[${video}:v]${scaleTo(width, height)}:force_original_aspect_ratio=decrease,pad=${width}:${height}:-1:-1:color=black,fps=${fps},format=yuv420p,setsar=1[v${index}]`
		)

		// A silent clip gets a silent track of its own length so the join stays in sync.
		const hasAudio = (await $`ffprobe -v error -select_streams a -show_entries stream=index -of csv=p=0 ${part}`.text()).trim()
		let audio = video
		if (!hasAudio) {
			inputs.push('-f', 'lavfi', '-t', String(await duration(part)), '-i', 'anullsrc=r=48000:cl=stereo')
			audio = next++
		}
		filters.push(`[${audio}:a]aresample=48000,aformat=channel_layouts=stereo[a${index}]`)
	}
	const joined = parts.map((_, index) => `[v${index}][a${index}]`).join('')
	filters.push(`${joined}concat=n=${parts.length}:v=1:a=1[v][a]`)

	// Title cards made by `card` carry their title; each one starts a chapter.
	const chapters: { title: string; start: number }[] = []
	let at = 0
	for (const part of parts) {
		const title = (await $`ffprobe -v error -show_entries format_tags=title -of csv=p=0 ${part}`.text()).trim()
		if (title) chapters.push({ title, start: at })
		else if (at === 0) chapters.push({ title: 'Intro', start: 0 })
		at += await duration(part)
	}

	const chapterArgs: string[] = []
	if (chapters.length > 1) {
		const metadata = [';FFMETADATA1']
		for (const [index, chapter] of chapters.entries()) {
			const end = chapters[index + 1]?.start ?? at
			metadata.push('[CHAPTER]', 'TIMEBASE=1/1000', `START=${Math.round(chapter.start * 1000)}`, `END=${Math.round(end * 1000)}`, `title=${chapter.title.replace(/[=;#\\\n]/g, ' ')}`)
		}
		const file = join(tmpdir(), `${basename(output, '.mp4')}.chapters.txt`)
		await writeFile(file, `${metadata.join('\n')}\n`)
		chapterArgs.push('-f', 'ffmetadata', '-i', file, '-map_chapters', String(next))
	}

	await $`ffmpeg -v error -y ${inputs} ${chapterArgs.slice(0, 4)} -filter_complex ${filters.join(';')} -map ${'[v]'} -map ${'[a]'} ${chapterArgs.slice(4)} ${ENCODE} -c:a aac -b:a 160k -movflags +faststart ${output}`
	console.log(`${output} (${round(await duration(output))}s)`)

	if (chapters.length > 1) {
		console.log('\nYouTube chapters:')
		for (const chapter of chapters) console.log(`${timestamp(chapter.start)} ${chapter.title}`)
	}
}

/**
 * A short chapter title card in the brand's style: `card <out.mp4> <title> [--eyebrow
 * "Chapter 2"] [--style <part>.html] [--seconds 1.5]`. The title is stored in the file,
 * so `concat` turns each card into a chapter.
 */
async function card(output: string, ...rest: string[]) {
	const { values, positionals } = parseArgs({
		args: rest,
		allowPositionals: true,
		options: { eyebrow: { type: 'string' }, style: { type: 'string' }, seconds: { type: 'string' } }
	})
	const title = positionals.join(' ')
	if (!output || !title) throw new Error('usage: card <out.mp4> <title> [--eyebrow x] [--style part.html] [--seconds 1.5]')

	// Reuse the brand stylesheet of a composition, written next to it so its asset paths resolve.
	const styleSource = resolve(values.style ?? join(SKILL_DIR, 'templates/explainer.html'))
	const stylesheet = (await readFile(styleSource, 'utf8')).match(/<style>[\s\S]*?<\/style>/)?.[0] ?? ''
	const escape = (text: string) => text.replace(/[&<>"]/g, (char) => `&#${char.charCodeAt(0)};`)
	const eyebrow = values.eyebrow ? `<div class="eyebrow">${escape(values.eyebrow)}</div>` : ''
	const html = join(dirname(styleSource), `.card-${basename(output, '.mp4')}.html`)
	await writeFile(
		html,
		`<!doctype html><html><head><meta charset="utf-8">${stylesheet}<style>.title-card{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:28px;text-align:center;opacity:1;visibility:visible}</style></head><body><section class="title-card">${eyebrow}<h1>${escape(title)}</h1></section></body></html>`
	)

	const browser = await launchBrowser()
	const page = await browser.newPage({ viewport: SIZE })
	await page.goto(`file://${html}`)
	const still = join(tmpdir(), `${basename(output, '.mp4')}.card.png`)
	await page.screenshot({ path: still })
	await browser.close()
	await rm(html)

	const seconds = Number(values.seconds ?? 1.5)
	const fadeOut = Math.max(seconds - 0.25, 0)
	await $`ffmpeg -v error -y -loop 1 -t ${seconds} -i ${still} -f lavfi -t ${seconds} -i anullsrc=r=48000:cl=stereo -vf scale=out_color_matrix=bt709:out_range=tv,fps=30,fade=in:d=0.25,fade=out:st=${fadeOut}:d=0.25 ${ENCODE} -c:a aac -b:a 160k -shortest -metadata title=${title} ${output}`
	console.log(output)
}

/**
 * Measures a finished video: a contact sheet beside it, frozen stretches (frames that barely
 * change, sampled at 10 fps), judder, and loudness (integrated, range, true peak, and second by
 * second). `check <sound.wav>` measures one sound instead.
 */
async function check(video: string) {
	if (!video) throw new Error('usage: check <video.mp4> | check <sound.wav>')
	if (/\.(wav|mp3|aiff|m4a|flac|ogg)$/i.test(video)) return console.log(describeSound(soundCard(await readAudio(video))))

	const seconds = await duration(video)
	const base = video.replace(/\.[^.]+$/, '.stills')
	const sheetFrames = await videoFrames(video, Array.from({ length: 24 }, (_, i) => round(((i + 0.5) * seconds) / 24)), base)
	console.log(`contact sheet: ${(await contactSheets(sheetFrames, base, await videoSize(video))).join(', ')}`)
	const comment = (await $`ffprobe -v error -show_entries format_tags=comment -of csv=p=0 ${video}`.nothrow().text()).trim()
	if (comment.startsWith('mixed')) console.log('NOT FINAL: this render mixes chunks from more than one version of the composition; render it whole (no --from/--to) before delivering')

	const stats = await $`ffmpeg -hide_banner -i ${video} -vf fps=10,scale=320:-1,format=gray,tblend=all_mode=difference,signalstats,metadata=print:key=lavfi.signalstats.YAVG -an -f null -`.nothrow().quiet()
	const diffs = [...stats.stderr.toString().matchAll(/YAVG=([0-9.]+)/g)].map((match) => Number(match[1]))
	const frozen = frozenStretches(diffs, 0.35, 10)
	const total = frozen.reduce((sum, [from, to]) => sum + to - from, 0)
	const longest = frozen.toSorted((a, b) => b[1] - b[0] - (a[1] - a[0]))[0]
	console.log(
		`frozen: ${round(total)}s of ${round(seconds)}s` +
			(longest ? `, longest ${round(longest[1] - longest[0])}s at ${round(longest[0])}s` : '') +
			' (aim in graphics beats: under 1s per 30s, no hold over 0.6s except the end card; in product footage a still camera is right while the pointer or the product moves)'
	)
	const holds = frozen.filter(([from, to]) => to - from > 0.6)
	if (holds.length > 0) console.log(`holds over 0.6s: ${holds.map(([from, to]) => `${round(from)}-${round(to)}s`).join(', ')}`)

	// Judder: at the full frame rate, a frame that repeats its predecessor while the frames on either
	// side move. A smooth scroll or zoom changes every frame; one assembled or seeked at the wrong
	// rate stalls every second or third frame, which reads as stutter.
	const [num, den] = (await $`ffprobe -v error -select_streams v -show_entries stream=r_frame_rate -of csv=p=0 ${video}`.text()).trim().split('/').map(Number)
	const rate = num / (den || 1)
	const full = await $`ffmpeg -hide_banner -i ${video} -vf scale=480:-1,format=gray,tblend=all_mode=difference,signalstats,metadata=print:key=lavfi.signalstats.YAVG -an -f null -`.nothrow().quiet()
	const steps = [...full.stderr.toString().matchAll(/YAVG=([0-9.]+)/g)].map((match) => Number(match[1]))
	const stalls = steps.flatMap((diff, i) => (i > 0 && diff < 0.05 && steps[i - 1] > 0.6 && steps[i + 1] > 0.6 ? [i + 1] : []))
	const stretches = judderStretches(stalls)
	// Stalls an even number of frames apart are footage at half the rate (a 30 fps clip, which may
	// repeat frames of its own): how it was filmed. Odd gaps, a stall every third frame, are judder
	// from assembling or seeking at the wrong rate.
	const span = ([from, to]: number[]) => `${round(from / rate)}-${round(to / rate)}s`
	const halfRate = stretches.filter((stretch) => stretch.gaps.every((gap) => gap % 2 === 0))
	const judder = stretches.filter((stretch) => !halfRate.includes(stretch))
	console.log(
		judder.length === 0
			? `judder: none (every moving stretch changes on every frame at ${rate} fps)`
			: `judder: uneven stalls mid-motion at ${judder.map((stretch) => `${span(stretch.frames)} (${stretch.count})`).join(', ')}; step through them frame by frame`
	)
	if (halfRate.length > 0) console.log(`half-rate footage (a ${rate / 2} fps clip, expected): ${halfRate.map((stretch) => span(stretch.frames)).join(', ')}`)

	const hasAudio = (await $`ffprobe -v error -select_streams a -show_entries stream=index -of csv=p=0 ${video}`.text()).trim()
	if (!hasAudio) return console.log('loudness: no audio track')
	const loud = (await $`ffmpeg -hide_banner -i ${video} -af ebur128=peak=true -f null -`.nothrow().quiet()).stderr.toString()
	const summary = loud.slice(loud.lastIndexOf('Summary:'))
	const pick = (label: string) => summary.match(new RegExp(`${label}:\\s+(-?[0-9.]+)`))?.[1]
	if (Number(pick('I')) <= -69) return console.log('loudness: the audio track is silent')
	console.log(`loudness: ${pick('I')} LUFS integrated, range ${pick('LRA')} LU, true peak ${pick('Peak')} dBFS (aim: about -14 music-led, -16 narrated, peak at or below -1)`)
	console.log(`loudness by second: ${loudnessBySecond(loud)}`)
}

/**
 * From ffmpeg's ebur128 log: the loudest 400 ms of each second in LUFS, so a quiet start, a dead
 * stop or an early fade shows. Momentary loudness, because short-term needs 3 s to fill.
 */
function loudnessBySecond(log: string) {
	const bySecond: number[] = []
	for (const [, t, level] of log.matchAll(/t:\s*([0-9.]+)\s+TARGET.*?M:\s*(-?[0-9.]+|-inf)/g)) {
		const second = Math.floor(Number(t))
		bySecond[second] = Math.max(bySecond[second] ?? -99, level === '-inf' ? -99 : Number(level))
	}
	return Array.from(bySecond, (level) => ((level ?? -99) <= -70 ? 'off' : Math.round(level))).join(' ')
}

function partDir(partFile: string) {
	return join(dirname(resolve(partFile)), basename(partFile, '.json'))
}

async function readTiming(dir: string): Promise<Timing> {
	const file = join(dir, 'timing.json')
	if (!existsSync(file)) throw new Error(`${file} is missing: run narrate first`)
	return Bun.file(file).json()
}

type Cue = { t: number; sound: string; gain: number; pitch?: number; pan?: number; at?: 'peak' | 'start' }
type FilmState = {
	duration: number
	cues: Cue[]
	audio: { music?: string; musicGain: number; narrationGain: number; effectsGain?: number; dips: { from: number; to: number; gain: number }[] }
	/** A fingerprint of the composition as loaded, so a render knows which version drew each chunk. */
	source: string
}

/**
 * The clip a composition plays, made ready for frame-by-frame seeking: as it is when its
 * keyframes are close together, otherwise a copy, made once into `.seek/` beside it and reused
 * while the clip is unchanged. Each seek decodes from the keyframe before it, so a clip with
 * seconds between keyframes, as recorders and cameras write them, renders very slowly where video
 * is decoded in software (a server). A browser without H.264 (some Linux Chromium builds) gets a
 * VP9 copy. Near-lossless either way, so zooms stay sharp.
 */
async function seekableClip(clip: string, h264: boolean) {
	const copy = join(dirname(clip), '.seek', basename(clip).replace(/\.mp4$/, h264 ? '.mp4' : '.webm'))
	if (existsSync(copy) && Bun.file(copy).lastModified >= Bun.file(clip).lastModified) return copy
	if (h264) {
		// Keyframe times from the packet index, without decoding.
		const keys = (await $`ffprobe -v error -select_streams v -show_entries packet=pts_time,flags -of csv=p=0 ${clip}`.text())
			.split('\n')
			.flatMap((line) => (line.includes('K') ? [Number(line.split(',')[0])] : []))
		const gap = Math.max(0, ...keys.slice(1).map((t, i) => t - keys[i]), (await duration(clip)) - (keys.at(-1) ?? 0))
		if (gap <= 0.5) return clip
	}
	await mkdir(dirname(copy), { recursive: true })
	console.log(`making a seekable copy of ${basename(clip)} (once): ${h264 ? 'a keyframe every 0.25 s' : 'VP9, as this browser has no H.264'}`)
	const rate = (await $`ffprobe -v error -select_streams v -show_entries stream=r_frame_rate -of csv=p=0 ${clip}`.text()).trim().split('/').map(Number)
	const keyEvery = Math.max(1, Math.round(rate[0] / (rate[1] || 1) / 4))
	await (h264
		? $`ffmpeg -v error -y -i ${clip} -an -c:v libx264 -preset fast -crf 12 -g ${keyEvery} -pix_fmt yuv420p ${COLOR} -movflags +faststart ${copy}`
		: $`ffmpeg -v error -y -i ${clip} -an -c:v libvpx-vp9 -crf 16 -b:v 0 -deadline good -cpu-used 4 -row-mt 1 -g ${keyEvery} -pix_fmt yuv420p ${copy}`)
	return copy
}

/**
 * Loads a composition with GSAP, the film runtime, any narration timing and the marks of its
 * clips injected, at the size its `<meta name="film-size" content="1080x1920">` asks for
 * (1920x1080 by default), drawn at `scale` times the pixels.
 */
async function openComposition(htmlFile: string, scale = 1) {
	const source = resolve(htmlFile)
	const html = await readFile(source, 'utf8')
	const sizeMatch = html.match(/name="film-size"\s+content="(\d+)x(\d+)"/)
	const size = sizeMatch ? { width: Number(sizeMatch[1]), height: Number(sizeMatch[2]) } : SIZE

	const timingFile = join(source.replace(/\.html$/, ''), 'timing.json')
	const timing: Timing = existsSync(timingFile) ? await Bun.file(timingFile).json() : []
	const browser = await launchBrowser(nativeScale(size, scale))
	let page = await browser.newPage({ viewport: null })
	if (!(await fills(page, size, scale))) {
		await page.close()
		page = await browser.newPage({ viewport: size, deviceScaleFactor: scale })
	}

	// Each <video src="x.mp4">, with an `x.marks.json` beside it (from `live` or `crop`), played from a
	// copy that seeks fast when the clip needs one.
	const h264 = await page.evaluate(() => document.createElement('video').canPlayType('video/mp4; codecs="avc1.640033"') !== '')
	const clips: Record<string, ClipMarks> = {}
	let body = html
	for (const [, src] of html.matchAll(/<video\b[^>]*\ssrc="([^"]+\.mp4)"/g)) {
		const file = join(dirname(source), src.replace(/\.mp4$/, '.marks.json'))
		const marks = existsSync(file) ? await Bun.file(file).json() : undefined
		if (marks) clips[src] = marks
		const copy = await seekableClip(join(dirname(source), src), h264)
		const copySrc = relative(dirname(source), copy)
		if (copySrc === src) continue
		body = body.replaceAll(`src="${src}"`, `src="${copySrc}"`)
		if (marks) clips[copySrc] = marks
	}
	const gsapDir = join(SKILL_DIR, 'node_modules/gsap/dist')
	const head = [
		`<script>window.TIMING = ${JSON.stringify(timing.map(({ id, dur }) => ({ id, dur })))}; window.CLIPS = ${JSON.stringify(clips)}</script>`,
		...['gsap.min.js', 'SplitText.min.js', 'CustomEase.min.js'].map((file) => `<script src="file://${join(gsapDir, file)}"></script>`),
		...['film.js', 'lint.js'].map((file) => `<script src="file://${join(SKILL_DIR, file)}"></script>`),
		`<style>html, body { width: ${size.width}px; height: ${size.height}px; margin: 0; overflow: hidden; }</style>`
	].join('\n')

	// Written next to the source so relative asset paths keep working.
	const built = join(dirname(source), `.${basename(source, '.html')}.build.html`)
	await writeFile(built, body.replace(/<head>/i, `<head>\n${head}`))

	const errors: string[] = []
	page.on('pageerror', (error: Error) => errors.push(error.message))
	// Film helpers warn about things a viewer will see, such as a clip enlarged past its pixels.
	const warned = new Set<string>()
	page.on('console', (message: { type(): string; text(): string }) => {
		if (message.type() !== 'warning' || warned.has(message.text())) return
		warned.add(message.text())
		console.warn(message.text())
	})
	await page.goto(`file://${built}`)
	try {
		await page.waitForFunction(() => (window as unknown as { film?: { ready: boolean } }).film?.ready, undefined, { timeout: 30_000 })
	} catch {
		await browser.close()
		throw new Error(`the composition never became ready${errors.length ? `: ${errors.join('; ')}` : ' (did it call Film.create?)'}`)
	}

	const state = await page.evaluate(() => {
		const { duration, cues, audio } = (window as unknown as { film: FilmState }).film
		return { duration, cues, audio }
	})
	const film: FilmState = { ...state, source: Bun.hash(body + head).toString(36) }
	return { browser, page, film, size }
}

/** Seeks the film and waits for the frame to be painted. */
async function seekFrame(page: { evaluate: (fn: (t: number) => Promise<void>, t: number) => Promise<void> }, t: number) {
	await page.evaluate(async (time) => {
		await (window as unknown as { film: { seek(t: number): Promise<void> } }).film.seek(time)
		await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
	}, t)
}

/**
 * Mixes narration (from `<part>.json`), music ducked under it, and the sound cues into one
 * track of the film's length, mastered to about -14 LUFS (-16 when narrated).
 *
 * Effects are placed and levelled by measurement, since nobody in the loop hears them: each
 * cue's loudest moment lands on its time, and the whole effects bus is set against the bed (the
 * music, or the voice) so a 0 dB cue sits in the mix whatever the music's level. Prints each
 * cue's level against what plays under it, and writes `<part>/sound.png`, a picture of the mix.
 */
async function mixAudio(htmlFile: string, film: FilmState) {
	const source = resolve(htmlFile)
	const base = dirname(source)
	const dir = source.replace(/\.html$/, '')
	const length = round(film.duration)
	const out = join(dir, 'mix.wav')

	// The bed: narration and music, the music ducked while someone speaks.
	const inputs: string[] = []
	const filters: string[] = []
	const beds: string[] = []
	const timingFile = join(dir, 'timing.json')
	const narrated = existsSync(timingFile)
	if (narrated) {
		const timing: Timing = await Bun.file(timingFile).json()
		inputs.push('-i', await buildNarration(dir, timing, timing.map((scene) => scene.dur)))
		filters.push(`[0:a]volume=${film.audio.narrationGain}dB,asplit=2[voice][key]`)
		beds.push('[voice]')
	}

	// Missing audio is left out with a warning, so the picture can be built and checked before the
	// sound exists; `render --audio-only` adds it once it does.
	const music = film.audio.music && resolve(base, film.audio.music)
	if (music && !existsSync(music)) console.warn(`music ${film.audio.music} is missing; rendering without it`)
	if (music && existsSync(music)) {
		const index = inputs.length / 2
		inputs.push('-i', music)
		const fadeOut = Math.max(length - 1.5, 0)
		// Each dip ramps over 60 ms at both ends, so it never clicks.
		const dips = film.audio.dips
			.map(({ from, to, gain }) => {
				const depth = 1 - 10 ** (gain / 20)
				return `,volume='1-${depth}*clip(min((t-${from})/0.06\,(${to}-t)/0.06)\,0\,1)':eval=frame`
			})
			.join('')
		filters.push(`[${index}:a]aresample=48000,atrim=0:${length},afade=t=in:d=0.02,afade=t=out:st=${fadeOut}:d=1.5,volume=${film.audio.musicGain}dB${dips}[music]`)
		if (narrated) {
			// The music dips while someone speaks.
			filters.push('[music][key]sidechaincompress=threshold=0.02:ratio=6:attack=20:release=400[ducked]')
			beds.push('[ducked]')
		} else {
			beds.push('[music]')
		}
	} else if (narrated) {
		filters.push('[key]anullsink')
	}

	const bedFile = join(dir, 'bed.wav')
	let bed: Stereo | null = null
	let bedLoudness = Number.NaN
	if (beds.length > 0) {
		filters.push(`${beds.join('')}amix=inputs=${beds.length}:normalize=0:duration=longest,apad=whole_dur=${length},atrim=0:${length}[out]`)
		await $`ffmpeg -v error -y ${inputs} -filter_complex ${filters.join(';')} -map ${'[out]'} -c:a pcm_f32le ${bedFile}`
		bed = await readAudio(bedFile)
		const measured = (await $`ffmpeg -hide_banner -i ${bedFile} -af ebur128 -f null -`.nothrow().quiet()).stderr.toString()
		bedLoudness = Number(measured.slice(measured.lastIndexOf('Summary:')).match(/I:\s+(-?[0-9.]+)/)?.[1])
	}

	// The effects bus. With a bed, a reference-level sound at 0 dB lands at the music's own
	// loudness (8 dB under a voice), so the kit's designed levels put a click or a whoosh just
	// inside the mix; `effectsGain` moves them all.
	const cards = new Map<string, { file: string; card: SoundCard }>()
	const missing = new Set<string>()
	for (const sound of new Set(film.cues.map((cue) => cue.sound))) {
		const file = ['wav', 'mp3'].map((ext) => join(base, 'sfx', `${sound}.${ext}`)).find((path) => existsSync(path))
		if (file) cards.set(sound, { file, card: soundCard(await readAudio(file)) })
		else missing.add(sound)
	}
	if (missing.size > 0) console.warn(`no sfx/ file for ${[...missing].join(', ')}; those cues are silent (run: sfx --kit ${join(base, 'sfx')})`)

	const audible = Number.isFinite(bedLoudness) && bedLoudness > -60
	const bus = (audible ? bedLoudness - (narrated ? 8 : 0) - REFERENCE_LEVEL : 0) + (film.audio.effectsGain ?? 0)
	const cueInputs: string[] = []
	const cueFilters: string[] = []
	const placed = film.cues.filter((cue) => cards.has(cue.sound) && cue.t <= length)
	for (const [i, cue] of placed.entries()) {
		const { file, card } = cards.get(cue.sound)!
		const speed = 2 ** ((cue.pitch ?? 0) / 12)
		// The sound's loudest moment lands on the cue; a sound that would start before the film is cut in.
		const start = cue.t - (cue.at === 'start' ? 0 : card.anchor / speed)
		const pan = Math.max(-1, Math.min(1, cue.pan ?? 0))
		cueInputs.push('-i', file)
		cueFilters.push(
			[
				`[${i}:a]aresample=48000,aformat=channel_layouts=stereo`,
				speed !== 1 && `asetrate=${Math.round(48000 * speed)},aresample=48000`,
				start < 0 && `atrim=start=${-start},asetpts=PTS-STARTPTS,afade=t=in:d=0.01`,
				pan !== 0 && `pan=stereo|c0=${Math.min(1, 1 - pan)}*c0|c1=${Math.min(1, 1 + pan)}*c1`,
				`volume=${round(cue.gain + bus)}dB`,
				`adelay=${Math.round(Math.max(start, 0) * 1000)}:all=1[cue${i}]`
			]
				.filter(Boolean)
				.join(',')
		)
	}
	const effectsFile = join(dir, 'effects.wav')
	if (placed.length > 0) {
		cueFilters.push(`${placed.map((_, i) => `[cue${i}]`).join('')}amix=inputs=${placed.length}:normalize=0:duration=longest,apad=whole_dur=${length},atrim=0:${length}[out]`)
		await $`ffmpeg -v error -y ${cueInputs} -filter_complex ${cueFilters.join(';')} -map ${'[out]'} -c:a pcm_f32le ${effectsFile}`
	}

	if (!bed && placed.length === 0) {
		await $`ffmpeg -v error -y -f lavfi -t ${length} -i anullsrc=r=48000:cl=stereo ${out}`
		return out
	}

	// What each effect plays against: the agent's ears.
	if (placed.length > 0) {
		console.log(`effects (${placed.length}), each with its level against ${bed ? 'the bed under it' : 'full scale'}; a 0 dB cue is set to sit in the mix:`)
		for (const cue of placed) {
			const { card } = cards.get(cue.sound)!
			const level = card.level + cue.gain + bus
			const under = bed ? levelBetween(bed, cue.t - 0.15, cue.t + 0.25) : Number.NaN
			const dipped = film.audio.dips.some(({ from, to }) => cue.t >= from - 0.1 && cue.t <= to + 0.3)
			const over = level - under
			// Under a voice the effects are meant to sit 8 dB lower, so that is not "buried".
			const meant = narrated ? -8 : 0
			const verdict = dipped ? ' (the music is dipped here)' : over > meant + 12 ? ': stands far out, lower its gain' : over < meant - 12 ? ': buried, raise its gain' : ''
			const note = !bed ? `${level.toFixed(0)} dBFS` : under < -55 ? 'over silence' : `${over >= 0 ? '+' : ''}${over.toFixed(0)} dB${verdict}`
			console.log(`  ${cue.t.toFixed(2).padStart(6)}s ${cue.sound.padEnd(8)} ${note}`)
		}
	}

	const premix = join(dir, 'premix.wav')
	if (bed && placed.length > 0) await $`ffmpeg -v error -y -i ${bedFile} -i ${effectsFile} -filter_complex amix=inputs=2:normalize=0:duration=longest -c:a pcm_f32le ${premix}`
	else await copyFile(bed ? bedFile : effectsFile, premix)

	if (!audible) {
		// Effects alone: nothing to master against, so they keep their designed levels.
		await $`ffmpeg -v error -y -i ${premix} -af alimiter=limit=0.7:level=false -c:a pcm_s16le ${out}`
	} else {
		// Two-pass, linear loudness normalisation: one gain for the whole film, so the dips and
		// builds survive. Single-pass loudnorm compresses dynamically and flattens them. The limiter
		// sits at -3 dBFS because AAC encoding adds over 1 dB of inter-sample peaks on top.
		const target = narrated ? -16 : -14
		const measure = await $`ffmpeg -hide_banner -i ${premix} -af loudnorm=I=${target}:TP=-1.5:LRA=20:print_format=json -f null -`.nothrow().quiet()
		const stats = JSON.parse(measure.stderr.toString().match(/\{[\s\S]*?\}/)![0])
		const normalize = `loudnorm=I=${target}:TP=-1.5:LRA=20:linear=true:measured_I=${stats.input_i}:measured_TP=${stats.input_tp}:measured_LRA=${stats.input_lra}:measured_thresh=${stats.input_thresh}:offset=${stats.target_offset}`
		await $`ffmpeg -v error -y -i ${premix} -af ${normalize},aresample=48000,alimiter=limit=0.7:level=false -c:a pcm_s16le ${out}`
	}
	console.log(`sound picture: ${await soundPicture(out, join(dir, 'sound.png'), length, placed, film.audio.dips)}`)
	return out
}

/**
 * A picture of a mix to read instead of listening: its spectrum over time (pitch upward, loudness
 * as brightness) with a line and a name at every cue and a band over every music dip, so a cue
 * that lands off its event, a quiet start or a missing dead stop shows.
 */
async function soundPicture(audio: string, out: string, seconds: number, cues: Cue[], dips: { from: number; to: number }[]) {
	const width = 1880
	const spectrum = `${out}.spectrum.png`
	await $`ffmpeg -v error -y -i ${audio} -lavfi showspectrumpic=s=${width}x420:legend=0:scale=log:fscale=log:color=magma ${spectrum}`
	const x = (t: number) => 20 + (t / seconds) * width
	const every = seconds > 60 ? 10 : seconds > 20 ? 2 : 1
	const marks = [
		...Array.from({ length: Math.floor(seconds / every) + 1 }, (_, i) => `<i style="left:${x(i * every)}px;top:440px;height:8px;background:#999"></i><b style="left:${x(i * every) - 20}px;top:452px;width:40px;text-align:center;color:#999">${i * every}s</b>`),
		...dips.map(({ from, to }) => `<i style="left:${x(from)}px;top:20px;width:${x(to) - x(from)}px;height:420px;background:rgba(80,160,255,.25)"></i>`),
		...cues.map(({ t, sound }, i) => `<i style="left:${x(t)}px;top:20px;height:420px;background:#3dff9e"></i><b style="left:${x(t) + 4}px;top:${22 + (i % 4) * 16}px;color:#3dff9e">${sound}</b>`)
	]
	const html = `${out}.html`
	await writeFile(html, `<!doctype html><body style="margin:0;background:#111;font:600 13px/1 monospace"><img src="file://${resolve(spectrum)}" style="position:absolute;left:20px;top:20px"><style>i,b{position:absolute;width:2px;white-space:nowrap;font-style:normal}</style>${marks.join('')}</body>`)
	const browser = await launchBrowser()
	const page = await browser.newPage({ viewport: { width: width + 40, height: 480 } })
	await page.goto(`file://${resolve(html)}`)
	await page.screenshot({ path: out })
	await browser.close()
	await Promise.all([spectrum, html].map((file) => rm(file, { force: true })))
	return out
}

/** Stalled frame numbers grouped into stretches with under 15 frames between them, with the gaps. */
function judderStretches(frames: number[]) {
	const stretches: { frames: [number, number]; count: number; gaps: number[] }[] = []
	for (const frame of frames) {
		const last = stretches.at(-1)
		if (last && frame - last.frames[1] < 15) {
			last.gaps.push(frame - last.frames[1])
			last.frames[1] = frame
			last.count++
		} else stretches.push({ frames: [frame, frame], count: 1, gaps: [] })
	}
	// A single stall is a held frame by design (an eased landing); a run of them is judder.
	return stretches.filter((stretch) => stretch.count >= 3)
}

/** Stretches where the frame difference stays under `threshold`, as [start, end] seconds. */
function frozenStretches(diffs: number[], threshold: number, rate: number) {
	const stretches: [number, number][] = []
	let start = -1
	for (const [i, diff] of [...diffs, Number.POSITIVE_INFINITY].entries()) {
		if (diff < threshold && start < 0) start = i
		if (diff >= threshold && start >= 0) {
			if (i - start >= 2) stretches.push([start / rate, i / rate])
			start = -1
		}
	}
	return stretches
}

/**
 * Generates a music bed with ElevenLabs Music: `music <out.mp3> --seconds 30 --prompt "..."`.
 * Prints short-term loudness per second, so a slow intro or an early fade shows up.
 */
async function music(output: string, ...rest: string[]) {
	const { values } = parseArgs({ args: rest, options: { seconds: { type: 'string' }, prompt: { type: 'string' } } })
	if (!output || !values.seconds || !values.prompt) throw new Error('usage: music <out.mp3> --seconds 30 --prompt "..."')
	const key = await requireKey()

	// Generated tracks often open with near-silence; ask for extra, drop the quiet start, cut to length.
	const seconds = Number(values.seconds)
	const body = { prompt: values.prompt, music_length_ms: Math.round((seconds + 4) * 1000) }
	const raw = join(tmpdir(), `music-${basename(output)}`)
	await Bun.write(raw, await elevenLabs(`${ELEVENLABS}/music?output_format=mp3_44100_192`, key, body))
	await $`ffmpeg -v error -y -i ${raw} -af silenceremove=start_periods=1:start_threshold=-45dB,atrim=0:${seconds},afade=t=in:d=0.005 -b:a 192k ${output}`

	const loud = (await $`ffmpeg -hide_banner -i ${output} -af ebur128 -f null -`.nothrow().quiet()).stderr.toString()
	console.log(`${output} (${round(await duration(output))}s)\nloudness by second: ${loudnessBySecond(loud)}`)
}

/**
 * Sound effects. `sfx --kit <dir>` writes the designed kit (click, tick, pop, whoosh, swipe, hit,
 * shimmer), synthesized here: no key, the same on every run, each at the level it should sit at.
 * `sfx <out.wav> "<description>" [--seconds 0.6]` generates one the kit lacks with ElevenLabs and
 * prepares it the same way: silence cut so it starts on its cue, rumble removed, set to the kit's
 * level without limiting. Both print each sound's measurements.
 */
async function sfx(...rest: string[]) {
	const { values, positionals } = parseArgs({
		args: rest,
		allowPositionals: true,
		options: { kit: { type: 'string' }, seconds: { type: 'string' } }
	})
	if (values.kit) {
		await mkdir(values.kit, { recursive: true })
		for (const [name, what] of Object.entries(KIT_SOUNDS)) {
			const sound = kitSound(name)
			await Bun.write(join(values.kit, `${name}.wav`), wav(sound))
			// An effect of the same name from an older kit would otherwise sit beside the new one.
			await rm(join(values.kit, `${name}.mp3`), { force: true })
			console.log(`${name.padEnd(8)} ${what}\n         ${describeSound(soundCard(sound))}`)
		}
		return
	}

	const [output, ...words] = positionals
	const text = words.join(' ')
	if (!output || !text) throw new Error('usage: sfx --kit <dir> | sfx <out.wav> "<description>" [--seconds 0.6]')
	const key = await requireKey()
	const seconds = Number(values.seconds ?? 0.6)
	await mkdir(dirname(resolve(output)), { recursive: true })

	// The API's shortest effect is 0.5 s; the sound is cut to length after its silence is trimmed.
	const body = { text, duration_seconds: Math.max(seconds, 0.5), prompt_influence: 0.6 }
	const raw = join(tmpdir(), `sfx-${process.pid}.mp3`)
	// 192 kbps needs a paid tier; the default bitrate is the fallback.
	const generated = await elevenLabs(`${ELEVENLABS}/sound-generation?output_format=mp3_44100_192`, key, body).catch(() => elevenLabs(`${ELEVENLABS}/sound-generation`, key, body))
	await Bun.write(raw, generated)
	const sound = atLevel(trimmed(withoutRumble(await readAudio(raw)), -45, seconds), REFERENCE_LEVEL - 2)
	await rm(raw)

	if (output.endsWith('.wav')) await Bun.write(output, wav(sound))
	else {
		const lossless = `${raw}.wav`
		await Bun.write(lossless, wav(sound))
		await $`ffmpeg -v error -y -i ${lossless} -b:a 192k ${output}`
		await rm(lossless)
	}
	console.log(`${output}\n${describeSound(soundCard(sound))}`)
}

/** Pads each scene's audio to the scene's on-screen length and joins them into one track. */
async function buildNarration(dir: string, timing: Timing, durations: number[]) {
	const inputs = timing.flatMap((scene) => ['-i', scene.audio])
	const filters = timing.map(
		(_, i) =>
			`[${i}:a]aresample=48000,aformat=channel_layouts=stereo,apad=whole_dur=${durations[i]},atrim=0:${durations[i]}[a${i}]`
	)
	const joined = timing.map((_, i) => `[a${i}]`).join('')
	filters.push(`${joined}concat=n=${timing.length}:v=0:a=1[out]`)

	const out = join(dir, 'narration.wav')
	await $`ffmpeg -v error -y ${inputs} -filter_complex ${filters.join(';')} -map ${'[out]'} -c:a pcm_s16le ${out}`
	return out
}

async function chromium() {
	const installed = ['playwright-core', 'gsap'].every((name) => existsSync(join(SKILL_DIR, 'node_modules', name)))
	if (!installed) await $`bun install`.cwd(SKILL_DIR).quiet()
	return (await import(join(SKILL_DIR, 'node_modules/playwright-core/index.mjs'))).chromium
}

/** `sudo ` unless already root, for the install hints. */
function asRoot() {
	return process.getuid?.() === 0 ? '' : 'sudo '
}

/** A window can open here: macOS or Windows, or Linux with a display server. */
function hasDisplay() {
	return process.platform !== 'linux' || Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY)
}

/**
 * Starts the browser through `launch`: installed Google Chrome first, otherwise Playwright's
 * Chromium, downloaded on first use (Linux on ARM has no Google Chrome). As root, as on many
 * servers and containers, Chrome only starts without its sandbox. `own.args` are flags only
 * Playwright's Chromium takes; `own.used` tells the caller it is the one that started.
 */
async function startBrowser<T>(launch: (options: Record<string, unknown>) => Promise<T>, options: Record<string, unknown> = {}, own: { args: string[]; used?: boolean } = { args: [] }): Promise<T> {
	const chrome = { ...options, ...(process.getuid?.() === 0 && { chromiumSandbox: false }) }
	try {
		return await launch({ ...chrome, channel: 'chrome' })
	} catch (error) {
		if (/ProcessSingleton|in use/.test(String(error))) throw new Error('the video profile is already open in another window; close it first')
	}
	const settings = { ...chrome, args: [...((chrome as { args?: string[] }).args ?? []), ...own.args] }
	own.used = true
	try {
		return await launch(settings)
	} catch (error) {
		const message = String(error)
		// A container without user namespaces has no sandbox for Chrome to use.
		if (/No usable sandbox|sandbox/i.test(message) && chrome.chromiumSandbox !== false) return startBrowser(launch, { ...options, chromiumSandbox: false }, own)
		if (/Executable doesn't exist|install/i.test(message) && !/install-deps|dependencies/i.test(message)) {
			console.warn('Google Chrome is not installed; downloading Playwright Chromium once (about 150 MB)')
			await $`bun ${join(SKILL_DIR, 'node_modules/playwright-core/cli.js')} install chromium`.cwd(SKILL_DIR)
			return launch(settings)
		}
		if (/shared librar|dependencies|install-deps/i.test(message)) {
			throw new Error(`Chromium is missing system libraries: run \`bun video.ts doctor --fix\``)
		}
		throw error
	}
}

async function launchBrowser(args: string[] = []) {
	const browser = await chromium()
	return startBrowser((options) => browser.launch(options), { args })
}

/**
 * The flags that make a headless browser itself draw at `scale`, in a window the size of the
 * page. A page that only emulates its scale is drawn again for every screenshot, which costs
 * about half again as much per frame.
 */
function nativeScale(size: { width: number; height: number }, scale: number) {
	return [`--force-device-scale-factor=${scale}`, `--window-size=${size.width},${size.height}`]
}

/** Whether the page has the size and pixel density asked for without emulating them. */
function fills(page: { evaluate<T, A>(fn: (arg: A) => T, arg: A): Promise<T> }, size: { width: number; height: number }, scale: number) {
	return page.evaluate(([width, height, ratio]) => innerWidth === width && innerHeight === height && devicePixelRatio === ratio, [size.width, size.height, scale])
}

/**
 * Reads a website for a film in one pass, into `<out>` (default `assets/site` in the current
 * folder): the brand (`brand.json`: colours, type, buttons, headings, meta), the logo, the web
 * fonts with a ready `fonts.css`, a 2x screenshot of the first screen and of every section, and a
 * short summary on stdout. Uses the video profile, so a signed-in app works too.
 * `site <url> [--out dir] [--headed]`
 */
async function site(url: string, ...rest: string[]) {
	if (!url) throw new Error('usage: site <url> [--out assets/site] [--headed]')
	const { values } = parseArgs({ args: rest, options: { out: { type: 'string' }, headed: { type: 'boolean' } } })
	const out = resolve(values.out ?? 'assets/site')
	await rm(out, { recursive: true, force: true })
	await mkdir(out, { recursive: true })
	const { context, page } = await openProfile({ headless: !values.headed, viewport: SIZE, scale: 2 })
	try {
		await page.goto(url, { waitUntil: 'networkidle', timeout: 45_000 }).catch(() => page.waitForLoadState('load'))
		// A consent banner would sit on every screenshot.
		for (const name of [/^(accept|allow|agree)( all)?( cookies)?$/i, /^(tillad|accepter)( alle)?$/i, /^(ok|got it)$/i]) {
			const button = page.getByRole('button', { name }).first()
			if (await button.isVisible().catch(() => false)) {
				await button.click().catch(() => {})
				break
			}
		}
		await page.waitForTimeout(1000)

		const brand = await page.evaluate(() => {
			const pick = (el: Element | null, ...props: string[]) => {
				if (!el) return null
				const style = getComputedStyle(el)
				return Object.fromEntries(props.map((prop) => [prop, style.getPropertyValue(prop)]))
			}
			const text = (el: Element) => (el as HTMLElement).innerText.trim().replace(/\s+/g, ' ')
			const visible = (el: Element) => el.getBoundingClientRect().width > 0 && getComputedStyle(el).visibility !== 'hidden'
			const buttons = [...document.querySelectorAll('a, button')].filter((el) => visible(el) && text(el).length > 1 && text(el).length < 30)
			const filled = buttons.filter((el) => !/rgba\(0, 0, 0, 0\)|transparent/.test(getComputedStyle(el).backgroundColor))
			// In order of trust: the home link in the header, then anything named logo. Hidden
			// elements (a loading spinner, a mobile menu) do not count.
			const logo = ['header a[href="/"]', 'nav a[href="/"]', 'a[href="/"]', '[class*=logo]', '[id*=logo]']
				.flatMap((scope) => [...document.querySelectorAll(`${scope} img, ${scope} svg, img${scope}, svg${scope}`)])
				.find((el) => visible(el) && el.getBoundingClientRect().top < 200)
			const meta = (name: string) => document.querySelector(`meta[property="${name}"], meta[name="${name}"]`)?.getAttribute('content') ?? undefined
			return {
				title: document.title,
				description: meta('description'),
				ogImage: meta('og:image'),
				lang: document.documentElement.lang,
				body: pick(document.body, 'background-color', 'color', 'font-family', 'font-size'),
				h1: pick(document.querySelector('h1'), 'color', 'font-family', 'font-weight', 'font-size', 'letter-spacing', 'line-height'),
				h2: pick(document.querySelector('h2'), 'color', 'font-family', 'font-weight', 'font-size', 'letter-spacing'),
				primaryButton: filled[0] && { text: text(filled[0]), ...pick(filled[0], 'background-color', 'color', 'border-radius', 'font-weight', 'font-family') },
				fonts: [...new Set([...document.fonts].filter((font) => font.status === 'loaded').map((font) => `${font.family.replace(/"/g, '')} ${font.weight}`))],
				logo: logo?.tagName === 'svg' ? { svg: logo.outerHTML } : logo ? { src: (logo as HTMLImageElement).currentSrc || (logo as HTMLImageElement).src } : null,
				headings: [...document.querySelectorAll('h1, h2, h3')].filter(visible).map(text).slice(0, 60),
				stylesheets: [...document.querySelectorAll('link[rel=stylesheet]')].map((link) => (link as HTMLLinkElement).href),
				inlineCss: [...document.querySelectorAll('style')].map((style) => style.textContent ?? '').join('\n')
			}
		})

		// The logo, as the site serves it.
		const lines: string[] = []
		if (brand.logo && 'svg' in brand.logo) {
			await writeFile(join(out, 'logo.svg'), brand.logo.svg)
			lines.push('logo: logo.svg (inline svg)')
		} else if (brand.logo?.src) {
			const response = await fetch(brand.logo.src)
			const ext = brand.logo.src.split('?')[0].split('.').pop()?.slice(0, 4) || 'png'
			await writeFile(join(out, `logo.${ext}`), Buffer.from(await response.arrayBuffer()))
			lines.push(`logo: logo.${ext} (${brand.logo.src})`)
		} else lines.push('logo: none found in the header; look on /brand or /press')

		// The web fonts the page uses, read from its stylesheets (the browser may not expose
		// cross-origin rules), downloaded with an @font-face file pointing at the copies.
		const used = new Set(brand.fonts.map((font: string) => font.replace(/ [\d ]+$/, '').toLowerCase()))
		const sheets = [brand.inlineCss]
		for (const href of brand.stylesheets) {
			sheets.push(await fetch(href, { headers: { 'user-agent': 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/130 Safari/537.36' } }).then((r) => r.text(), () => ''))
		}
		const faces: string[] = []
		const files = new Map<string, string>()
		for (const [index, css] of sheets.entries()) {
			const base = index === 0 ? url : brand.stylesheets[index - 1]
			for (const face of css.match(/@font-face\s*{[^}]*}/g) ?? []) {
				const family = face.match(/font-family:\s*['"]?([^;'"]+)/)?.[1]?.trim()
				const source = face.match(/url\(\s*['"]?([^'")]+\.woff2[^'")]*)/)?.[1]
				const range = face.match(/unicode-range:\s*([^;]+)/)?.[1]
				// Latin only: the other subsets of a Google font add files no film needs.
				if (!family || !source || !used.has(family.toLowerCase()) || (range && !/U\+0000/.test(range))) continue
				const absolute = new URL(source, base).href
				if (!files.has(absolute)) {
					const name = `${family.toLowerCase().replace(/\W+/g, '-')}-${files.size}.woff2`
					const response = await fetch(absolute)
					if (!response.ok) continue
					await writeFile(join(out, name), Buffer.from(await response.arrayBuffer()))
					files.set(absolute, name)
				}
				faces.push(face.replace(/src:[^;]+;/, `src: url('${files.get(absolute)}') format('woff2');`))
			}
		}
		if (faces.length) await writeFile(join(out, 'fonts.css'), `${faces.join('\n')}\n`)
		lines.push(faces.length ? `fonts: fonts.css (${files.size} files) for ${[...used].join(', ')}` : `fonts: none downloadable; used: ${brand.fonts.join(', ')}`)

		const { stylesheets, inlineCss, logo, ...kept } = brand
		await writeFile(join(out, 'brand.json'), JSON.stringify(kept, null, 2))

		// The first screen, then each section of the page on its own, after its entrance animation.
		await page.screenshot({ path: join(out, '00-first-screen.png'), scale: 'device' })
		const sections = page.locator('main > section, body > section, main > div > section, [class*=section]:not([class*=section] [class*=section])')
		let saved = 0
		for (let index = 0; index < (await sections.count()) && saved < 14; index++) {
			const section = sections.nth(index)
			const box = await section.boundingBox()
			if (!box || box.height < 250 || box.height > 2600) continue
			await section.scrollIntoViewIfNeeded().catch(() => {})
			await page.waitForTimeout(900)
			const heading = (await section.locator('h1, h2, h3').first().innerText().catch(() => '')).replace(/\s+/g, ' ').trim()
			const slug = heading.toLowerCase().replace(/[^a-z0-9æøå]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'section'
			const file = `${String(++saved).padStart(2, '0')}-${slug}.png`
			await section.screenshot({ path: join(out, file), scale: 'device' })
			lines.push(`${file}  ${Math.round(box.height)} px tall${heading ? `  "${heading}"` : ''}`)
		}

		console.log(
			[
				`${brand.title} (${brand.lang || 'no lang'})`,
				`colors: background ${brand.body?.['background-color']}, text ${brand.body?.color}, button ${brand.primaryButton?.['background-color']} on ${brand.primaryButton?.color} radius ${brand.primaryButton?.['border-radius']}`,
				`type: headings ${brand.h1?.['font-family']} ${brand.h1?.['font-weight']} ${brand.h1?.['font-size']} (${brand.h1?.['letter-spacing']}), body ${brand.body?.['font-family']}`,
				...lines,
				`${out}/brand.json has the headings, meta and computed styles.`
			].join('\n')
		)
	} finally {
		await context.close()
	}
}

/**
 * Chrome with the skill's own profile, so a sign-in made once with `browse` holds for every
 * take in every repository. It is separate from the user's everyday Chrome profile.
 * `VIDEO_PROFILE` points it elsewhere, for example a second account.
 */
function profileDir() {
	return process.env.VIDEO_PROFILE ?? join(homedir(), '.cache/product-video/chrome')
}

/** The sign-ins as plain cookies and storage: Chrome encrypts its own per machine, so a copied profile would not carry them. */
function stateFile() {
	return `${profileDir()}-state.json`
}

/**
 * Opens the video profile. `recording` is for a take: a headless browser then draws at the
 * scale itself instead of emulating it. `stepped` are the flags for drawing a frame only when
 * asked (`STEPPED_ARGS` in live.mjs); the result's `stepped` says whether the browser that
 * started takes them, which Playwright's Chromium does and Google Chrome does not.
 */
async function openProfile(options: { headless?: boolean; viewport?: { width: number; height: number } | null; scale?: number; recording?: boolean; stepped?: string[] }) {
	const profile = profileDir()
	await mkdir(profile, { recursive: true })
	// Headless where no window can open, as on a server.
	const headless = options.headless ?? !hasDisplay()
	const scale = options.scale ?? 1
	// A window has its own frame and the screen's size, so only a headless browser can be given both.
	const native = headless && options.recording && options.viewport
	const launch = {
		headless,
		viewport: native ? null : (options.viewport ?? null),
		...(options.viewport && !native && { deviceScaleFactor: scale }),
		// Without the automation banner and flag, sign-in pages treat it as the normal browser it is.
		ignoreDefaultArgs: ['--enable-automation'],
		args: ['--disable-blink-features=AutomationControlled', ...(native ? nativeScale(native, scale) : [])]
	}
	const own = { args: (native && options.stepped) || [], used: false }
	const browser = await chromium()
	const context = await startBrowser((settings) => browser.launchPersistentContext(profile, settings), launch, own)
	const page = context.pages()[0] ?? (await context.newPage())
	if (native && !(await fills(page, native, scale))) {
		await context.close()
		return openProfile({ ...options, recording: false })
	}
	await importSignIns(context)
	return { context, page, stepped: own.used && own.args.length > 0 }
}

/**
 * Loads the sign-ins `browse` saved (on this machine or copied from another, such as a desktop to
 * a server) when the file is newer than the last import, so a fresh login always wins.
 */
async function importSignIns(context: { addCookies(cookies: unknown[]): Promise<void>; addInitScript(script: unknown, arg: unknown): Promise<void> }) {
	const file = stateFile()
	const marker = join(profileDir(), '.state-imported')
	if (!existsSync(file)) return
	const state = await Bun.file(file).json()
	// Storage first, on every launch: it is cheap and only fills keys the page has not set itself.
	await context.addInitScript((origins: { origin: string; localStorage: { name: string; value: string }[] }[]) => {
		const saved = origins.find((entry) => entry.origin === location.origin)
		for (const { name, value } of saved?.localStorage ?? []) if (localStorage.getItem(name) === null) localStorage.setItem(name, value)
	}, state.origins ?? [])
	// Session cookies (no expiry) die with the browser, so the file is their only copy: always load
	// them. Lasting ones only when the file is newer than the last import, so a fresher login the
	// profile picked up since is not overwritten.
	const cookies: { expires: number }[] = state.cookies ?? []
	const fresh = !existsSync(marker) || Bun.file(marker).lastModified < Bun.file(file).lastModified
	const now = Date.now() / 1000
	await context.addCookies(cookies.filter((cookie) => cookie.expires === -1 || (fresh && cookie.expires > now)))
	if (!fresh) return
	await writeFile(marker, new Date().toISOString())
	console.log(`signed in from ${file}`)
}

/**
 * Opens the video profile's Chrome for the user to sign in (a Shopify admin, a staging app)
 * or look around, and waits until the window is closed. `browse [url]`
 */
async function browse(url?: string) {
	if (!hasDisplay()) {
		throw new Error(
			`no display on this machine, so no window to sign in with. Run \`browse\` on a computer with a screen, then copy ${stateFile().replace(homedir(), '~')} from it to the same path here; the next walk signs in from it.`
		)
	}
	const { context, page } = await openProfile({ headless: false })
	if (url) await page.goto(url)
	console.log(`Chrome is open with the video profile. Sign in where the video needs it, then close the window.\nThe sign-ins are also saved to ${stateFile()}, to copy to a server.`)
	// Saved while the window is open: once it closes, the browser can no longer be asked.
	const save = setInterval(() => context.storageState({ path: stateFile() }).catch(() => {}), 2000)
	await new Promise((resolve) => context.on('close', resolve))
	clearInterval(save)
	await writeFile(join(profileDir(), '.state-imported'), new Date().toISOString())
}

/**
 * Runs a walkthrough script in the video profile's Chrome at 1920x1080. The script's default
 * export gets `{ page, context, record }`; `record()` starts recording `<part>` (from the file
 * name `<part>.walk.mjs`), and after a take the part is assembled with `live`.
 * `walk <part>.walk.mjs [--rehearse] [--scale 2] [--headless] [--realtime]`. Any other script
 * name runs without recording, for exploring the app or taking screenshots.
 *
 * A headless take in Playwright's Chromium is recorded frame by frame (`frameDriver` in
 * live.mjs); `--realtime`, a window or Google Chrome records the page as it runs.
 */
async function walk(script: string, ...rest: string[]) {
	if (!script) throw new Error('usage: walk <part>.walk.mjs [--rehearse] [--scale 2] [--headless] [--realtime]')
	const { values } = parseArgs({ args: rest, options: { rehearse: { type: 'boolean' }, scale: { type: 'string' }, headless: { type: 'boolean' }, realtime: { type: 'boolean' } } })
	const part = script.endsWith('.walk.mjs') ? script.replace(/\.walk\.mjs$/, '.json') : null
	const { record, frameDriver, STEPPED_ARGS } = await import(join(SKILL_DIR, 'live.mjs'))
	// A take is stepped frame by frame where the browser can be; a rehearsal or an exploring
	// script runs the page as it is.
	const take = Boolean(part) && !values.rehearse
	const { context, page, stepped } = await openProfile({
		headless: values.headless,
		viewport: SIZE,
		scale: Number(values.scale ?? 2),
		recording: take,
		...(take && !values.realtime && { stepped: STEPPED_ARGS })
	})

	let recording: { stop(): Promise<unknown> } | undefined
	let driver: { close(): Promise<void> } | null = null
	try {
		if (stepped) {
			driver = await frameDriver(page)
			if (!driver) throw new Error('the browser did not hand over its frames: record with --realtime')
		}
		const { default: run } = await import(resolve(script))
		await run({
			page,
			context,
			async record(options = {}) {
				if (!part) throw new Error('name the script <part>.walk.mjs to record that part')
				recording = await record(page, partDir(part), { rehearse: values.rehearse, driver, ...options })
				if (take) console.log(driver ? 'recording frame by frame: the page moves at 60 fps in the video, however long a frame takes' : 'recording in real time: the page\'s own motion is captured as often as a screenshot allows')
				return recording
			}
		})
	} finally {
		if (recording) console.log(await recording.stop())
		await driver?.close()
		await context.close()
	}
	if (recording && part && !values.rehearse) await live(part)
}

/**
 * Checks this machine for everything the skill uses, such as a fresh server, and prints the fix
 * for each gap. Downloads Playwright Chromium when Google Chrome is missing. `--fix` runs the
 * system installs (apt, the browser's libraries) and checks again. Exits 1 when something
 * required is still missing.
 */
async function doctor(flag?: string) {
	const linux = process.platform === 'linux'
	const apt = Bun.which('apt-get') ? `${asRoot()}apt-get install -y` : 'install'
	const rows: [boolean | null, string, string?][] = []
	const add = (ok: boolean | null, what: string, fix?: string) => rows.push([ok, what, fix])

	add(true, `bun ${Bun.version} on ${process.platform}/${process.arch}${process.getuid?.() === 0 ? ' as root (Chrome runs without its sandbox)' : ''}`)

	const ffmpeg = Bun.which('ffmpeg')
	if (!ffmpeg) add(false, 'ffmpeg', linux ? `${apt} ffmpeg` : 'brew install ffmpeg')
	else {
		const encoders = await $`ffmpeg -hide_banner -encoders`.nothrow().text()
		const filters = await $`ffmpeg -hide_banner -filters`.nothrow().text()
		const missing = ['libx264', 'libvpx-vp9', 'aac'].filter((name) => !encoders.includes(name))
		missing.push(...['loudnorm', 'sidechaincompress', 'ebur128', 'tblend'].filter((name) => !filters.includes(name)))
		add(missing.length === 0, `ffmpeg ${missing.length ? `lacks ${missing.join(', ')}` : 'with x264, VP9 and the audio filters'}`, missing.length ? 'install a full ffmpeg build (the distro package or a static build)' : undefined)
		if (!Bun.which('ffprobe')) add(false, 'ffprobe', 'it ships with ffmpeg; put it on the PATH')
	}

	try {
		const browser = await launchBrowser()
		const page = await browser.newPage()
		const { h264, vp9 } = await page.evaluate(() => {
			const video = document.createElement('video')
			return { h264: video.canPlayType('video/mp4; codecs="avc1.640033"') !== '', vp9: video.canPlayType('video/webm; codecs="vp9"') !== '' }
		})
		add(true, `browser ${browser.version()}${h264 ? ' with H.264' : ''}`)
		if (!h264) add(vp9 ? null : false, vp9 ? 'no H.264 in this browser: compositions play VP9 copies of their clips (made once by render)' : 'the browser plays neither H.264 nor VP9', vp9 ? undefined : 'install Google Chrome')
		await browser.close()
	} catch (error) {
		add(false, `browser: ${String(error).split('\n')[0]}`, linux ? `${asRoot()}bun ${join(SKILL_DIR, 'node_modules/playwright-core/cli.js')} install-deps chromium` : 'install Google Chrome')
	}

	if (linux) {
		const fonts = Number((await $`fc-list`.nothrow().quiet().text()).trim().split('\n').filter(Boolean).length)
		add(fonts > 0, `${fonts} system fonts${fonts ? '' : ': text the brand fonts do not cover would render as boxes'}`, fonts ? undefined : `${apt} fonts-liberation fonts-dejavu-core fonts-noto-color-emoji`)
		const emoji = (await $`fc-list`.nothrow().quiet().text()).toLowerCase().includes('emoji')
		if (fonts && !emoji) add(null, 'no emoji font: emoji on a recorded page would render as boxes', `${apt} fonts-noto-color-emoji`)
	}

	add(hasDisplay() ? true : null, hasDisplay() ? 'a display: walk shows its window, browse can sign in' : 'no display: walk and site run headless; sign in with `browse` on a desktop and copy the sign-ins here (below)')
	const state = stateFile()
	add(existsSync(state) ? true : null, existsSync(state) ? `sign-ins saved in ${state.replace(homedir(), '~')}` : `no saved sign-ins (${state.replace(homedir(), '~')}); only needed for a product behind a login`)

	const key = await elevenLabsKey()
	add(key ? true : null, key ? 'ElevenLabs key (narration, music, effects)' : 'no ElevenLabs key: narration, music and effects need one', key ? undefined : 'printf %s "<key>" | bun video.ts set-key')
	const localVoice = process.platform === 'darwin' ? 'say' : 'espeak-ng'
	add(Bun.which(localVoice) ? true : null, `${localVoice} for narrate --say (drafts without a key)`, Bun.which(localVoice) ? undefined : `${apt} espeak-ng`)

	for (const [ok, what, fix] of rows) console.log(`${ok === true ? 'ok  ' : ok === false ? 'FAIL' : 'note'}  ${what}${fix ? `\n      fix: ${fix}` : ''}`)

	// The fixes that are installs; the key and the sign-ins are the user's to give.
	const installs = rows.flatMap(([, , fix]) => (fix && /apt-get install|install-deps|brew install/.test(fix) ? [fix] : []))
	if (flag === '--fix' && installs.length > 0) {
		if (installs.some((fix) => fix.includes('apt-get'))) await $`sh -c ${`${asRoot()}apt-get update -qq`}`
		// One apt run for every package, then the browser's libraries.
		const packages = installs.flatMap((fix) => (fix.includes('apt-get install') ? fix.split('apt-get install -y ')[1].split(' ') : []))
		if (packages.length) await $`sh -c ${`${asRoot()}env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ${packages.join(' ')}`}`
		for (const fix of installs.filter((entry) => !entry.includes('apt-get install'))) await $`sh -c ${fix}`
		console.log('\nchecking again:')
		return doctor()
	}
	if (installs.length > 0 && flag !== '--fix') console.log(`\n\`bun video.ts doctor --fix\` runs the installs above.`)
	if (rows.some(([ok]) => ok === false)) process.exit(1)
}

/** Stores the key from stdin in `$SKILL/.env` (mode 600) without printing it. */
async function setKey() {
	const key = (await Bun.stdin.text()).trim()
	if (!key) throw new Error('usage: printf %s "<key>" | bun video.ts set-key')

	const envFile = join(SKILL_DIR, '.env')
	const others = existsSync(envFile)
		? (await readFile(envFile, 'utf8')).split('\n').filter((line) => line && !line.startsWith('ELEVENLABS_API_KEY='))
		: []
	await writeFile(envFile, `${[...others, `ELEVENLABS_API_KEY=${key}`].join('\n')}\n`, { mode: 0o600 })
	await chmod(envFile, 0o600)
	console.log(`stored ElevenLabs key in ${envFile}`)
}

async function requireKey() {
	const key = await elevenLabsKey()
	if (key) return key
	console.error('NO_ELEVENLABS_KEY: ask the user for their ElevenLabs API key, then store it with `bun video.ts set-key` (key on stdin).')
	process.exit(2)
}

async function elevenLabs(url: string, key: string, body: unknown) {
	const response = await fetch(url, { method: 'POST', headers: { 'xi-api-key': key, 'content-type': 'application/json' }, body: JSON.stringify(body) })
	if (response.status === 401) throw new Error('ElevenLabs rejected the key (401): ask the user for a valid key and store it with `set-key`')
	if (!response.ok) throw new Error(`ElevenLabs ${response.status}: ${await response.text()}`)
	return response.arrayBuffer()
}

async function elevenLabsKey() {
	if (process.env.ELEVENLABS_API_KEY) return process.env.ELEVENLABS_API_KEY

	const envFile = join(SKILL_DIR, '.env')
	if (!existsSync(envFile)) return undefined
	const line = (await readFile(envFile, 'utf8')).split('\n').find((entry) => entry.startsWith('ELEVENLABS_API_KEY='))
	return line?.slice('ELEVENLABS_API_KEY='.length).trim().replace(/^["']|["']$/g, '') || undefined
}

async function speakElevenLabs(text: string, path: string, key: string) {
	const voice = process.env.VOICE ?? 'EXAVITQu4vr4xnSDxMaL' // Sarah, a premade voice every account has
	const url = `https://api.elevenlabs.io/v1/text-to-speech/${voice}?output_format=mp3_44100_128`
	const body = {
		text,
		// v4 Turbo ignores speed; Multilingual v2 honours 0.7-1.2, so SPEED picks it.
		model_id: process.env.MODEL ?? (process.env.SPEED ? 'eleven_multilingual_v2' : 'eleven_v4_turbo'),
		apply_text_normalization: 'on',
		...(process.env.SPEED ? { voice_settings: { speed: Number(process.env.SPEED) } } : {}),
		...(process.env.LANGUAGE ? { language_code: process.env.LANGUAGE } : {})
	}

	const response = await fetch(url, {
		method: 'POST',
		headers: { 'xi-api-key': key, 'content-type': 'application/json' },
		body: JSON.stringify(body)
	})
	if (response.status === 401) {
		throw new Error('ElevenLabs rejected the key (401): ask the user for a valid key and store it with `set-key`')
	}
	if (!response.ok) throw new Error(`ElevenLabs ${response.status}: ${await response.text()}`)

	await Bun.write(path, await response.arrayBuffer())
	return path
}

/** A local voice without a key: macOS `say`, or `espeak-ng` on Linux. Writes `<base>.aiff` or `.wav`. */
async function speakSay(text: string, base: string) {
	if (process.platform === 'darwin') {
		await $`say -v ${process.env.SAY_VOICE ?? 'Samantha'} -o ${`${base}.aiff`} ${text}`
		return `${base}.aiff`
	}
	if (!Bun.which('espeak-ng')) throw new Error('--say needs `say` (macOS) or `espeak-ng` (Linux: apt install espeak-ng)')
	await $`espeak-ng -v ${process.env.SAY_VOICE ?? 'en-us'} -s 160 -w ${`${base}.wav`} ${text}`
	return `${base}.wav`
}

async function duration(file: string) {
	return Number((await $`ffprobe -v error -show_entries format=duration -of csv=p=0 ${file}`.text()).trim())
}

/** Removes the cut spans from [start, end]; the remaining intervals are what the video shows. */
function withoutCuts(start: number, end: number, cuts: { start: number; end: number }[]) {
	let intervals = [[start, end]]
	for (const cut of cuts) {
		intervals = intervals.flatMap(([from, to]) => {
			if (cut.end <= from || cut.start >= to) return [[from, to]]
			return [
				[from, cut.start],
				[cut.end, to]
			].filter(([a, b]) => b - a > 0.001)
		})
	}
	return intervals
}

function timestamp(seconds: number) {
	const whole = Math.round(seconds)
	return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`
}

function round(seconds: number) {
	return Math.round(seconds * 1000) / 1000
}
