#!/usr/bin/env bun
// Product videos: render HTML/GSAP compositions frame by frame, record live walkthroughs of
// the real product in Chrome, voice and score them with ElevenLabs, and join the parts.
// Usage is in SKILL.md.
import { $ } from 'bun'
import { existsSync } from 'node:fs'
import { appendFile, chmod, copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { availableParallelism, homedir, tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { parseArgs } from 'node:util'

const SKILL_DIR = import.meta.dir
const PAD_SECONDS = 0.8
const SIZE = { width: 1920, height: 1080 }
/** Frame rate of recorded parts: scrolls and pointer glides are captured at it. */
const FPS = 60
// Screen text survives a re-encode by X or YouTube only from a high-quality master. Colours are
// converted and tagged as BT.709, which players assume for HD; untagged, yellows and reds shift.
const COLOR = ['-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv']
const ENCODE = ['-c:v', 'libx264', '-preset', 'slow', '-crf', '14', '-pix_fmt', 'yuv420p', ...COLOR]
/** Scales to W:H with the sharpest filter, converting to BT.709. */
const scaleTo = (width: number, height: number) => `scale=${width}:${height}:flags=lanczos:out_color_matrix=bt709:out_range=tv`
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

	// The sheet labels each tile with its time, so a still can be named without counting tiles.
	await page.evaluate(() => {
		const label = document.createElement('div')
		label.id = '__stillTime'
		label.style.cssText = 'position:fixed;left:0;top:0;z-index:2147483647;padding:10px 20px;font:700 56px/1 monospace;background:#ff2d55;color:#fff'
		document.body.appendChild(label)
	})
	const labelled = join(out, 'labelled')
	await mkdir(labelled)
	for (const t of times) {
		await seekFrame(page, t)
		await page.evaluate((text: string) => {
			document.getElementById('__stillTime')!.textContent = text
		}, `${t}s`)
		await page.screenshot({ path: join(labelled, `${t.toFixed(2).padStart(6, '0')}.png`) })
	}
	await browser.close()

	const sheet = join(dir, 'stills.png')
	const columns = Math.min(times.length, 6)
	await $`ffmpeg -v error -y -pattern_type glob -i ${join(labelled, '*.png')} -vf scale=480:-1,tile=${columns}x${Math.ceil(times.length / columns)}:color=0x808080 ${sheet}`
	await rm(labelled, { recursive: true })
	console.log(`${sheet} (${times.length} frames, labelled; full size in ${out})`)
}

/**
 * Renders a composition frame by frame into `<part>/video.mp4` with its audio: narration
 * from `<part>.json`, the music and sound cues it declares. `render <part>.html [--fps 60]
 * [--scale 2]`; `--audio-only` remixes the sound onto the frames of the last render.
 * Frames are drawn at `--scale` times the pixels and scaled down, so text and footage stay
 * crisp and a large clip shown small does not shimmer; `--scale 1` is faster for drafts.
 * `--workers N` renders that many stretches of the film at once, each in its own browser:
 * every frame is a pure function of time, so they join seamlessly. The default uses a quarter of
 * the cores, up to 8; on a server without a GPU, where each frame is drawn in software, that is
 * what makes a render take minutes rather than most of an hour.
 */
async function render(htmlFile: string, ...rest: string[]) {
	const { values } = parseArgs({ args: rest, options: { fps: { type: 'string' }, scale: { type: 'string' }, workers: { type: 'string' }, 'audio-only': { type: 'boolean' } } })
	const fps = Number(values.fps ?? 60)
	const scale = Number(values.scale ?? 2)
	const dir = htmlFile.replace(/\.html$/, '')
	await mkdir(dir, { recursive: true })

	const { browser, page, film, size } = await openComposition(htmlFile, scale)
	const silent = join(dir, 'frames.mp4')
	if (values['audio-only']) {
		await browser.close()
		if (!existsSync(silent)) throw new Error(`${silent} is missing: render once without --audio-only`)
		return mux(silent, await mixAudio(htmlFile, film), join(dir, 'video.mp4'))
	}

	const frames = Math.round(film.duration * fps)
	const workers = Math.max(1, Math.min(Number(values.workers ?? Math.min(8, Math.floor(availableParallelism() / 4))), Math.ceil(frames / fps)))
	// The first browser is open already; the others load the same composition.
	const pages = [{ browser, page }, ...(await Promise.all(Array.from({ length: workers - 1 }, () => openComposition(htmlFile, scale))))]

	const started = Date.now()
	let done = 0
	const segments = await Promise.all(
		pages.map(async ({ browser: worker, page: workerPage }, index) => {
			const from = Math.floor((frames * index) / workers)
			const to = Math.floor((frames * (index + 1)) / workers)
			const segment = workers === 1 ? silent : join(dir, `frames.${index}.mp4`)
			const encoder = Bun.spawn(
				['ffmpeg', '-v', 'error', '-y', '-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'mjpeg', '-i', '-', '-vf', scaleTo(size.width, size.height), ...ENCODE, '-r', String(fps), segment],
				{ stdin: 'pipe' }
			)
			const cdp = await workerPage.context().newCDPSession(workerPage)
			// A clip at scale 1 returns device pixels; without one, Chrome may return CSS pixels.
			const clip = { x: 0, y: 0, width: size.width, height: size.height, scale: 1 }
			for (let frame = from; frame < to; frame++) {
				await seekFrame(workerPage, frame / fps)
				const { data } = await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 95, optimizeForSpeed: true, clip })
				encoder.stdin.write(Buffer.from(data, 'base64'))
				await encoder.stdin.flush()
				if (++done % (fps * 5) === 0) console.log(`frame ${done}/${frames}`)
			}
			encoder.stdin.end()
			if ((await encoder.exited) !== 0) throw new Error(`encoding frames ${from}-${to} failed`)
			await worker.close()
			return segment
		})
	)
	if (workers > 1) {
		const list = join(dir, 'frames.txt')
		await writeFile(list, segments.map((segment) => `file '${basename(segment)}'`).join('\n'))
		await $`ffmpeg -v error -y -f concat -safe 0 -i ${list} -c copy ${silent}`
		await Promise.all([list, ...segments].map((file) => rm(file)))
	}
	console.log(`rendered ${frames} frames in ${round((Date.now() - started) / 1000)}s${workers > 1 ? ` with ${workers} workers` : ''}`)

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
	const browser = await launchBrowser()
	const page = await browser.newPage({ viewport: size, deviceScaleFactor: scale })

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
		`<script src="file://${join(SKILL_DIR, 'film.js')}"></script>`,
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
			mix.push('[ducked]')
		} else {
			mix.push('[music]')
		}
	} else if (narrated) {
		filters.push('[key]anullsink')
	}

	const missing = new Set<string>()
	for (const [i, cue] of film.cues.entries()) {
		const file = ['mp3', 'wav'].map((ext) => join(base, 'sfx', `${cue.sound}.${ext}`)).find((path) => existsSync(path))
		if (!file) {
			missing.add(cue.sound)
			continue
		}
		const index = inputs.length / 2
		inputs.push('-i', file)
		const delay = Math.round(cue.t * 1000)
		filters.push(`[${index}:a]aresample=48000,adelay=${delay}|${delay},volume=${cue.gain}dB[cue${i}]`)
		mix.push(`[cue${i}]`)
	}

	if (missing.size > 0) console.warn(`no sfx/ file for ${[...missing].join(', ')}; those cues are silent (run: sfx --kit ${join(base, 'sfx')})`)

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
 * servers and containers, Chrome only starts without its sandbox.
 */
