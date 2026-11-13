// The review loop end to end: the real CLI runs the fake `gh` as the thread would, against the service.
import { afterEach, beforeEach, expect, setDefaultTimeout, test } from 'bun:test'
import { join } from 'node:path'
import { readPr } from './gh.ts'
import { FAKE_T3, scratchRepo, setup, type Harness } from './fixtures/harness.ts'
import { HEAD, bot, comment, member, outsider, rawPr, review, thread } from './fixtures/pr-builder.ts'

// Each test runs the CLI several times, a few hundred milliseconds each.
setDefaultTimeout(30_000)

const CLI = join(import.meta.dir, 'cli.ts')
let h: Harness
let work: string
const as = (path: string, body: Record<string, unknown> = {}) => h.as('t1')('POST', path, body)
const PR = 'https://github.com/acme/api/pull/7'
const idle = { code: 0, out: JSON.stringify({ thread: { status: 'completed', pendingRequestCount: 0 } }) }
const busy = { code: 0, out: JSON.stringify({ thread: { status: 'running', pendingRequestCount: 0 } }) }

beforeEach(async () => {
	h = setup()
	work = scratchRepo(h.dir).work
	await as('/api/issue/start', { cwd: work, title: 'Exports time out' })
	await as('/api/issue/update', { pr: PR })
})
afterEach(() => h.close())

/** Runs the CLI without blocking: this process also runs the service it talks to. */
async function cli(args: string[], stdin?: string) {
	const proc = Bun.spawn(['bun', CLI, ...args], {
		cwd: work,
		stdin: stdin === undefined ? 'ignore' : new Blob([stdin]),
		stdout: 'pipe',
		stderr: 'pipe',
		env: {
			...process.env,
			...h.gh.env,
			FACTORY_HOME: h.home,
			FACTORY_PORT: String(h.port),
			FACTORY_T3: FAKE_T3,
			T3CODE_THREAD_ID: 't1'
		}
	})
	const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
	return { code, json: out ? JSON.parse(out) : null, err }
}
const ghCalls = (word: string) => h.gh.calls().filter((c) => c.args.join(' ').includes(word))
const sends = () => h.calls().filter((c) => c.args[1] === 'send')
const issue = async () => (await h.call('GET', '/api/issues/t1')).body

async function storeResults() {
	const implement = (await as('/api/issue/run', { stage: 'implement' })).body.run
	await h.as('c1')('POST', `/api/runs/${implement}/report`, {
		text: 'done',
		done: true,
		result: {
			outcome: 'done',
			result: {
				prUrl: PR,
				commit: HEAD,
				claims: [],
				notChecked: ['Accounts over 1M rows'],
				leftOut: [],
				decisions: [
					{ decision: 'Kept CSV', confidence: 'high' },
					{ decision: 'Batch size 500', confidence: 'low' }
				]
			}
		}
	})
	const reviewRun = (await as('/api/issue/run', { stage: 'review', head: HEAD })).body.run
	await h.as('c2')('POST', `/api/runs/${reviewRun}/report`, {
		text: 'clean',
		done: true,
		result: {
			outcome: 'done',
			result: { commit: HEAD, findings: [], testsFailWithoutFix: true, risk: { door: 'two-way', reach: 'module', unrelated: [], focus: ['src/export.ts:40'] } }
		}
	})
}

test('pr sync stores 120 threads, 150 reviews and 130 comments read over several pages', async () => {
	const many = rawPr({
		threads: Array.from({ length: 120 }, (_, i) => thread([comment(bot(), `nit ${i}`, 1)], { resolved: true })),
		reviews: Array.from({ length: 150 }, () => review(bot(), 'COMMENTED', 1)),
		comments: Array.from({ length: 130 }, () => comment(outsider(), '+1', 1))
	})
	h.gh.pr(many)
	const read = await readPr(PR)
	expect([read.threads.length, read.reviews.length, read.comments.length]).toEqual([120, 150, 130])
	const res = await cli(['pr', 'sync'])
	expect(res.code).toBe(0)
	expect(res.json.hidden).toBe(130)
	expect((await issue()).items).toHaveLength(400)
})

