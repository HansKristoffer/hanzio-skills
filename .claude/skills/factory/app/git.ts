// What the service needs to know about a repository: its name, its main checkout, its default
// branch, and the factory.config.yaml on that branch. The file is read from the default branch on
// origin, never from a thread's worktree, so an issue's own branch cannot change its rules.
import { readFileSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { sh, shAsync } from './env.ts'
import { validate, type PartialSettings } from './settings.ts'

export const CONFIG_FILE = 'factory.config.yaml'

export type RepoInfo = { repo: string; root: string; hasOrigin: boolean }
export type ConfigRead = { file: PartialSettings | null; error?: string; offline?: boolean }

// Never block the service on an interactive credential or SSH host-key prompt.
const gitEnv = () => ({
	GIT_TERMINAL_PROMPT: '0',
	GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND || 'ssh -o BatchMode=yes'
})
const git = (cwd: string, args: string[]) => sh(['git', ...args], { cwd, env: gitEnv() })
const gitAsync = (cwd: string, args: string[]) => shAsync(['git', ...args], { cwd, env: gitEnv() })

const CONFIG_CACHE_MS = 30_000
const configCache = new Map<string, { fp: string; at: number; branch: string | null; config: ConfigRead }>()

/** Resolves a checkout's common git directory without spawning git. Returns null when the path is not a checkout. */
function resolveGitDir(root: string): string | null {
	try {
		const dot = join(root, '.git')
		const st = statSync(dot)
		if (st.isDirectory()) return dot
		if (st.isFile()) {
			const match = readFileSync(dot, 'utf8').match(/^gitdir:\s*(.+)$/m)
			if (!match) return null
			const target = match[1]!.trim()
			const gitDir = isAbsolute(target) ? target : resolve(root, target)
			try {
				const common = readFileSync(join(gitDir, 'commondir'), 'utf8').trim()
				if (common) return isAbsolute(common) ? common : resolve(gitDir, common)
			} catch {}
			return gitDir
		}
	} catch {
		return null
	}
	return null
}

/** Fast nanosecond stat fingerprint over the ref files that affect `defaultRef` and `origin/<default>:factory.config.yaml`. */
function refFingerprint(root: string, branch?: string | null): string | null {
	const gitDir = resolveGitDir(root)
	if (!gitDir) return null
	const paths = [
		gitDir,
		join(gitDir, 'HEAD'),
		join(gitDir, 'packed-refs'),
		join(gitDir, 'refs', 'remotes', 'origin'),
		join(gitDir, 'refs', 'remotes', 'origin', 'HEAD'),
		join(gitDir, 'refs', 'remotes', 'origin', 'main'),
		join(gitDir, 'refs', 'remotes', 'origin', 'master')
	]
	if (branch?.startsWith('origin/')) {
		const tail = branch.slice('origin/'.length)
		if (tail !== 'main' && tail !== 'master') paths.push(join(gitDir, 'refs', 'remotes', 'origin', tail))
	}
	let out = ''
	for (const p of paths) {
		try {
			const st = statSync(p, { bigint: true })
			out += `${st.mtimeNs}:${st.size};`
		} catch {
			out += '-;'
		}
	}
	return out
}

export function invalidateConfigCache(root?: string) {
	if (root) configCache.delete(root)
	else configCache.clear()
}

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
	invalidateConfigCache(root)
	const ref = defaultRef(root)
	if (!ref.startsWith('origin/')) return true
	const ok = git(root, ['fetch', '--quiet', 'origin', ref.slice('origin/'.length)]).ok
	invalidateConfigCache(root)
	return ok
}

async function defaultRefAsync(root: string): Promise<string> {
	const head = await gitAsync(root, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])
	if (head.ok && head.out) return head.out
	if ((await gitAsync(root, ['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/main'])).ok) return 'origin/main'
	if ((await gitAsync(root, ['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/master'])).ok) return 'origin/master'
	return (await gitAsync(root, ['remote', 'get-url', 'origin'])).ok ? 'origin/main' : 'HEAD'
}