async function startBrowser<T>(launch: (options: Record<string, unknown>) => Promise<T>, options: Record<string, unknown> = {}): Promise<T> {
	const settings = { ...options, ...(process.getuid?.() === 0 && { chromiumSandbox: false }) }
	try {
		return await launch({ ...settings, channel: 'chrome' })
	} catch (error) {
		if (/ProcessSingleton|in use/.test(String(error))) throw new Error('the video profile is already open in another window; close it first')
	}
	try {
		return await launch(settings)
	} catch (error) {
		const message = String(error)
		// A container without user namespaces has no sandbox for Chrome to use.
		if (/No usable sandbox|sandbox/i.test(message) && settings.chromiumSandbox !== false) return startBrowser(launch, { ...options, chromiumSandbox: false })
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

async function launchBrowser() {
	const browser = await chromium()
	return startBrowser((options) => browser.launch(options))
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

async function openProfile(options: { headless?: boolean; viewport?: { width: number; height: number } | null; scale?: number }) {
	const profile = profileDir()
	await mkdir(profile, { recursive: true })
	const launch = {
		// Headless where no window can open, as on a server.
		headless: options.headless ?? !hasDisplay(),
		viewport: options.viewport ?? null,
		...(options.viewport && { deviceScaleFactor: options.scale ?? 1 }),
		// Without the automation banner and flag, sign-in pages treat it as the normal browser it is.
		ignoreDefaultArgs: ['--enable-automation'],
		args: ['--disable-blink-features=AutomationControlled']
	}
	const browser = await chromium()
	const context = await startBrowser((settings) => browser.launchPersistentContext(profile, settings), launch)
	await importSignIns(context)
	const page = context.pages()[0] ?? (await context.newPage())
	return { context, page }
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
 * `walk <part>.walk.mjs [--rehearse] [--scale 2] [--headless]`. Any other script name runs
 * without recording, for exploring the app or taking screenshots.
 */
async function walk(script: string, ...rest: string[]) {
	if (!script) throw new Error('usage: walk <part>.walk.mjs [--rehearse] [--scale 2] [--headless]')
	const { values } = parseArgs({ args: rest, options: { rehearse: { type: 'boolean' }, scale: { type: 'string' }, headless: { type: 'boolean' } } })
	const part = script.endsWith('.walk.mjs') ? script.replace(/\.walk\.mjs$/, '.json') : null
	const { record } = await import(join(SKILL_DIR, 'live.mjs'))
	const { context, page } = await openProfile({ headless: values.headless, viewport: SIZE, scale: Number(values.scale ?? 2) })

	let recording: { stop(): Promise<unknown> } | undefined
	try {
		const { default: run } = await import(resolve(script))
		await run({
			page,
			context,
			async record(options = {}) {
				if (!part) throw new Error('name the script <part>.walk.mjs to record that part')
				recording = await record(page, partDir(part), { rehearse: values.rehearse, ...options })
				return recording
			}
		})
	} finally {
		if (recording) console.log(await recording.stop())
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
