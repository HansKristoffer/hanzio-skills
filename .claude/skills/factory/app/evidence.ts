// What a reviewer looks at instead of the diff: screenshots and videos of the change (evidence), and the
// dev environment to try it in (the preview). The service keeps the files and shows them on the page;
// the thread pushes copies to a ref on GitHub, so the PR and the issue can show them too.
import type { EvidenceRow } from './db.ts'

const IMAGES = ['png', 'jpg', 'jpeg', 'webp', 'gif']
const VIDEOS = ['mp4', 'webm', 'mov']
export const MIME: Record<string, string> = {
	png: 'image/png',
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	webp: 'image/webp',
	gif: 'image/gif',
	mp4: 'video/mp4',
	webm: 'video/webm',
	mov: 'video/quicktime'
}

/** A file larger than this stays on the page and is left out of the push to GitHub. */
export const MAX_PUSH_BYTES = 25 * 1024 * 1024

export const extOf = (path: string) => path.split('.').pop()?.toLowerCase() ?? ''

export function kindOf(path: string): 'image' | 'video' | null {
	const ext = extOf(path)
	return IMAGES.includes(ext) ? 'image' : VIDEOS.includes(ext) ? 'video' : null
}

/** Where the files of one push are on GitHub: `<base>/raw/<commit>/<name>` for each name in `files`. */
export type Published = { base: string | null; commit: string; files: string[] }

export type PreviewUrl = { name: string; url: string }
/** `requested` and `stopping` are the page's asks, which the thread has not acted on yet. */
export type Preview = {
	state: 'requested' | 'up' | 'stopping' | 'down' | 'failed'
	urls: PreviewUrl[]
	head: string | null
	error: string | null
	at: number
	/** When a run that idles stops by itself (buncargo's detached run), in ms; absent when it has no such limit. */
	stopsAt?: number | null
}

/** `https://host/owner/name` from a pull request URL or a git remote, or null for a remote that is not a host. */
export function repoWebBase(url: string | null | undefined) {
	if (!url) return null
	const web = url.match(/^https?:\/\/([^/@]+@)?([^/]+)\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/.*)?$/)
	if (web) return `https://${web[2]}/${web[3]}/${web[4]}`
	const ssh = url.match(/^(?:ssh:\/\/)?[^@/]+@([^:/]+)[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/)
	return ssh ? `https://${ssh[1]}/${ssh[2]}/${ssh[3]}` : null
}

export type PublicEvidence = ReturnType<typeof publicEvidence>

/** An item as the page and the CLI see it: the page's own URLs, and GitHub's once pushed. */
export function publicEvidence(row: EvidenceRow, folder: string, prBase: string | null = null) {
	const local = (name: string | null) => (name ? `/evidence/${encodeURIComponent(folder)}/${encodeURIComponent(name)}` : null)
	const published = row.published ? (JSON.parse(row.published) as Published) : null
	const base = prBase ?? published?.base ?? null
	const remote = (name: string | null) =>
		name && published && base && published.files.includes(name) ? `${base}/raw/${published.commit}/${name}` : null
	return {
		id: row.id,
		kind: row.kind,
		title: row.title,
		label: row.label,
		note: row.note,
		url: local(row.file)!,
		poster: local(row.poster),
		bytes: row.bytes,
		head: row.head,
		createdAt: row.created_at,
		pushed: !!published,
		github: published && base ? { url: remote(row.file), poster: remote(row.poster), clip: remote(row.clip) } : null
	}
}

/** Items under one title belong together: a before and an after, or the states of one screen. */
export function grouped<T extends { title: string }>(items: T[]) {
	const groups = new Map<string, T[]>()
	for (const item of items) groups.set(item.title, [...(groups.get(item.title) ?? []), item])
	return [...groups.entries()].map(([title, of]) => ({ title, items: of }))
}

