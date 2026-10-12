#!/usr/bin/env bun
// Narrated product videos: voice a script with ElevenLabs, record HTML scenes or a
// live ego-browser run in time with it, and join the parts. Usage is in SKILL.md.
import { $ } from 'bun'
import { existsSync } from 'node:fs'
import { appendFile, chmod, copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'

const SKILL_DIR = import.meta.dir
const PAD_SECONDS = 0.8
const SIZE = { width: 1920, height: 1080 }
const ENCODE = ['-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p']

/** A scene without text is silent and lasts `dur` seconds (1.5 by default), e.g. a pause. */
type Scene = { id: string; text?: string; dur?: number }
type Timing = { id: string; audio: string; dur: number }[]
type Recording = {
	frames: { file: string; t: number }[]
	scenes: { id: string; start: number; end: number }[]
	cuts?: { start: number; end: number }[]
}

const [command, ...args] = process.argv.slice(2)
const commands: Record<string, (...args: string[]) => Promise<void>> = {
	init,
	narrate,
	'set-key': setKey,
	card,
	preview,
	slides,
	live,
	concat,
	check
}

if (!command || !commands[command]) {
	console.error(`usage: bun video.ts <${Object.keys(commands).join('|')}> ...  (see SKILL.md)`)
	process.exit(1)
}
await commands[command](...args)

/** Creates `<repo>/.video-build/<slug>/`, kept out of git through `.git/info/exclude`. */
async function init(slug: string) {
	if (!slug) throw new Error('usage: init <slug>')

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

	if (!existsSync(join(build, 'slides.html'))) {
		await copyFile(join(SKILL_DIR, 'template.html'), join(build, 'slides.html'))
	}
	if (!existsSync(join(build, 'slides.json'))) {
		const example: Scene[] = [
			{ id: 'intro', text: 'One or two sentences that say what changed and why it matters.' },
			{ id: 'how', text: 'What the user now sees or does, in plain words.' }
		]
		await writeFile(join(build, 'slides.json'), `${JSON.stringify(example, null, 1)}\n`)
	}

	console.log(JSON.stringify({ root, build, output: join(root, `${slug}.mp4`) }, null, 1))
}

/**
 * Voices every scene of `<part>.json` into `<part>/audio/` and writes `<part>/timing.json`.
 * Without an ElevenLabs key it stops so the agent can ask for one; `--say` uses macOS `say`.
 */
async function narrate(partFile: string, flag?: string) {
	const useSay = flag === '--say'
	const key = useSay ? undefined : await elevenLabsKey()
	if (!key && !useSay) {
		console.error(
			'NO_ELEVENLABS_KEY: ask the user for their ElevenLabs API key, then store it with ' +
				'`bun video.ts set-key` (key on stdin). Or rerun with --say to narrate with macOS `say`.'
		)
		process.exit(2)
	}

	const scenes: Scene[] = await Bun.file(partFile).json()
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

/** Screenshots every scene in its finished state, so layouts can be checked without recording. */
async function preview(partFile: string, htmlFile?: string) {
	const dir = partDir(partFile)
	const html = await buildHtml(partFile, htmlFile)
	const out = join(dir, 'preview')
	await rm(out, { recursive: true, force: true })
	await mkdir(out, { recursive: true })

	const browser = await launchBrowser()
	const page = await browser.newPage({ viewport: SIZE })
	await page.goto(`file://${html}`)
	const count = await page.evaluate(() => document.querySelectorAll('.scene').length)
	for (let index = 0; index < count; index++) {
		await page.evaluate((i) => (window as unknown as { preview(i: number): void }).preview(i), index)
		await page.screenshot({ path: join(out, `${String(index).padStart(2, '0')}.png`) })
	}
	await browser.close()

	const sheet = join(dir, 'preview.png')
	await $`ffmpeg -v error -y -pattern_type glob -i ${join(out, '*.png')} -vf scale=640:-1,tile=${Math.min(count, 3)}x${Math.ceil(count / 3)} ${sheet}`
	console.log(sheet)
}

/** Records `<part>.html` in time with the narration into `<part>/video.mp4`. */
async function slides(partFile: string, htmlFile?: string) {
	const dir = partDir(partFile)
	const timing = await readTiming(dir)
	const html = await buildHtml(partFile, htmlFile)
	const raw = join(dir, 'raw')
	await rm(raw, { recursive: true, force: true })

	const browser = await launchBrowser()
	const context = await browser.newContext({ viewport: SIZE, recordVideo: { dir: raw, size: SIZE } })
	const createdAt = Date.now()
	const page = await context.newPage()
	await page.goto(`file://${html}`)

	const sceneIds = await page.evaluate(() =>
		[...document.querySelectorAll<HTMLElement>('.scene')].map((scene) => scene.dataset.id)
	)
	const timingIds = timing.map((scene) => scene.id)
	if (sceneIds.join() !== timingIds.join()) {
		await browser.close()
		throw new Error(`scene ids [${sceneIds}] do not match the script [${timingIds}]`)
	}

	await page.waitForTimeout(800)
	const startedAt = Date.now()
	const total = await page.evaluate(() => (window as unknown as { start(): number }).start())
	await page.waitForTimeout(total * 1000 + 500)
	const video = page.video()
	await context.close()
	await browser.close()

	const narration = await buildNarration(dir, timing, timing.map((scene) => scene.dur))
	const offset = (startedAt - createdAt) / 1000
	const out = join(dir, 'video.mp4')
	await $`ffmpeg -v error -y -ss ${offset} -i ${await video!.path()} -i ${narration} -t ${total} -map 0:v -map 1:a -vf fps=30 ${ENCODE} -c:a aac -b:a 160k ${out}`
	console.log(out)
}

/** Turns the frames `live.mjs` captured into `<part>/video.mp4` with the narration. */
async function live(partFile: string) {
	const dir = partDir(partFile)
	const timing = await readTiming(dir)
	const { frames, scenes, cuts = [] }: Recording = await Bun.file(join(dir, 'recording.json')).json()

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
	await $`ffmpeg -v error -y -f concat -safe 0 -i ${list} -i ${narration} -t ${total} -map 0:v -map 1:a -vf scale=${SIZE.width}:${SIZE.height}:force_original_aspect_ratio=decrease,pad=${SIZE.width}:${SIZE.height}:-1:-1:color=black,fps=30 ${ENCODE} -c:a aac -b:a 160k ${out}`
	console.log(out)
}

/** Joins parts (recorded videos or any clip, such as a logo intro) into one video. */
async function concat(output: string, ...parts: string[]) {
	if (!output || parts.length === 0) throw new Error('usage: concat <output.mp4> <part.mp4>...')

	const inputs: string[] = []
	const filters: string[] = []
	let next = 0
	for (const [index, part] of parts.entries()) {
		inputs.push('-i', part)
		const video = next++
		filters.push(
			`[${video}:v]scale=${SIZE.width}:${SIZE.height}:force_original_aspect_ratio=decrease,pad=${SIZE.width}:${SIZE.height}:-1:-1:color=black,fps=30,format=yuv420p,setsar=1[v${index}]`
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

	// Reuse the brand stylesheet of a slides part, written next to it so its asset paths resolve.
	const styleSource = resolve(values.style ?? join(SKILL_DIR, 'template.html'))
	const stylesheet = (await readFile(styleSource, 'utf8')).match(/<style>[\s\S]*?<\/style>/)?.[0] ?? ''
	const escape = (text: string) => text.replace(/[&<>"]/g, (char) => `&#${char.charCodeAt(0)};`)
	const eyebrow = values.eyebrow ? `<div class="eyebrow">${escape(values.eyebrow)}</div>` : ''
	const html = join(dirname(styleSource), `.card-${basename(output, '.mp4')}.html`)
	await writeFile(
		html,
		`<!doctype html><html><head><meta charset="utf-8">${stylesheet}</head><body class="static"><section class="scene on" style="align-items:center;text-align:center">${eyebrow}<h1>${escape(title)}</h1></section></body></html>`
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

/** Writes a 4x3 contact sheet of evenly spaced frames to the temp folder. */
async function check(video: string) {
	const seconds = await duration(video)
	// Kept out of the repository; it is only for looking at.
	const sheet = join(tmpdir(), `${basename(video, '.mp4')}.frames.png`)
	await $`ffmpeg -v error -y -i ${video} -vf fps=${12 / seconds},scale=640:-1,tile=4x3 -frames:v 1 ${sheet}`
	console.log(sheet)
}

function partDir(partFile: string) {
	return join(dirname(resolve(partFile)), basename(partFile, '.json'))
}

async function readTiming(dir: string): Promise<Timing> {
	const file = join(dir, 'timing.json')
	if (!existsSync(file)) throw new Error(`${file} is missing: run narrate first`)
	return Bun.file(file).json()
}

/** Fills the narrated scene durations into the HTML; without narration every scene gets 5 s. */
async function buildHtml(partFile: string, htmlFile?: string) {
	const source = resolve(htmlFile ?? partFile.replace(/\.json$/, '.html'))
	const timingFile = join(partDir(partFile), 'timing.json')
	const timing: Timing = existsSync(timingFile) ? await Bun.file(timingFile).json() : []
	const scenes: Scene[] = await Bun.file(partFile).json()
	const durations = scenes.map((scene) => ({
		id: scene.id,
		dur: timing.find((entry) => entry.id === scene.id)?.dur ?? 5
	}))

	// Written next to the source so relative image paths keep working.
	const built = join(dirname(source), `.${basename(source, '.html')}.build.html`)
	const html = await readFile(source, 'utf8')
	if (!html.includes('__TIMING__')) throw new Error(`${source} has no __TIMING__ placeholder`)
	await writeFile(built, html.replace('__TIMING__', JSON.stringify(durations)))
	return built
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
	if (!existsSync(join(SKILL_DIR, 'node_modules/playwright-core'))) await $`bun install`.cwd(SKILL_DIR).quiet()
	// Playwright encodes recordings with its own ffmpeg build; the install is a no-op once present.
	await $`bun ${join(SKILL_DIR, 'node_modules/playwright-core/cli.js')} install ffmpeg`.cwd(SKILL_DIR).quiet()
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
