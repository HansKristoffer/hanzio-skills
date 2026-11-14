// An issue that starts from a PR that already exists: the service records it, keeps the PR from being
// worked twice, tells the stages to build on it, and posts a review of it.
import { afterEach, beforeEach, expect, setDefaultTimeout, test } from 'bun:test'
import { join } from 'node:path'
import { FAKE_T3, scratchRepo, setup, type Harness } from './fixtures/harness.ts'
import { HEAD, rawPr } from './fixtures/pr-builder.ts'

setDefaultTimeout(30_000)

const CLI = join(import.meta.dir, 'cli.ts')
const PR = 'https://github.com/acme/api/pull/7'
let h: Harness
let work: string
const as = (path: string, body: Record<string, unknown> = {}) => h.as('t1')('POST', path, body)
const taken = (over: Record<string, unknown> = {}) => ({
	url: PR,
	number: 7,
	title: 'Add CSV export',
	author: 'someone-else',
	headRef: 'feature-x',
	head: HEAD,
	crossRepository: false,
	canPush: true,
	mine: false,
	...over
})

beforeEach(() => {
	h = setup()
	work = scratchRepo(h.dir).work
})
afterEach(() => h.close())

async function cli(args: string[]) {
	const proc = Bun.spawn(['bun', CLI, ...args], {
		cwd: work,
		stdout: 'pipe',
		stderr: 'pipe',
		env: { ...process.env, ...h.gh.env, FACTORY_HOME: h.home, FACTORY_PORT: String(h.port), FACTORY_T3: FAKE_T3, T3CODE_THREAD_ID: 't1' }
	})
	const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
	return { code, json: out ? JSON.parse(out) : null, err }
}

test("start with a PR someone else opened records it, holds the merge for the user, and tells research and implement to build on it", async () => {
	const started = await as('/api/issue/start', { cwd: work, title: 'Add CSV export', source: PR, taken: taken() })
	expect(started.status).toBe(200)
	const status = (await as('/api/issue/status')).body
	expect(status.issue.prUrl).toBe(PR)
	expect(status.issue.takenPr).toMatchObject({ author: 'someone-else', headRef: 'feature-x' })
	expect(status.merge).toBe('ask')

	const research = (await as('/api/issue/run', { stage: 'research' })).body.brief as string
	expect(research).toContain('### The PR this issue took in')
	expect(research).not.toContain('pr push')
	expect((await as('/api/issue/run', { stage: 'implement' })).body.brief).toContain('pr push')
	const review = (await as('/api/issue/run', { stage: 'review', head: HEAD })).body.brief as string
	expect(review).not.toContain('### The PR this issue took in')
})

test("the user's own PR keeps the project's merge setting, and a PR another issue works is a duplicate", async () => {
	await as('/api/issue/start', { cwd: work, title: 'Add CSV export', taken: taken({ mine: true }) })
	expect((await as('/api/issue/status')).body.merge).toBe('auto')
	const other = await h.as('t2')('POST', '/api/issue/start', { cwd: work, title: 'Review it', taken: taken({ url: `${PR}/files` }) })
	expect(other.body.duplicateOf.id).toBe('t1')
})

test('research may route a taken-in PR to review, and a review-only issue closes as reviewed', async () => {
	await as('/api/issue/start', { cwd: work, title: 'Add CSV export', taken: taken() })
	const run = (await as('/api/issue/run', { stage: 'research' })).body.run
	const reported = await h.as('c1')('POST', `/api/runs/${run}/report`, {
		text: 'review only',
		done: true,
		result: {
			outcome: 'done',
			result: { kind: 'feature', size: 'S', route: 'review', reproduction: { notPossible: 'nothing to reproduce' }, checks: [] }
		}
	})
	expect(reported.status).toBe(200)
	const closed = await as('/api/issue/close', { outcome: 'reviewed', summary: 'Posted the review' })
	expect(closed.status).toBe(200)
	expect((await as('/api/issue/status')).body.issue.state).toBe('closed')
})

test('pr review posts the last review as one comment, with a link to each line, leaving out pre-existing findings', async () => {
	await as('/api/issue/start', { cwd: work, title: 'Add CSV export', taken: taken() })
	h.gh.pr(rawPr())
	const run = (await as('/api/issue/run', { stage: 'review', head: HEAD })).body.run
	await h.as('c1')('POST', `/api/runs/${run}/report`, {
		text: 'two findings',
		done: true,
		result: {
			outcome: 'done',
			result: {
				commit: HEAD,
				findings: [
					{ file: 'src/export.ts', line: 40, severity: 'important', title: 'Stream never closes', text: 'The writer leaks on error.' },
					{ file: 'src/util.ts', severity: 'nit', text: 'Unused import.' },
					{ file: 'src/old.ts', line: 3, severity: 'pre-existing', title: 'Old bug', text: 'Not this PR.' }
				],
				testsFailWithoutFix: 'no-new-tests',
				risk: { door: 'two-way', reach: 'module', unrelated: [], focus: ['The CSV writer'] }
			}
		}
	})
	const res = await cli(['pr', 'review'])
	expect(res.err).toBe('')
	expect(res.code).toBe(0)
	const posted = h.gh.calls().find((c) => c.args.slice(0, 2).join(' ') === 'pr review')!
	expect(posted.args).toContain('--comment')
	expect(posted.stdin).toContain(`[src/export.ts:40](https://github.com/acme/api/blob/${HEAD}/src/export.ts#L40): Stream never closes.`)
	expect(posted.stdin).toContain('### Nits')
	expect(posted.stdin).toContain('- The CSV writer')
	expect(posted.stdin).not.toContain('Old bug')
	expect(posted.stdin).toContain('<!-- factory:t1 -->')
})

test('new with a PR reads its title, starts the thread on a pr branch, and tells it to take the PR in', async () => {
	await h.as('seen')('POST', '/api/issue/start', { cwd: work, title: 'Seen' })
	h.gh.replies({ view: { out: { title: 'Add CSV export', state: 'OPEN' } } })
	const res = await h.call('POST', '/api/threads', { repo: 'acme/api', pr: PR })
	expect(res.status).toBe(200)
	expect(res.body.branch).toBe('factory/pr-7')
	const start = h.calls().find((c) => c.args[1] === 'start')!
	expect(start.args).toContain('Add CSV export')
	expect(start.stdin).toContain(`factory start --pr ${PR}`)
	expect((await h.call('POST', '/api/threads', { repo: 'acme/api', pr: PR })).body.duplicateOf.id).toBe(res.body.issue)

	h.gh.replies({ view: { out: { title: 'Old', state: 'MERGED' } } })
	const merged = await h.call('POST', '/api/threads', { repo: 'acme/api', pr: 'https://github.com/acme/api/pull/8' })
	expect(merged.body.error).toContain('open PRs only')
})