/** Text that stays one line and cannot open a table cell, a link or a tag in GitHub's Markdown. */
const inline = (text: string) => text.replace(/\s+/g, ' ').replace(/[|[\]<>`]/g, (c) => `\\${c}`).trim()

/** A commit as a reader can follow it: a link when the repository's address is known, its short name otherwise. */
export function commitRef(sha: string, repo: string | null = null) {
	const name = sha.replace(/[^\w./-]/g, '')
	const hex = /^[0-9a-f]{7,64}$/i.test(name)
	const short = hex ? name.slice(0, 10) : name.slice(0, 60)
	return repo && hex ? `[\`${short}\`](${repo}/commit/${name})` : `\`${short}\``
}

/** The evidence as GitHub shows it in a PR body or a comment. Empty when there is nothing to show. */
export function evidenceMarkdown(items: PublicEvidence[], repo: string | null = null) {
	const parts: string[] = []
	for (const group of grouped(items)) {
		const title = inline(group.title)
		const before = group.items.find((i) => i.label === 'before' && i.kind === 'image' && i.github?.url)
		const after = group.items.find((i) => i.label === 'after' && i.kind === 'image' && i.github?.url)
		const pair = before && after ? [before, after] : []
		const lines = [`**${title}**`]
		if (pair.length) {
			// Each side names the commit it shows, so a reader can tell a stale pair from a current one.
			const commits = before!.head && after!.head ? `| ${commitRef(before!.head, repo)} | ${commitRef(after!.head, repo)} |\n` : ''
			lines.push(
				`| Before | After |\n| --- | --- |\n${commits}| ![Before: ${title}](${before!.github!.url}) | ![After: ${title}](${after!.github!.url}) |`
			)
		}
		for (const item of group.items.filter((i) => !pair.includes(i))) {
			const name = item.label ? `${item.label === 'before' ? 'Before' : 'After'}: ${title}` : title
			const gh = item.github
			if (!gh?.url && !gh?.clip && !gh?.poster) lines.push(`_${name}: a ${item.kind} kept on the factory page, not pushed to GitHub._`)
			else if (item.kind === 'image') lines.push(`![${name}](${gh.url})`)
			else {
				const still = gh.clip ?? gh.poster
				if (still) lines.push(gh.url ? `[![${name}](${still})](${gh.url})` : `![${name}](${still})`)
				lines.push(
					gh.url
						? `Video${gh.clip ? ', its first seconds above' : ''}: [the whole clip](${gh.url}) downloads as an mp4.`
						: 'Video: the whole clip is on the factory page.'
				)
			}
		}
		for (const note of new Set(group.items.map((i) => i.note).filter((n): n is string => !!n))) lines.push(inline(note))
		parts.push(lines.join('\n\n'))
	}
	return parts.join('\n\n')
}

/** What the implementer measured: the same run on the base commit and on the head. */
export type Measured = {
	how: string
	base: string
	head: string
	rows: { what: string; before: string; after: string }[]
	same?: string
}

/** The measurements as a table with each side's commit. Empty when there are no rows. */
export function measuredMarkdown(measured: Measured | null | undefined, repo: string | null = null) {
	if (!measured?.rows.length) return ''
	const table = [
		`| | Before, at ${commitRef(measured.base, repo)} | After, at ${commitRef(measured.head, repo)} |`,
		'| --- | ---: | ---: |',
		...measured.rows.map((row) => `| ${inline(row.what)} | ${inline(row.before)} | ${inline(row.after)} |`)
	].join('\n')
	return [measured.how.trim(), table, measured.same?.trim()].filter(Boolean).join('\n\n')
}

/** `name  https://…` lines, as `buncargo url` prints them. A name can hold spaces. */
export function parseUrlLines(out: string): PreviewUrl[] {
	return out
		.split('\n')
		.map((line) => line.trim().match(/^(.+?)\s+(https?:\/\/\S+)$/))
		.filter((match): match is RegExpMatchArray => !!match)
		.map((match) => ({ name: match[1]!.trim(), url: match[2]! }))
}

/** `--url web=http://localhost:5173` flags. */
export function parseUrlFlags(flags: string[]): PreviewUrl[] {
	return flags.map((flag) => {
		const at = flag.indexOf('=')
		const name = flag.slice(0, at).trim()
		const url = flag.slice(at + 1).trim()
		if (at < 1 || !/^https?:\/\/\S+$/.test(url)) throw new Error(`--url: write it as <name>=<http url>, not "${flag}"`)
		return { name, url }
	})
}

/** What `buncargo status --json` says of this checkout's run: the app `buncargo open` opens, and how long a
 * detached run idles before buncargo stops it. Empty when the output is not that JSON. */
export function parseRun(out: string): { primary?: string; idleMs?: number } {
	try {
		const run = JSON.parse(out)?.runs?.[0]
		return {
			...(typeof run?.primaryApp === 'string' && { primary: run.primaryApp }),
			...(run?.detached === true && typeof run.idleLimitMs === 'number' && run.idleLimitMs > 0 && { idleMs: run.idleLimitMs })
		}
	} catch {
		return {}
	}
}

/** The primary app's address first, since the page makes the first one its main button. */
export const primaryFirst = (urls: PreviewUrl[], primary?: string) =>
	primary ? [...urls.filter((u) => u.name === primary), ...urls.filter((u) => u.name !== primary)] : urls

const LOOPBACK = new Set(['localhost', '127.0.0.1', '0.0.0.0', '[::1]'])

/** A loopback address as another machine opens it: the same URL on `host`. Null for any other address. */
export function onHost(url: string, host: string | null | undefined) {
	const match = url.match(/^(https?:\/\/)(\[[^\]]+\]|[^/:?#]+)(.*)$/)
	if (!host || !match || !LOOPBACK.has(match[2]!.toLowerCase()) || LOOPBACK.has(host.toLowerCase())) return null
	return `${match[1]}${host}${match[3]}`
}
