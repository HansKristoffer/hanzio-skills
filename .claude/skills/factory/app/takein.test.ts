// Taking in an existing PR: the worktree branch moves to the PR's head, and `pr push` lands on the PR's
// branch whatever the local branch is called. Runs real git against a scratch repository and a bare origin.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { git, scratchRepo, setup, type Harness } from './fixtures/harness.ts'
import { forkUrl, pushTaken, takeIn } from './takein.ts'

let h: Harness
let repo: ReturnType<typeof scratchRepo>
let worktree: string
let prHead: string
const URL = 'https://github.com/acme/api/pull/7'

const view = (over: Record<string, unknown> = {}) => ({
	number: 7,
	url: URL,
	title: 'Add CSV export',
	state: 'OPEN',
	author: { login: 'someone-else' },
	headRefName: 'feature-x',
	headRefOid: prHead,
	headRepository: { name: 'api' },
	headRepositoryOwner: { login: 'acme' },
	isCrossRepository: false,
	maintainerCanModify: false,
	...over
})

beforeEach(() => {
	h = setup()
	repo = scratchRepo(h.dir)
	// The PR's branch renames one file and deletes another, and GitHub keeps its head at refs/pull/7/head.
	git(repo.other, 'checkout', '-q', '-b', 'feature-x')
	git(repo.other, 'mv', 'a.txt', 'c.txt')
	git(repo.other, 'rm', '-q', 'b.txt')
	git(repo.other, 'commit', '-q', '-m', 'csv export')
	git(repo.other, 'push', '-q', 'origin', 'feature-x', 'feature-x:refs/pull/7/head')
	prHead = git(repo.other, 'rev-parse', 'HEAD')
	git(repo.work, 'fetch', '-q', 'origin')
	worktree = join(h.dir, 'wt')
	git(repo.work, 'worktree', 'add', '-q', '-b', 'factory/pr-7', worktree, 'origin/main')
	h.gh.replies({ view: { out: view() } })
})
afterEach(() => h.close())

test('take in puts the worktree branch on the PR head with the PR branch as upstream, and pr push lands there', async () => {
	const taken = await takeIn(URL, worktree)
	expect(taken).toMatchObject({ number: 7, headRef: 'feature-x', head: prHead, author: 'someone-else', canPush: true, mine: false })
	expect(git(worktree, 'rev-parse', 'HEAD')).toBe(prHead)
	expect(existsSync(join(worktree, 'c.txt'))).toBe(true)
	expect(git(worktree, 'config', 'branch.factory/pr-7.merge')).toBe('refs/heads/feature-x')

	writeFileSync(join(worktree, 'c.txt'), 'more\n')
	git(worktree, 'commit', '-q', '-am', 'build on it')
	const pushed = pushTaken(worktree)
	expect(pushed.to).toBe('origin feature-x')
	expect(git(repo.bare, 'rev-parse', 'refs/heads/feature-x')).toBe(git(worktree, 'rev-parse', 'HEAD'))

	// Taking it in again after a restart keeps the commits already pushed.
	const again = await takeIn(URL, worktree)
	expect(again.head).toBe(prHead)
	expect(git(worktree, 'rev-parse', 'HEAD')).toBe(pushed.pushed)
})

test('take in refuses the default branch, a dirty checkout, commits of its own and a closed PR', async () => {
	await expect(takeIn(URL, repo.work)).rejects.toThrow('a branch of its own')

	writeFileSync(join(worktree, 'a.txt'), 'dirty\n')
	await expect(takeIn(URL, worktree)).rejects.toThrow('uncommitted changes')
	git(worktree, 'commit', '-q', '-am', 'local work')
	await expect(takeIn(URL, worktree)).rejects.toThrow('commits the PR does not have')

	h.gh.replies({ view: { out: view({ state: 'MERGED' }) } })
	await expect(takeIn(URL, worktree)).rejects.toThrow('is merged')
})

test('a PR on another repository is refused, and pr push needs a taken-in branch', async () => {
	h.gh.replies({ view: { out: view({ url: 'https://github.com/acme/web/pull/7' }) } })
	await expect(takeIn('https://github.com/acme/web/pull/7', worktree)).rejects.toThrow('this checkout is acme/api')
	expect(() => pushTaken(worktree)).toThrow('not the branch of a PR the issue took in')
})

test('a fork PR pushes to the fork, written like origin', () => {
	expect(forkUrl('https://github.com/acme/api.git', 'jo', 'api-fork')).toBe('https://github.com/jo/api-fork.git')
	expect(forkUrl('git@github.com:acme/api.git', 'jo', 'api')).toBe('git@github.com:jo/api.git')
	expect(forkUrl('https://github.com/acme/api', 'jo', 'api')).toBe('https://github.com/jo/api')
})
