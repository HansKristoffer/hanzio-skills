#!/usr/bin/env bun
// Product videos: render HTML/GSAP compositions frame by frame, record live ego-browser
// walkthroughs, voice and score them with ElevenLabs, and join the parts. Usage is in SKILL.md.
import { $ } from 'bun'
import { existsSync } from 'node:fs'
import { appendFile, chmod, copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'

const SKILL_DIR = import.meta.dir
const PAD_SECONDS = 0.8
const SIZE = { width: 1920, height: 1080 }
const ENCODE = ['-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p']
const ELEVENLABS = 'https://api.elevenlabs.io/v1'

/** Starter sound effects for `sfx --kit`: short, clean, no low rumble. */
const SFX_KIT = {
	whoosh: ['short soft clean air whoosh for a fast screen transition, smooth, no low rumble, no wind', 0.7],
	swipe: ['very short quick swipe whoosh, light and crisp, no bass', 0.4],
	click: ['single clean soft mouse click, close and dry', 0.25],
	pop: ['soft round UI pop, a bubble appearing, gentle', 0.3],
	tick: ['tiny light UI tick, a soft tap on glass', 0.2],
	hit: ['soft deep cinematic impact for a logo reveal, short and tight, clean', 1.2],
	shimmer: ['short bright sparkle shimmer for a success state, airy and soft', 1.0]
} as const

/** A scene without text is silent and lasts `dur` seconds (1.5 by default), e.g. a pause. */
type Scene = { id: string; text?: string; dur?: number }
type Timing = { id: string; audio: string; dur: number }[]
type Recording = {
	frames: { file: string; t: number }[]
	scenes: { id: string; start: number; end: number }[]
	cuts?: { start: number; end: number }[]
	marks?: { name: string; t: number; box?: { x: number; y: number; width: number; height: number } }[]
	scale?: number
}

const [command, ...args] = process.argv.slice(2)
const commands: Record<string, (...args: string[]) => Promise<void>> = {
	init,
	narrate,
	music,
	sfx,
	'set-key': setKey,
	stills,
	render,
	live,
	crop,
	card,
	concat,
	check
}

if (!command || !commands[command]) {
	console.error(`usage: bun video.ts <${Object.keys(commands).join('|')}> ...  (see SKILL.md)`)
	process.exit(1)
}
await commands[command](...args)

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
				'`bun video.ts set-key` (key on stdin). Or rerun with --say to narrate with macOS `say`.'
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
			: await speakSay(scene.text, join(audioDir, `${name}.aiff`))
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
 * Renders frames of a composition at chosen times into `<part>/stills/` and a contact sheet:
 * `stills <part>.html [--every 0.5] [--at 1.2,4,7.5]`. Fast, for checking layout and motion.
 */
async function stills(htmlFile: string, ...rest: string[]) {
	const { values } = parseArgs({ args: rest, options: { every: { type: 'string' }, at: { type: 'string' } } })
	const dir = htmlFile.replace(/\.html$/, '')
	const out = join(dir, 'stills')
	await rm(out, { recursive: true, force: true })
	await mkdir(out, { recursive: true })

	const { browser, page, film } = await openComposition(htmlFile)
	const every = Number(values.every ?? 0.5)
	const times = values.at
		? values.at.split(',').map(Number)
		: Array.from({ length: Math.floor(film.duration / every) + 1 }, (_, i) => round(i * every))

	for (const t of times) {
		await seekFrame(page, t)
		await page.screenshot({ path: join(out, `${t.toFixed(2).padStart(6, '0')}.png`) })
	}
	await browser.close()

	const sheet = join(dir, 'stills.png')
	const columns = Math.min(times.length, 6)
	await $`ffmpeg -v error -y -pattern_type glob -i ${join(out, '*.png')} -vf scale=480:-1,tile=${columns}x${Math.ceil(times.length / columns)} ${sheet}`
	console.log(`${sheet} (${times.length} frames: ${times.join(', ')}s)`)
}

/**
 * Renders a composition frame by frame into `<part>/video.mp4` with its audio: narration
 * from `<part>.json`, the music and sound cues it declares. `render <part>.html [--fps 60]`;
 * `--audio-only` remixes the sound onto the frames of the last render.
 */
async function render(htmlFile: string, ...rest: string[]) {
	const { values } = parseArgs({ args: rest, options: { fps: { type: 'string' }, 'audio-only': { type: 'boolean' } } })
	const fps = Number(values.fps ?? 60)
	const dir = htmlFile.replace(/\.html$/, '')
	await mkdir(dir, { recursive: true })

	const { browser, page, film, size } = await openComposition(htmlFile)
	const silent = join(dir, 'frames.mp4')
	if (values['audio-only']) {
		await browser.close()
		if (!existsSync(silent)) throw new Error(`${silent} is missing: render once without --audio-only`)
		return mux(silent, await mixAudio(htmlFile, film), join(dir, 'video.mp4'))
	}

	const cdp = await page.context().newCDPSession(page)
	const frames = Math.round(film.duration * fps)
	const encoder = Bun.spawn(
		['ffmpeg', '-v', 'error', '-y', '-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'mjpeg', '-i', '-', '-vf', `scale=${size.width}:${size.height}`, ...ENCODE, '-r', String(fps), silent],
		{ stdin: 'pipe' }
	)

	const started = Date.now()
	for (let frame = 0; frame < frames; frame++) {
		await seekFrame(page, frame / fps)
		const { data } = await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 94, optimizeForSpeed: true })
		encoder.stdin.write(Buffer.from(data, 'base64'))
		if (frame % (fps * 5) === 0) console.log(`frame ${frame}/${frames}`)
	}
	encoder.stdin.end()
	await encoder.exited
	await browser.close()
	console.log(`rendered ${frames} frames in ${round((Date.now() - started) / 1000)}s`)

	await mux(silent, await mixAudio(htmlFile, film), join(dir, 'video.mp4'))
}

