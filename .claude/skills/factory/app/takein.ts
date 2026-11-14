// An issue can start from a pull request that already exists: the factory reviews it, or builds on it.
// The CLI puts the thread's worktree branch on the PR's head and points the branch's upstream at the PR's
// branch, so `factory pr push` lands commits on the PR whatever the local branch is called.
import { sh } from './env.ts'
import { gh, parsePrUrl } from './gh.ts'
import { defaultRef, repoInfo } from './git.ts'

export type TakenPr = {
	url: string
	number: number
	title: string
	author: string
	headRef: string
	head: string
	crossRepository: boolean
	/** Whether this thread's login can push to the PR's branch. */
	canPush: boolean
	/** Whether this thread's login opened the PR. */
	mine: boolean
}

const FIELDS = 'number,url,title,state,author,headRefName,headRefOid,headRepository,headRepositoryOwner,isCrossRepository,maintainerCanModify'

const git = (cwd: string, args: string[]) => sh(['git', ...args], { cwd })

function must(cwd: string, args: string[]) {
	const result = git(cwd, args)
	if (!result.ok) throw new Error(`git ${args.join(' ')}: ${result.err || result.out}`)
	return result.out
}

/** The URL of the fork a cross-repository PR comes from, written the way origin is (https or ssh). */
export function forkUrl(originUrl: string, owner: string, name: string) {
	const replaced = originUrl.replace(/([:/])[^/:]+\/[^/]+?(\.git)?\/?$/, `$1${owner}/${name}$2`)
	if (replaced === originUrl) throw new Error(`cannot tell the fork's URL from origin ${originUrl}`)
	return replaced
}

/** Reads the PR as this thread's login. Throws when it is not open. */
export async function readTaken(url: string): Promise<Omit<TakenPr, 'head'> & { head: string; headOwner: string; headName: string }> {
	parsePrUrl(url)
	const [view, login] = await Promise.all([gh(['pr', 'view', url, '--json', FIELDS]), gh(['api', 'user', '--jq', '.login'])])
	if (!view.ok) throw new Error(`gh pr view ${url}: ${view.err || view.out}`)
	const pr = JSON.parse(view.out) as Record<string, any>
	if (pr.state !== 'OPEN') throw new Error(`${url} is ${String(pr.state).toLowerCase()}; the factory takes in open PRs only`)
	const author = String(pr.author?.login ?? '')
	const me = login.ok ? login.out : ''
	const cross = !!pr.isCrossRepository
	return {
		url: String(pr.url ?? url),
		number: Number(pr.number),
		title: String(pr.title),
		author,
		headRef: String(pr.headRefName),
		head: String(pr.headRefOid),
		headOwner: String(pr.headRepositoryOwner?.login ?? ''),
		headName: String(pr.headRepository?.name ?? ''),
		crossRepository: cross,
		canPush: !cross || !!pr.maintainerCanModify || (!!me && me.toLowerCase() === pr.headRepositoryOwner?.login?.toLowerCase()),
		mine: !!me && me.toLowerCase() === author.toLowerCase()
	}
}

/** Puts this worktree's branch on the PR's head and sets its upstream to the PR's branch. */
export async function takeIn(url: string, cwd: string): Promise<TakenPr> {
	const pr = await readTaken(url)
	const ref = parsePrUrl(pr.url)
	const info = repoInfo(cwd)
	if (info.repo !== `${ref.owner}/${ref.name}`.toLowerCase()) {
		throw new Error(`${pr.url} is a PR on ${ref.owner}/${ref.name}, and this checkout is ${info.repo}`)
	}
	const branch = git(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD']).out
	if (!branch) throw new Error('this checkout is on no branch; move to a worktree branch first')
	const base = defaultRef(info.root)
	if (`origin/${branch}` === base) {
		throw new Error(`this checkout is on ${branch}; move to a worktree on a branch of its own first`)
	}
	if (git(cwd, ['status', '--porcelain']).out) throw new Error('this checkout has uncommitted changes; commit or remove them first')

	must(cwd, ['fetch', '--quiet', 'origin', `refs/pull/${pr.number}/head`])
	const fetched = must(cwd, ['rev-parse', 'FETCH_HEAD'])
	const head = must(cwd, ['rev-parse', 'HEAD'])
	const isAncestor = (a: string, b: string) => git(cwd, ['merge-base', '--is-ancestor', a, b]).ok
	if (!isAncestor(fetched, head)) {
		// Only a branch with nothing of its own moves: a fresh worktree on the default branch, or one already behind the PR.
		const own = git(cwd, ['rev-list', '--count', `${base}..HEAD`]).out
		if (own !== '0' && !isAncestor(head, fetched)) {
			throw new Error(`${branch} has commits the PR does not have; push them with factory pr push, or start from a fresh worktree`)
		}
		must(cwd, ['reset', '--quiet', '--hard', fetched])
	}
	const remote = pr.crossRepository ? forkUrl(must(cwd, ['remote', 'get-url', 'origin']), pr.headOwner, pr.headName) : 'origin'
	must(cwd, ['config', `branch.${branch}.remote`, remote])
	must(cwd, ['config', `branch.${branch}.merge`, `refs/heads/${pr.headRef}`])
	// The mark `pushTaken` looks for: a worktree branch made from origin's default branch tracks it already.
	must(cwd, ['config', `branch.${branch}.factoryPr`, pr.url])
	const { headOwner: _o, headName: _n, ...taken } = pr
	return { ...taken, head: fetched }
}

/** Pushes HEAD to the branch's upstream, which `takeIn` set to the PR's branch. Never forces. */
export function pushTaken(cwd: string) {
	const branch = git(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD']).out
	if (!branch) throw new Error('this checkout is on no branch')
	const remote = git(cwd, ['config', `branch.${branch}.remote`]).out
	const merge = git(cwd, ['config', `branch.${branch}.merge`]).out
	if (!git(cwd, ['config', `branch.${branch}.factoryPr`]).out || !remote || !merge.startsWith('refs/heads/')) {
		throw new Error(`${branch} is not the branch of a PR the issue took in (factory start --pr); push it with git push`)
	}
	must(cwd, ['push', '--quiet', remote, `HEAD:${merge}`])
	return { pushed: must(cwd, ['rev-parse', 'HEAD']), to: `${remote} ${merge.slice('refs/heads/'.length)}` }
}