test('two syncs over the same PR print the same work and change nothing', async () => {
	h.gh.pr(rawPr({ threads: [thread([comment(member('anna'), 'Close the stream', 1)])] }))
	const first = (await await cli(['pr', 'sync'])).json
	const second = (await await cli(['pr', 'sync'])).json
	expect(second.needsAction.map((i: { id: string }) => i.id)).toEqual(first.needsAction.map((i: { id: string }) => i.id))
	expect(second.gate).toEqual(first.gate)
	expect(second.round).toEqual({ n: 1, pushes: 0 })
	expect(first.needsAction[0].isNew).toBe(true)
	expect(second.needsAction[0].isNew).toBe(false)
})

test('pr ready marks the PR ready without waiting for checks, and adds the reviewer notes to its body', async () => {
	await storeResults()
	h.gh.pr({ ...rawPr({ view: { isDraft: true }, required: [{ name: 'tests', bucket: 'pending' }] }), body: 'Fixes #4\n\nEvidence: tests' })
	const res = await cli(['pr', 'ready'])
	expect(res.code).toBe(0)
	expect(ghCalls('pr ready')).toHaveLength(1)
	const body = ghCalls('pr edit')[0]!.stdin!
	expect(body.startsWith('Fixes #4\n\nEvidence: tests')).toBe(true)
	expect(body.indexOf('(low) Batch size 500')).toBeLessThan(body.indexOf('(high) Kept CSV'))
	expect(body).toContain('- Accounts over 1M rows')
	expect(body).toContain('- src/export.ts:40')
	expect(body).not.toContain('/#/issue/')
})

test('pr ready links the factory page from the body of a private repository', async () => {
	await storeResults()
	h.gh.pr({ ...rawPr({ view: { isDraft: true } }), body: 'Fixes #4' })
	h.gh.replies({ repo: { out: 'true' } })
	expect((await cli(['pr', 'ready'])).code).toBe(0)
	expect(ghCalls('repos/acme/api --jq .private')).toHaveLength(1)
	expect(ghCalls('pr edit')[0]!.stdin!).toContain(`(http://127.0.0.1:${h.port}/#/issue/t1)`)
})

test('pr ready --request waits for green checks, the bots and their items, and leaves the author out', async () => {
	await h.call('PUT', '/api/settings/repo:acme/api', { reviewers: ['anna', 'maintainer', 'acme/backend'], bots: ['greptile-apps[bot]'] })
	await as('/api/issue/start', {})
	h.gh.pr(rawPr({ required: [{ name: 'tests', bucket: 'pending' }] }))
	expect((await await cli(['pr', 'ready', '--request'])).err).toContain('checks are pending')
	h.gh.pr(rawPr())
	expect((await await cli(['pr', 'ready', '--request'])).err).toContain('has not reviewed the head')
	const botThread = thread([comment(bot(), 'Possible null', 1)])
	h.gh.pr(rawPr({ reviews: [review(bot(), 'COMMENTED', 1)], threads: [botThread] }))
	expect((await await cli(['pr', 'ready', '--request'])).err).toContain('bot item(s) need action')
	await cli(['pr', 'ignore', botThread.id, '-'], 'A false positive: the value is checked above')
	const res = await cli(['pr', 'ready', '--request'])
	expect(res.code).toBe(0)
	expect(ghCalls('--add-reviewer')[0]!.args).toContain('anna,acme/backend')
})

test('waiting on a review is not stuck: no nudge, shown as waiting, overdue after the setting', async () => {
	await as('/api/issue/wait', { on: 'review', note: 'anna' })
	h.replies({ showByThread: { t1: idle } })
	await h.server.checkQuiet(Date.now() + 5 * 60 * 60_000)
	expect(sends()).toHaveLength(0)
	let board = (await h.call('GET', '/api/board')).body
	expect(board.issues[0].waiting).toMatchObject({ on: 'review', note: 'anna', overdue: false })
	expect(board.needsYou).toBe(0)
	h.server.db.query(`update issues set waiting_since = $at`).run({ at: Date.now() - 25 * 60 * 60_000 })
	board = (await h.call('GET', '/api/board')).body
	expect(board.issues[0].waiting.overdue).toBe(true)
	await as('/api/issue/report', { text: 'back to work' })
	expect((await h.call('GET', '/api/board')).body.issues[0].waiting).toBeNull()
})