async function mux(video: string, audio: string, out: string) {
	await $`ffmpeg -v error -y -i ${video} -i ${audio} -map 0:v -map 1:a -c:v copy -c:a aac -b:a 192k -shortest -movflags +faststart ${out}`
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

	// The screencast only sends a frame when the page changes; each frame holds until the next.
	const lines = ['ffconcat version 1.0']
	let last = frames[0]
	for (const [from, to] of kept.flat()) {
		const opening = frames.findLast((frame) => frame.t <= from) ?? frames[0]
		const shown = [opening, ...frames.filter((frame) => frame.t > from && frame.t < to)]
		for (const [index, frame] of shown.entries()) {
			const until = shown[index + 1]?.t ?? to
			lines.push(`file 'frames/${frame.file}'`, `duration ${Math.max(until - Math.max(frame.t, from), 0.001).toFixed(4)}`)
		}
		last = shown.at(-1)!
	}
	lines.push(`file 'frames/${last.file}'`)
	const list = join(dir, 'frames.ffconcat')
	await writeFile(list, `${lines.join('\n')}\n`)

	const narration = await buildNarration(dir, timing, durations)
	const out = join(dir, 'video.mp4')
	const total = durations.reduce((sum, seconds) => sum + seconds, 0)
	// The video keeps the recorded density (3840x2160 at scale 2), so crops stay sharp;
	// `concat` scales parts to the film size.
	const width = SIZE.width * scale
	const height = SIZE.height * scale
	await $`ffmpeg -v error -y -f concat -safe 0 -i ${list} -i ${narration} -t ${total} -map 0:v -map 1:a -vf scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:-1:-1:color=black,fps=30 -c:v libx264 -preset medium -crf 14 -pix_fmt yuv420p -c:a aac -b:a 160k ${out}`
	console.log(out)

	// Marks in video time, with a crop for each marked element (even sizes, as x264 needs).
	const intervals = kept.flat()
	const videoTime = (t: number) =>
		intervals.reduce((sum, [from, to]) => sum + Math.max(0, Math.min(t, to) - from), 0)
	const even = (value: number) => Math.max(2, Math.round(value / 2) * 2)
	const placed = marks.map(({ name, t, box }) => ({
		name,
		t: round(videoTime(t)),
		crop: box && `crop=${even(box.width * scale)}:${even(box.height * scale)}:${even(box.x * scale)}:${even(box.y * scale)}`
	}))
	await writeFile(join(dir, 'marks.json'), JSON.stringify(placed, null, 2))
	for (const { name, t, crop } of placed) console.log(`mark ${t.toFixed(2)}s  ${name}${crop ? `  ${crop}` : ''}`)
}

/**
 * Crops a recorded part to a mark's element (`live` prints them) or an explicit `W:H:X:Y`,
 * with `--pad` video pixels around it, and writes a preview frame to check the edges.
 * `crop <part>.json <mark|W:H:X:Y> <out.mp4> [--pad 0] [--at <seconds>]`
 */