/** Reads default branch and factory.config.yaml without fetching, using an async subprocess and nanosecond ref stat cache. */
export async function readConfigSnapshotAsync(root: string): Promise<{ branch: string | null; config: ConfigRead }> {
	const cached = configCache.get(root)
	const fp = refFingerprint(root, cached?.branch)
	if (cached && fp && cached.fp === fp && Date.now() - cached.at < CONFIG_CACHE_MS) {
		return { branch: cached.branch, config: cached.config }
	}
	let branch: string | null = null
	let config: ConfigRead = { file: null }
	try {
		branch = await defaultRefAsync(root)
		const shown = await gitAsync(root, ['show', `${branch}:${CONFIG_FILE}`])
		config = shown.ok ? parseConfig(shown.out) : { file: null }
	} catch (error) {
		config = { file: null, error: (error as Error).message }
	}
	const afterFp = refFingerprint(root, branch)
	if (afterFp) configCache.set(root, { fp: afterFp, at: Date.now(), branch, config })
	return { branch, config }
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

/** The first of `<prefix>/<slug>`, `-2`, `-3`... that neither origin nor the checkout has. */
export function freeBranch(root: string, slug: string, prefix = 'factory') {
	const base = `${prefix}/${slug}`
	const listed = git(root, ['ls-remote', '--heads', 'origin', `${base}*`])
	const local = git(root, ['for-each-ref', '--format=%(refname:short)', `refs/heads/${base}*`])
	const taken = new Set([
		...(listed.ok ? listed.out.split('\n').map((line) => line.split('refs/heads/')[1]) : []),
		...(local.ok ? local.out.split('\n') : [])
	].filter(Boolean))
	if (!taken.has(base)) return base
	for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`
}

export function slugify(title: string, fallback = 'issue') {
	const slug = title
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-|-$/g, '')
		.slice(0, 40)
		.replace(/-$/, '')
	return slug || fallback
}

const MAX_BASE_MERGES = 10

/** True when `head` was reached from `fromCommit` strictly through one or more clean, conflict-free
 * merges of `base` with no overlapping changed files and no extra code edits in the merge commits. */
export function isCleanBaseMerge(root: string, fromCommit: string | null | undefined, head: string, base: string): boolean {
	if (!fromCommit || !head || !base) return false
	const target = git(root, ['rev-parse', '--verify', '--quiet', `${fromCommit}^{commit}`])
	const tip = git(root, ['rev-parse', '--verify', '--quiet', `${head}^{commit}`])
	if (!target.ok || !tip.ok) return false
	if (target.out === tip.out) return true

	const remoteBase = `refs/remotes/origin/${base}`
	const localBase = `refs/heads/${base}`
	const baseRef = git(root, ['rev-parse', '--verify', '--quiet', `${remoteBase}^{commit}`]).ok
		? remoteBase
		: git(root, ['rev-parse', '--verify', '--quiet', `${localBase}^{commit}`]).ok
			? localBase
			: null
	if (!baseRef) return false

	let cur = tip.out
	for (let step = 0; step < MAX_BASE_MERGES && cur !== target.out; step++) {
		const listed = git(root, ['rev-list', '--parents', '-n', '1', cur])
		if (!listed.ok) return false
		const parts = listed.out.split(/\s+/).filter(Boolean)
		if (parts.length !== 3) return false
		const [, p1, p2] = parts as [string, string, string]

		// Second parent must be a commit on the base branch, not another feature branch.
		if (!git(root, ['merge-base', '--is-ancestor', p2, baseRef]).ok) return false

		const mb = git(root, ['merge-base', p1, p2])
		if (!mb.ok || !mb.out) return false

		// --no-renames reports both old and new paths so a rename cannot mask an overlap.
		const prDiff = git(root, ['-c', 'core.quotePath=false', 'diff', '--no-renames', '--name-only', mb.out, p1])
		const baseDiff = git(root, ['-c', 'core.quotePath=false', 'diff', '--no-renames', '--name-only', mb.out, p2])
		if (!prDiff.ok || !baseDiff.ok) return false
		const prFiles = new Set(prDiff.out.split('\n').filter(Boolean))
		for (const file of baseDiff.out.split('\n').filter(Boolean)) {
			if (prFiles.has(file)) return false
		}

		// A clean 3-way merge produces a single tree identical to the merge commit's tree.
		const merged = git(root, ['merge-tree', '--write-tree', p1, p2])
		if (!merged.ok) return false
		const cleanTree = merged.out.split('\n')[0]?.trim()
		const actualTree = git(root, ['rev-parse', `${cur}^{tree}`])
		if (!actualTree.ok || actualTree.out !== cleanTree) return false

		cur = p1
	}
	return cur === target.out
}