test('the safety net wakes an idle thread with work three times, 30 minutes apart, then asks the user', async () => {
	h.gh.pr(rawPr({ threads: [thread([comment(member('anna'), 'Close the stream', 1)])] }))
	await as('/api/issue/wait', { on: 'review' })
	h.replies({ showByThread: { t1: idle } })
	const at = (minutes: number) => Date.now() + minutes * 60_000
	await h.server.reconcile(at(0))
	expect(sends()).toHaveLength(1)
	expect(sends()[0]!.stdin).toContain('review item(s) need action')
	await h.server.reconcile(at(10))
	expect(sends()).toHaveLength(1)
	await h.server.reconcile(at(31))
	await h.server.reconcile(at(62))
	await h.server.reconcile(at(93))
	expect(sends()).toHaveLength(3)
	expect((await h.call('GET', '/api/board')).body.needsYou).toBe(1)
	await cli(['pr', 'sync'])
	expect((await h.call('GET', '/api/board')).body.needsYou).toBe(0)
})

test('the safety net sends nothing while nothing needs the thread, or while it works', async () => {
	h.gh.pr(rawPr({ required: [{ name: 'tests', bucket: 'pending' }] }))
	await as('/api/issue/wait', { on: 'checks' })
	h.replies({ showByThread: { t1: idle } })
	await h.server.reconcile()
	expect(sends()).toHaveLength(0)
	h.gh.pr(rawPr())
	h.replies({ showByThread: { t1: busy } })
	await h.server.reconcile()
	expect(sends()).toHaveLength(0)
	h.replies({ showByThread: { t1: idle } })
	await h.server.reconcile()
	expect(sends()[0]!.stdin).toContain('the checks pass')
})

test('a PR merged or closed while T3 no longer has the thread closes the issue', async () => {
	h.gh.pr(rawPr({ view: { state: 'MERGED', mergedBy: { login: 'anna' } } }))
	await as('/api/issue/wait', { on: 'merge' })
	await h.server.reconcile()
	const merged = (await issue()).issue
	expect([merged.state, merged.outcome, merged.deploy]).toEqual(['shipped', 'shipped', 'unverified'])
	expect(merged.summary).toContain('@anna')

	await h.as('t2')('POST', '/api/issue/start', { cwd: work, title: 'Second' })
	await h.as('t2')('POST', '/api/issue/update', { pr: 'https://github.com/acme/api/pull/8' })
	await h.as('t2')('POST', '/api/issue/wait', { on: 'review' })
	h.gh.pr(rawPr({ view: { state: 'CLOSED' } }))
	await h.server.reconcile()
	expect((await h.call('GET', '/api/issues/t2')).body.issue.outcome).toBe('dropped')
})

test("when the service's gh cannot read the PR, the safety net says it is off and sends nothing", async () => {
	h.gh.replies({ view: { code: 1, out: 'HTTP 404: Not Found' } })
	await as('/api/issue/wait', { on: 'review' })
	h.replies({ showByThread: { t1: idle } })
	await h.server.reconcile()
	expect(sends()).toHaveLength(0)
	expect((await issue()).waiting.safetyNet).toContain('off')
})

test('reply --fixed posts the commit with the note and the marker, resolves, and records; a foreign commit is refused', async () => {
	const ask = thread([comment(member('anna'), 'Close the stream', 1)])
	h.gh.pr(rawPr({ threads: [ask] }))
	await cli(['pr', 'sync'])
	h.gh.replies({ compare: { out: 'diverged' } })
	const refused = await cli(['pr', 'reply', ask.id, '--fixed', 'deadbeef'])
	expect(refused.err).toContain('is not in the PR')
	expect(ghCalls('addPullRequestReviewThreadReply')).toHaveLength(0)
	h.gh.replies({})
	const res = await cli(['pr', 'reply', ask.id, '--fixed', 'abc1234'])
	expect(res.code).toBe(0)
	const body = ghCalls('addPullRequestReviewThreadReply')[0]!.args.find((a) => a.startsWith('body='))!
	expect(body).toContain('Fixed in abc1234.')
	expect(body).toContain('responding on behalf of factory-user')
	expect(body).toContain('<!-- factory:t1 -->')
	expect(ghCalls('resolveReviewThread')).toHaveLength(1)
	const item = (await issue()).items[0]
	expect(item).toMatchObject({ handled: 'fixed', handledCommit: 'abc1234', state: 'resolved', needsAction: false })
})