async function crop(partFile: string, region: string, output: string, ...rest: string[]) {
	if (!partFile || !region || !output) throw new Error('usage: crop <part>.json <mark|W:H:X:Y> <out.mp4> [--pad 0] [--at 1]')
	const { values } = parseArgs({ args: rest, options: { pad: { type: 'string' }, at: { type: 'string' } } })
	const dir = partDir(partFile)
	const source = join(dir, 'video.mp4')

	let box = region.split(':').map(Number)
	if (box.length !== 4 || box.some(Number.isNaN)) {
		const marks: { name: string; t: number; crop?: string }[] = await Bun.file(join(dir, 'marks.json')).json()
		const mark = marks.find((entry) => entry.name === region)
		if (!mark?.crop) throw new Error(`no mark "${region}" with an element in ${dir}/marks.json`)
		box = mark.crop.slice('crop='.length).split(':').map(Number)
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

	await $`ffmpeg -v error -y -i ${source} -vf ${filter} -an -c:v libx264 -preset medium -crf 14 -pix_fmt yuv420p ${output}`
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
			`[${video}:v]scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:-1:-1:color=black,fps=${fps},format=yuv420p,setsar=1[v${index}]`
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
	await $`ffmpeg -v error -y -loop 1 -t ${seconds} -i ${still} -f lavfi -t ${seconds} -i anullsrc=r=48000:cl=stereo -vf fps=30,fade=in:d=0.25,fade=out:st=${fadeOut}:d=0.25 ${ENCODE} -c:a aac -b:a 160k -shortest -metadata title=${title} ${output}`
	console.log(output)
}

/**
 * Measures a finished video: a contact sheet in the temp folder, frozen stretches (frames
 * that barely change, sampled at 10 fps) and loudness (integrated, range, true peak).
 */
async function check(video: string) {
	const seconds = await duration(video)
	const sheet = join(tmpdir(), `${basename(video, '.mp4')}.frames.png`)
	await $`ffmpeg -v error -y -i ${video} -vf fps=${24 / seconds},scale=480:-1,tile=6x4 -frames:v 1 ${sheet}`
	console.log(`contact sheet: ${sheet}`)

	const stats = await $`ffmpeg -hide_banner -i ${video} -vf fps=10,scale=320:-1,format=gray,tblend=all_mode=difference,signalstats,metadata=print:key=lavfi.signalstats.YAVG -an -f null -`.nothrow().quiet()
	const diffs = [...stats.stderr.toString().matchAll(/YAVG=([0-9.]+)/g)].map((match) => Number(match[1]))
	const frozen = frozenStretches(diffs, 0.35, 10)
	const total = frozen.reduce((sum, [from, to]) => sum + to - from, 0)
	const longest = frozen.toSorted((a, b) => b[1] - b[0] - (a[1] - a[0]))[0]
	console.log(
		`frozen: ${round(total)}s of ${round(seconds)}s` +
			(longest ? `, longest ${round(longest[1] - longest[0])}s at ${round(longest[0])}s` : '') +
			' (aim: under 1s per 30s, no hold over 0.6s except the end card)'
	)
	const holds = frozen.filter(([from, to]) => to - from > 0.6)
	if (holds.length > 0) console.log(`holds over 0.6s: ${holds.map(([from, to]) => `${round(from)}-${round(to)}s`).join(', ')}`)

	const hasAudio = (await $`ffprobe -v error -select_streams a -show_entries stream=index -of csv=p=0 ${video}`.text()).trim()
	if (!hasAudio) return console.log('loudness: no audio track')
	const loud = (await $`ffmpeg -hide_banner -i ${video} -af ebur128=peak=true -f null -`.nothrow().quiet()).stderr.toString()
	const summary = loud.slice(loud.lastIndexOf('Summary:'))
	const pick = (label: string) => summary.match(new RegExp(`${label}:\\s+(-?[0-9.]+)`))?.[1]
	console.log(`loudness: ${pick('I')} LUFS integrated, range ${pick('LRA')} LU, true peak ${pick('Peak')} dBFS (aim: about -14 music-led, -16 narrated, peak at or below -1)`)
}

function partDir(partFile: string) {
	return join(dirname(resolve(partFile)), basename(partFile, '.json'))
}

async function readTiming(dir: string): Promise<Timing> {
	const file = join(dir, 'timing.json')
	if (!existsSync(file)) throw new Error(`${file} is missing: run narrate first`)
	return Bun.file(file).json()
}

type FilmState = {
	duration: number
	cues: { t: number; sound: string; gain: number }[]
	audio: { music?: string; musicGain: number; narrationGain: number; dips: { from: number; to: number; gain: number }[] }
}

/**
 * Loads a composition with GSAP, the film runtime and any narration timing injected, at the
 * size its `<meta name="film-size" content="1080x1920">` asks for (1920x1080 by default).
 */
async function openComposition(htmlFile: string) {
	const source = resolve(htmlFile)
	const html = await readFile(source, 'utf8')
	const sizeMatch = html.match(/name="film-size"\s+content="(\d+)x(\d+)"/)
	const size = sizeMatch ? { width: Number(sizeMatch[1]), height: Number(sizeMatch[2]) } : SIZE

	const timingFile = join(source.replace(/\.html$/, ''), 'timing.json')
	const timing: Timing = existsSync(timingFile) ? await Bun.file(timingFile).json() : []
	const gsapDir = join(SKILL_DIR, 'node_modules/gsap/dist')
	const head = [
		`<script>window.TIMING = ${JSON.stringify(timing.map(({ id, dur }) => ({ id, dur })))}</script>`,
		...['gsap.min.js', 'SplitText.min.js', 'CustomEase.min.js'].map((file) => `<script src="file://${join(gsapDir, file)}"></script>`),
		`<script src="file://${join(SKILL_DIR, 'film.js')}"></script>`,
		`<style>html, body { width: ${size.width}px; height: ${size.height}px; margin: 0; overflow: hidden; }</style>`
	].join('\n')

	// Written next to the source so relative asset paths keep working.
	const built = join(dirname(source), `.${basename(source, '.html')}.build.html`)
	await writeFile(built, html.replace(/<head>/i, `<head>\n${head}`))

	const browser = await launchBrowser()
	const page = await browser.newPage({ viewport: size })
	const errors: string[] = []
	page.on('pageerror', (error: Error) => errors.push(error.message))
	await page.goto(`file://${built}`)
	try {
		await page.waitForFunction(() => (window as unknown as { film?: { ready: boolean } }).film?.ready, undefined, { timeout: 30_000 })
	} catch {
		await browser.close()
		throw new Error(`the composition never became ready${errors.length ? `: ${errors.join('; ')}` : ' (did it call Film.create?)'}`)
	}

	const film: FilmState = await page.evaluate(() => {
		const { duration, cues, audio } = (window as unknown as { film: FilmState }).film
		return { duration, cues, audio }
	})
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
 */
async function mixAudio(htmlFile: string, film: FilmState) {
	const source = resolve(htmlFile)
	const base = dirname(source)
	const dir = source.replace(/\.html$/, '')
	const length = round(film.duration)
	const inputs: string[] = []
	const filters: string[] = []
	const mix: string[] = []

	const timingFile = join(dir, 'timing.json')
	const narrated = existsSync(timingFile)
	if (narrated) {
		const timing: Timing = await Bun.file(timingFile).json()
		inputs.push('-i', await buildNarration(dir, timing, timing.map((scene) => scene.dur)))
		filters.push(`[0:a]volume=${film.audio.narrationGain}dB,asplit=2[voice][key]`)
		mix.push('[voice]')
	}

	if (film.audio.music) {
		const index = inputs.length / 2
		inputs.push('-i', resolve(base, film.audio.music))
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
			mix.push('[ducked]')
		} else {
			mix.push('[music]')
		}
	} else if (narrated) {
		filters.push('[key]anullsink')
	}

	for (const [i, cue] of film.cues.entries()) {
		const file = ['mp3', 'wav'].map((ext) => join(base, 'sfx', `${cue.sound}.${ext}`)).find((path) => existsSync(path))
		if (!file) throw new Error(`sound cue "${cue.sound}" at ${cue.t}s has no file in sfx/ (run: sfx --kit ${join(base, 'sfx')})`)
		const index = inputs.length / 2
		inputs.push('-i', file)
		const delay = Math.round(cue.t * 1000)
		filters.push(`[${index}:a]aresample=48000,adelay=${delay}|${delay},volume=${cue.gain}dB[cue${i}]`)
		mix.push(`[cue${i}]`)
	}

	const out = join(dir, 'mix.wav')
	if (mix.length === 0) {
		await $`ffmpeg -v error -y -f lavfi -t ${length} -i anullsrc=r=48000:cl=stereo ${out}`
		return out
	}

	filters.push(`${mix.join('')}amix=inputs=${mix.length}:normalize=0:duration=longest,apad=whole_dur=${length},atrim=0:${length}[out]`)
	const premix = join(dir, 'premix.wav')
	await $`ffmpeg -v error -y ${inputs} -filter_complex ${filters.join(';')} -map ${'[out]'} -c:a pcm_f32le ${premix}`

	// Two-pass, linear loudness normalisation: one gain for the whole film, so the dips and
	// builds survive. Single-pass loudnorm compresses dynamically and flattens them. The limiter
	// sits at -1.9 dBFS because AAC encoding adds inter-sample peaks on top.
	const target = narrated ? -16 : -14
	const measure = await $`ffmpeg -hide_banner -i ${premix} -af loudnorm=I=${target}:TP=-1.5:LRA=20:print_format=json -f null -`.nothrow().quiet()
	const stats = JSON.parse(measure.stderr.toString().match(/\{[\s\S]*?\}/)![0])
	const normalize = `loudnorm=I=${target}:TP=-1.5:LRA=20:linear=true:measured_I=${stats.input_i}:measured_TP=${stats.input_tp}:measured_LRA=${stats.input_lra}:measured_thresh=${stats.input_thresh}:offset=${stats.target_offset}`
	await $`ffmpeg -v error -y -i ${premix} -af ${normalize},aresample=48000,alimiter=limit=0.8:level=false -c:a pcm_s16le ${out}`
	return out
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
	// Momentary loudness (400 ms window): short-term needs 3 s to fill and hides a quiet start.
	const perSecond = [...loud.matchAll(/t:\s*([0-9.]+)\s+TARGET.*?M:\s*(-?[0-9.]+|-inf)/g)]
		.filter((match) => Number(match[1]) % 1 < 0.1)
		.map((match) => `${Math.round(Number(match[1]))}:${match[2]}`)
	console.log(`${output} (${round(await duration(output))}s)\nLUFS per second: ${perSecond.join(' ')}`)
}

/**
 * Generates sound effects with ElevenLabs and cleans them (high-pass, low-pass, short fades):
 * `sfx <out.mp3> "<description>" [--seconds 0.6]`, or `sfx --kit <dir>` for a starter set.
 */
async function sfx(...rest: string[]) {
	const { values, positionals } = parseArgs({
		args: rest,
		allowPositionals: true,
		options: { kit: { type: 'string' }, seconds: { type: 'string' } }
	})
	const key = await requireKey()

	const jobs: [string, string, number][] = values.kit
		? Object.entries(SFX_KIT).map(([name, [text, seconds]]) => [join(values.kit!, `${name}.mp3`), text, seconds])
		: [[positionals[0], positionals.slice(1).join(' '), Number(values.seconds ?? 0.6)]]
	if (!jobs[0][0] || !jobs[0][1]) throw new Error('usage: sfx <out.mp3> "<description>" [--seconds 0.6] | sfx --kit <dir>')

	for (const [path, text, seconds] of jobs) {
		await mkdir(dirname(resolve(path)), { recursive: true })
		const raw = join(tmpdir(), `sfx-${basename(path)}`)
		// The API's shortest effect is 0.5 s; shorter ones are trimmed afterwards.
		const body = { text, duration_seconds: Math.max(seconds, 0.5), prompt_influence: 0.6 }
		await Bun.write(raw, await elevenLabs(`${ELEVENLABS}/sound-generation`, key, body))

		// Rumble and hiss are what make effects sound cheap; trim both and avoid clicks.
		const length = Math.min(seconds, await duration(raw))
		const fadeOut = Math.max(length - 0.06, 0)
		const shaped = `atrim=0:${length},highpass=f=160,lowpass=f=10000,afade=t=in:d=0.005,afade=t=out:st=${fadeOut}:d=0.06`

		// Every effect at the same average level (-18 dBFS), so cue gains mean the same thing
		// for each; loudness meters gate out sounds this short, so measure the mean instead.
		const detect = await $`ffmpeg -hide_banner -i ${raw} -af ${shaped},volumedetect -f null -`.nothrow().quiet()
		const mean = Number(detect.stderr.toString().match(/mean_volume:\s*(-?[0-9.]+)/)?.[1] ?? -18)
		await $`ffmpeg -v error -y -i ${raw} -af ${shaped},volume=${-18 - mean}dB,alimiter=limit=0.89:level=false ${path}`
		console.log(path)
	}
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

async function launchBrowser() {
	const installed = ['playwright-core', 'gsap'].every((name) => existsSync(join(SKILL_DIR, 'node_modules', name)))
	if (!installed) await $`bun install`.cwd(SKILL_DIR).quiet()
	const { chromium } = await import(join(SKILL_DIR, 'node_modules/playwright-core/index.mjs'))
	// Installed Google Chrome first; a Playwright-managed Chromium otherwise.
	try {
		return await chromium.launch({ channel: 'chrome' })
	} catch {
		return chromium.launch()
	}
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

async function speakSay(text: string, path: string) {
	await $`say -v ${process.env.SAY_VOICE ?? 'Samantha'} -o ${path} ${text}`
	return path
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
