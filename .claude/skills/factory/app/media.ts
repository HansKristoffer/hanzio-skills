// What the CLI does with a capture before the service keeps it, and with the dev environment. It all runs
// in the thread, with the thread's own git login and environment: ffmpeg makes a video small enough to
// review, git pushes the files to a ref on GitHub, and buncargo starts and stops the dev environment.
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sh } from './env.ts'
import { extOf, kindOf, parseUrlLines } from './evidence.ts'

const CLIP_BUDGET = 8 * 1024 * 1024
const CLIP_SECONDS = 20

export type Prepared = { kind: 'image' | 'video'; file: string; poster?: string; clip?: string; warning?: string; cleanup: () => void }

const made = (path: string) => existsSync(path) && statSync(path).size > 0

/**
 * A capture ready to store. An image goes in as it is. A video becomes an mp4 a browser plays (1080p at
 * most, 30 fps), with a still frame for the page and a short GIF, which is what GitHub can show inline.
 * Without ffmpeg the video goes in as it is, with neither.
 */
export function prepare(path: string): Prepared {
	const kind = kindOf(path)
	if (!kind) throw new Error(`${path}: not an image (png, jpg, webp, gif) or a video (mp4, webm, mov)`)
	if (kind === 'image') return { kind, file: path, cleanup: () => {} }
	if (!sh(['ffmpeg', '-version']).ok) {
		const warning = `ffmpeg is not installed, so the video was stored as it is, with no still frame and no GIF for GitHub${extOf(path) === 'mov' ? '; a .mov may not play in the browser' : ''}`
		return { kind, file: path, warning, cleanup: () => {} }
	}
	const dir = mkdtempSync(join(tmpdir(), 'factory-evidence-'))
	const cleanup = () => rmSync(dir, { recursive: true, force: true })
	const file = join(dir, 'video.mp4')
	const encoded = sh([
		'ffmpeg', '-v', 'error', '-y', '-i', path,
		'-vf', "scale='trunc(min(1920,iw)/2)*2':-2,fps=30",
		'-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26', '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
		'-c:a', 'aac', '-b:a', '96k', file
	])
	if (!encoded.ok || !made(file)) {
		cleanup()
		throw new Error(`ffmpeg could not read ${path}: ${encoded.err.split('\n').slice(-3).join(' ')}`)
	}
	const poster = join(dir, 'poster.jpg')
	for (const at of ['0.5', '0']) {
		if (made(poster)) break
		sh(['ffmpeg', '-v', 'error', '-y', '-ss', at, '-i', file, '-frames:v', '1', '-q:v', '3', poster])
	}
	const clip = join(dir, 'clip.gif')
	for (const [fps, width] of [[8, 800], [5, 640]] as const) {
		const filter = `fps=${fps},scale='min(${width},iw)':-2:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`
		sh(['ffmpeg', '-v', 'error', '-y', '-t', String(CLIP_SECONDS), '-i', file, '-filter_complex', filter, clip])
		if (made(clip) && statSync(clip).size <= CLIP_BUDGET) break
		rmSync(clip, { force: true })
	}
	return { kind, file, ...(made(poster) && { poster }), ...(made(clip) && { clip }), cleanup }
}

function git(cwd: string, args: string[], stdin?: string) {
	const result = Bun.spawnSync(['git', ...args], {
		cwd,
		...(stdin !== undefined && { stdin: Buffer.from(stdin) }),
		stdout: 'pipe',
		stderr: 'pipe',
		env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
	})
	if (result.exitCode !== 0) throw new Error(`git ${args.slice(0, 2).join(' ')}: ${result.stderr.toString().trim() || 'failed'}`)
	return result.stdout.toString().trim()
}

/**
 * Pushes the files as one commit to `ref` on origin and returns the commit. The ref is outside
 * `refs/heads`, so no clone fetches the media, no branch appears and no workflow runs; GitHub still
 * serves each file by the commit's SHA. Every push holds the whole set and has the push before it as
 * its parent, so a URL from an earlier push keeps working. The working tree and the index are not touched.
 */
export function pushEvidence(cwd: string, ref: string, files: { name: string; path: string }[], message: string) {
	if (!ref.startsWith('refs/') || ref.startsWith('refs/heads/')) throw new Error(`${ref} is not a ref outside refs/heads`)
	const entries = files.map((file) => `100644 blob ${git(cwd, ['hash-object', '-w', '--', file.path])}\t${file.name}`)
	const tree = git(cwd, ['mktree'], `${entries.join('\n')}\n`)
	const parent = git(cwd, ['ls-remote', 'origin', ref]).split(/\s+/)[0] || null
	if (parent) {
		git(cwd, ['fetch', '--quiet', '--no-tags', 'origin', ref])
		if (git(cwd, ['rev-parse', `${parent}^{tree}`]) === tree) return { commit: parent, pushed: false }
	}
	// commit-tree refuses to guess an identity on a machine that has none configured.
	const identity = sh(['git', 'config', 'user.email'], { cwd }).out ? [] : ['-c', 'user.name=factory', '-c', 'user.email=factory@localhost']
	const commit = git(cwd, [...identity, 'commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', message])
	git(cwd, ['push', '--quiet', 'origin', `${commit}:${ref}`])
	return { commit, pushed: true }
}

// ---- the dev environment ----

/** FACTORY_BUNCARGO points at another binary, which is what the tests use. */
const buncargo = () => (process.env.FACTORY_BUNCARGO ? [process.env.FACTORY_BUNCARGO] : ['bunx', 'buncargo'])

export const usesBuncargo = (top: string) => existsSync(join(top, 'dev.config.ts'))

const tail = (text: string, lines = 12) => text.trim().split('\n').slice(-lines).join('\n')

/** Starts this checkout's buncargo run in the background and returns its URLs, as the reader's machine reaches them. */
export function buncargoUp(top: string, apps?: string) {
	const started = sh([...buncargo(), 'dev', '--detach', ...(apps ? [`--apps=${apps}`] : [])], { cwd: top })
	const listed = sh([...buncargo(), 'url'], { cwd: top })
	const urls = listed.ok ? parseUrlLines(listed.out) : []
	const output = tail(`${started.out}\n${started.err}`)
	return { urls, ok: started.ok, output: started.ok ? '' : output || tail(listed.err) }
}

export function buncargoDown(top: string) {
	const stopped = sh([...buncargo(), 'stop', '--all'], { cwd: top })
	return { ok: stopped.ok, output: stopped.ok ? '' : tail(`${stopped.out}\n${stopped.err}`) }
}