test("declining a person's conversation leaves it open; a bot's is resolved; ignore writes nothing", async () => {
	const person = thread([comment(member('anna'), 'Rename it', 1)])
	const botty = thread([comment(bot(), 'Maybe null', 1)])
	h.gh.pr(rawPr({ threads: [person, botty] }))
	await cli(['pr', 'sync'])
	await cli(['pr', 'reply', person.id, '--declined', '-'], '`total` is the domain term')
	expect(ghCalls('resolveReviewThread')).toHaveLength(0)
	await cli(['pr', 'reply', botty.id, '--declined', '-'], 'Checked on line 3')
	expect(ghCalls('resolveReviewThread')).toHaveLength(1)
	const writes = h.gh.calls().length
	const extra = thread([comment(bot(), 'Style', 1)])
	h.gh.pr(rawPr({ threads: [person, botty, extra] }))
	await cli(['pr', 'sync'])
	await cli(['pr', 'ignore', extra.id])
	expect(h.gh.calls().slice(writes).every((c) => !c.args.join(' ').match(/mutation|pr comment|pr edit/))).toBe(true)
	const gate = (await await cli(['gate'])).json
	expect(gate.blockers.map((b: { code: string }) => b.code)).toContain('threads')
})

test('round posts one summary, asks again who requested changes, and leaves nothing to act on', async () => {
	const ask = thread([comment(member('anna'), 'Close the stream', 1)])
	h.gh.pr(rawPr({ threads: [ask], reviews: [review(member('anna'), 'CHANGES_REQUESTED', 2, 'See the thread')] }))
	const synced = (await await cli(['pr', 'sync'])).json
	expect(synced.needsAction).toHaveLength(2)
	await cli(['pr', 'reply', ask.id, '--fixed', 'abc1234'])
	const reviewItem = synced.needsAction.find((i: { kind: string }) => i.kind === 'review').id
	await cli(['pr', 'reply', reviewItem, '--answered', '-'], 'Done in the thread')
	const res = await cli(['pr', 'round', '-'], 'Round 1: closed the stream.')
	expect(res.code).toBe(0)
	expect(ghCalls('pr comment').filter((c) => c.stdin?.includes('Round 1'))).toHaveLength(1)
	expect(ghCalls('requested_reviewers')[0]!.args).toContain('reviewers[]=anna')
	const after = (await await cli(['pr', 'sync'])).json
	expect(after.needsAction).toEqual([])
	expect(after.round).toBeNull()
})

test('a fourth push in a round blocks the gate and round, until the user says go on', async () => {
	const ask = thread([comment(member('anna'), 'Close the stream', 1)])
	for (const head of [HEAD, 'b1', 'b2', 'b3', 'b4'].map((h) => h.padEnd(40, '0'))) {
		h.gh.pr(rawPr({ threads: [ask], view: { headRefOid: head } }))
		await cli(['pr', 'sync'])
	}
	expect((await await cli(['gate'])).json.blockers.map((b: { code: string }) => b.code)).toContain('round-budget')
	expect((await await cli(['pr', 'round', '-'], 'summary')).err).toContain('round refused')
	const asked = await as('/api/issue/ask', { kind: 'blocked', round: true, question: 'Go on with round 1?', recommend: 'Go on' })
	expect((await issue()).decisions[0].options).toEqual(['Go on', 'Stop'])
	await h.call('POST', `/api/decisions/${asked.body.decision}/answer`, { answer: 'Go on' })
	expect((await await cli(['gate'])).json.blockers.map((b: { code: string }) => b.code)).not.toContain('round-budget')
})

