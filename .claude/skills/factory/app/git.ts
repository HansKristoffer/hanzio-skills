// What the service needs to know about a repository: its name, its main checkout, its default
// branch, and the factory.config.yaml on that branch. The file is read from the default branch on
// origin, never from a thread's worktree, so an issue's own branch cannot change its rules.
import { dirname } from 'node:path'
import { sh } from './env.ts'
import { validate, type PartialSettings } from './settings.ts'

export const CONFIG_FILE = 'factory.config.yaml'

export type RepoInfo = { repo: string; root: string; hasOrigin: boolean }
export type ConfigRead = { file: PartialSettings | null; error?: string; offline?: boolean }

const git = (cwd: string, args: string[]) => sh(['git', ...args], { cwd })

/** `owner/name` from a GitHub-style remote URL, lowercase. */
export function repoName(url: string) {
	const match = url.match(/[:/]([^/:]+\/[^/]+?)(?:\.git)?\/?$/)
	return match?.[1]?.toLowerCase() ?? null
}

export function repoInfo(cwd: string): RepoInfo {
	const common = git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
	if (!common.ok) throw new Error(`${cwd} is not inside a git repository`)
	const root = dirname(common.out)
	const origin = git(root, ['remote', 'get-url', 'origin'])
	const name = origin.ok ? repoName(origin.out) : null
	return { repo: name ?? root.split('/').pop()!.toLowerCase(), root, hasOrigin: origin.ok }
}

/** The default branch as a ref to read: `origin/<name>`, or HEAD for a repository with no origin. */
export function defaultRef(root: string) {
	const head = git(root, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])
	if (head.ok && head.out) return head.out
	if (git(root, ['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/main']).ok) return 'origin/main'
	if (git(root, ['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/master']).ok) return 'origin/master'
	return git(root, ['remote', 'get-url', 'origin']).ok ? 'origin/main' : 'HEAD'
}

/** Fetches the default branch. Returns false when the fetch failed, such as offline. */
export function fetchDefault(root: string) {
	const ref = defaultRef(root)
	if (!ref.startsWith('origin/')) return true
	return git(root, ['fetch', '--quiet', 'origin', ref.slice('origin/'.length)]).ok
}

/** Parses the text of factory.config.yaml. Empty or comments only is no file; anything else must validate whole. */
export function parseConfig(text: string): ConfigRead {
	let parsed: unknown
	try {
		parsed = Bun.YAML.parse(text)
	} catch (error) {
		return { file: null, error: `${CONFIG_FILE}: ${(error as Error).message}` }
	}
	if (parsed === null || parsed === undefined) return { file: null }
	if (typeof parsed !== 'object' || Array.isArray(parsed)) {
		return { file: null, error: `${CONFIG_FILE}: must be a mapping` }
	}
	try {
		return { file: validate(parsed, CONFIG_FILE) }
	} catch (error) {
		return { file: null, error: `${CONFIG_FILE}: ${(error as Error).message}` }
	}
}

/** Reads factory.config.yaml from the default branch, fetching it first when asked. */
export function readConfig(root: string, options: { fetch: boolean }): ConfigRead {
	const offline = options.fetch ? !fetchDefault(root) : false
	const shown = git(root, ['show', `${defaultRef(root)}:${CONFIG_FILE}`])
	const read = shown.ok ? parseConfig(shown.out) : { file: null }
	return offline ? { ...read, offline } : read
}

/** The first of `factory/<slug>`, `-2`, `-3`... that origin does not have. */
export function freeBranch(root: string, slug: string) {
	const base = `factory/${slug}`
	const listed = git(root, ['ls-remote', '--heads', 'origin', `${base}*`])
	const taken = new Set(
		listed.ok ? listed.out.split('\n').map((line) => line.split('refs/heads/')[1]).filter(Boolean) : []
	)
	if (!taken.has(base)) return base
	for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`
}

export function slugify(title: string) {
	const slug = title
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-|-$/g, '')
		.slice(0, 40)
		.replace(/-$/, '')
	return slug || 'issue'
}