test('after a push the gate wants a risk check and a review or approval of the new head', async () => {
	await storeResults()
	h.gh.pr(rawPr())
	await as('/api/issue/risk', { head: HEAD, none: true })
	expect((await await cli(['gate'])).json).toEqual({ ready: true, head: HEAD, blockers: [] })
	const pushed = 'f'.repeat(40)
	h.gh.pr(rawPr({ view: { headRefOid: pushed } }))
	const codes = (await await cli(['gate'])).json.blockers.map((b: { code: string }) => b.code)
	expect(codes).toEqual(['internal-review', 'risk-unchecked'])
	await as('/api/issue/risk', { head: pushed, none: true })
	h.gh.pr(rawPr({ view: { headRefOid: pushed }, reviews: [review(member('anna'), 'APPROVED', 3, '', pushed)] }))
	expect((await await cli(['gate'])).json.ready).toBe(true)
})

test('a merge decision clears ask only when answered Merge on the current head; never cannot be loosened', async () => {
	await storeResults()
	h.gh.pr(rawPr())
	await as('/api/issue/risk', { head: HEAD, none: true })
	await as('/api/issue/update', { merge: 'ask' })
	const ask = (head: string) => as('/api/issue/ask', { kind: 'merge', head, question: 'Merge?', recommend: 'Merge' })
	expect((await as('/api/issue/ask', { kind: 'merge', head: HEAD, question: 'Merge?', recommend: 'Merge', options: ['Yes'] })).status).toBe(400)
	const no = (await ask(HEAD)).body.decision
	await h.call('POST', `/api/decisions/${no}/answer`, { answer: 'Do not merge' })
	expect((await await cli(['gate'])).json.blockers.map((b: { code: string }) => b.code)).toEqual(['merge-setting'])
	const old = (await ask('0'.repeat(40))).body.decision
	await h.call('POST', `/api/decisions/${old}/answer`, { answer: 'Merge' })
	expect((await await cli(['gate'])).json.blockers.map((b: { code: string }) => b.code)).toEqual(['merge-setting'])
	const yes = (await ask(HEAD)).body.decision
	await h.call('POST', `/api/decisions/${yes}/answer`, { answer: 'Merge' })
	expect((await await cli(['gate'])).json.ready).toBe(true)
	await as('/api/issue/update', { merge: 'never' })
	expect((await as('/api/issue/update', { merge: 'ask' })).status).toBe(400)
	expect((await await cli(['gate'])).json.blockers.map((b: { code: string }) => b.code)).toEqual(['merge-setting'])
})

test('a sync by the thread ends a wait for checks that have passed, so the service wakes it for them no more', async () => {
	h.gh.pr(rawPr())
	await as('/api/issue/wait', { on: 'checks' })
	await cli(['pr', 'sync'])
	expect((await as('/api/issue/status', {})).body.waiting).toBeNull()
	h.replies({ showByThread: { t1: idle } })
	await h.server.reconcile()
	expect(sends()).toHaveLength(0)
})

test('a pull request in a repository with no workflow reads as checks absent, and reviewers can be requested', async () => {
	h.gh.pr(rawPr({ required: [], workflows: 0, view: { statusCheckRollup: [] } }))
	const synced = (await cli(['pr', 'sync'])).json
	expect(synced.pr.checks.state).toBe('absent')
	expect(synced.gate.blockers.map((b: { code: string }) => b.code)).not.toContain('checks')
	expect((await cli(['pr', 'ready', '--request'])).code).toBe(0)
})

test('a PR a person merged while the issue waited on a decision, not on GitHub, is told to the thread', async () => {
	await as('/api/issue/ask', { kind: 'blocked', question: 'The review model refused the run. How to go on?', recommend: 'Wait' })
	h.gh.pr(rawPr({ required: [{ name: 'tests', bucket: 'fail' }] }))
	h.replies({ showByThread: { t1: idle } })
	await h.server.reconcile()
	expect(sends()).toHaveLength(0)
	h.gh.pr(rawPr({ view: { state: 'MERGED', mergedBy: { login: 'anna' } } }))
	await h.server.reconcile()
	expect(sends()).toHaveLength(1)
	expect(sends()[0]!.stdin).toContain('the PR was merged')
})
