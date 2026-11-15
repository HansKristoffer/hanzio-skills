import { afterEach, beforeEach, expect, test } from 'bun:test'
import { join } from 'node:path'
import { scratchRepo, setup, type Harness } from './fixtures/harness.ts'

let h: Harness
const MINUTE = 60_000
const ended = { code: 0, out: JSON.stringify({ thread: { status: 'completed', pendingRequestCount: 0 } }) }
const working = { code: 0, out: JSON.stringify({ thread: { status: 'running', pendingRequestCount: 0 } }) }

beforeEach(async () => {
	h = setup()
	const { work } = scratchRepo(h.dir)
	await h.as('t1')('POST', '/api/issue/start', { cwd: work, title: 'Quiet issue' })
})
afterEach(() => h.close())

const sends = () => h.calls().filter((c) => c.args[1] === 'send')
const later = (minutes: number) => Date.now() + minutes * MINUTE

test('a quiet issue whose threads have all ended gets one nudge that says what to do', async () => {
	h.replies({ showByThread: { t1: ended } })
	await h.server.checkQuiet(later(10))
	expect(sends()).toHaveLength(0)
	await h.server.checkQuiet(later(21))
	expect(sends()).toHaveLength(1)
	expect(sends()[0]!.stdin).toContain('Run factory status')
	await h.server.checkQuiet(later(22))
	expect(sends()).toHaveLength(1)
})

test("an issue whose child's thread still works is not nudged", async () => {
	const run = (await h.as('t1')('POST', '/api/issue/run', { stage: 'implement' })).body.run
	await h.as('child')('POST', `/api/runs/${run}/report`, { text: 'tests red' })
	h.replies({ showByThread: { t1: ended, child: working } })
	await h.server.checkQuiet(later(30))
	expect(sends()).toHaveLength(0)
})

test('an issue waiting on a blocking decision is not nudged', async () => {
	await h.as('t1')('POST', '/api/issue/ask', { kind: 'plan', question: 'Approve?', recommend: 'Approve' })
	h.replies({ showByThread: { t1: ended } })
	await h.server.checkQuiet(later(60))
	expect(sends()).toHaveLength(0)
})

test('after two nudges with no report the issue shows as stuck, and a report clears it', async () => {
	h.replies({ showByThread: { t1: ended } })
	await h.server.checkQuiet(later(21))
	await h.server.checkQuiet(later(42))
	await h.server.checkQuiet(later(63))
	expect(sends()).toHaveLength(2)
	let board = await h.call('GET', '/api/board')
	expect(board.body.issues[0].stuck).toBe(true)
	expect(board.body.needsYou).toBe(1)
	await h.as('t1')('POST', '/api/issue/report', { text: 'back' })
	board = await h.call('GET', '/api/board')
	expect(board.body.issues[0].stuck).toBe(false)
})

test('a running land stage gets an hour before a nudge', async () => {
	await h.as('t1')('POST', '/api/issue/run', { stage: 'land' })
	h.replies({ showByThread: { t1: ended } })
	await h.server.checkQuiet(later(30))
	expect(sends()).toHaveLength(0)
	await h.server.checkQuiet(later(61))
	expect(sends()).toHaveLength(1)
})

test('a thread T3 cannot show is left alone', async () => {
	await h.server.checkQuiet(later(30))
	expect(sends()).toHaveLength(0)
})

const idle = (thread: Record<string, unknown>) => ({
	code: 0,
	out: JSON.stringify({ thread: { status: 'completed', pendingRequestCount: 0, ...thread } })
})

test('a thread whose turn ended but that still waits on a build, a child or a snooze is not nudged', async () => {
	for (const waiting of [{ pendingBackgroundTasks: [{ id: 'build' }] }, { blockedOnThreadWait: true }, { snoozed: true }]) {
		h.replies({ showByThread: { t1: idle(waiting) } })
		await h.server.checkQuiet(later(30))
		expect(sends()).toHaveLength(0)
	}
	h.replies({ showByThread: { t1: idle({ pendingBackgroundTasks: [] }) } })
	await h.server.checkQuiet(later(30))
	expect(sends()).toHaveLength(1)
})

test('wait --on limit takes a reset time that is ahead, and no more than a week ahead', async () => {
	const wait = (until?: string) => h.as('t1')('POST', '/api/issue/wait', { on: 'limit', until })
	expect((await wait()).status).toBe(400)
	expect((await wait('not a time')).status).toBe(400)
	expect((await wait(new Date(later(-5)).toISOString())).body.error).toContain('has passed')
	expect((await wait(new Date(later(10 * 24 * 60)).toISOString())).body.error).toContain('blocked decision')
	expect((await h.as('t1')('POST', '/api/issue/wait', { on: 'checks', until: '2026-01-01' })).status).toBe(400)
	expect((await wait(new Date(later(90)).toISOString())).status).toBe(200)
})

test('an issue paused on a usage limit is left alone until the reset, then woken once', async () => {
	const until = later(90)
	const waited = await h.as('t1')('POST', '/api/issue/wait', { on: 'limit', until: new Date(until).toISOString(), note: 'claude: weekly limit' })
	expect(waited.body.waiting).toMatchObject({ on: 'limit', until, note: 'claude: weekly limit' })
	let board = await h.call('GET', '/api/board')
	expect(board.body.limited).toEqual([{ issue: 't1', title: 'Quiet issue', until, note: 'claude: weekly limit' }])
	expect(board.body.needsYou).toBe(0)

	h.replies({ showByThread: { t1: ended } })
	await h.server.checkQuiet(later(60))
	expect(sends()).toHaveLength(0)
	await h.server.checkQuiet(later(91))
	expect(sends()).toHaveLength(1)
	expect(sends()[0]!.stdin).toContain('has reset')
	expect(sends()[0]!.stdin).toContain('claude: weekly limit')
	board = await h.call('GET', '/api/board')
	expect(board.body.limited).toEqual([])
	expect(board.body.issues[0].waiting).toBeNull()
})

test('a report from the thread ends its wait on a usage limit', async () => {
	await h.as('t1')('POST', '/api/issue/wait', { on: 'limit', until: new Date(later(90)).toISOString() })
	await h.as('t1')('POST', '/api/issue/report', { text: 'back early on the fallback' })
	const board = await h.call('GET', '/api/board')
	expect(board.body.limited).toEqual([])
})

test("a message stuck in an idle thread's queue is shown once, holds the next nudge, and clears when it arrives", async () => {
	h.replies({ showByThread: { t1: ended }, stuckQueue: ['t1'] })
	await h.server.checkQuiet(later(21))
	expect(sends()).toHaveLength(1)
	await h.server.checkQuiet(later(25))
	let board = await h.call('GET', '/api/board')
	expect(board.body.issues[0].undelivered).toBe(true)
	expect(board.body.needsYou).toBe(1)
	await h.server.checkQuiet(later(60))
	expect(sends()).toHaveLength(1)
	let status = await h.call('GET', '/api/issues/t1')
	expect(status.body.events.filter((e: { kind: string }) => e.kind === 'queue')).toHaveLength(1)

	h.replies({ showByThread: { t1: ended } })
	await h.server.checkQuiet(later(61))
	board = await h.call('GET', '/api/board')
	expect(board.body.issues[0].undelivered).toBe(false)
	status = await h.call('GET', '/api/issues/t1')
	expect(status.body.events.at(-1).text).toContain('reached the thread after all')
})

test('a message waiting behind a busy turn is not shown as stuck', async () => {
	h.replies({ showByThread: { t1: ended }, stuckQueue: ['t1'] })
	await h.server.checkQuiet(later(21))
	h.replies({ showByThread: { t1: working }, stuckQueue: ['t1'] })
	await h.server.checkQuiet(later(60))
	const board = await h.call('GET', '/api/board')
	expect(board.body.issues[0].undelivered).toBe(false)
})

test('the board counts stage runs that failed in the last hour, by issue', async () => {
	const { work } = scratchRepo(join(h.dir, 'second'), 'acme/web')
	await h.as('t2')('POST', '/api/issue/start', { cwd: work, title: 'Second issue' })
	for (const thread of ['t1', 't2']) {
		const run = (await h.as(thread)('POST', '/api/issue/run', { stage: 'research' })).body.run
		await h.as(thread)('POST', `/api/runs/${run}/report`, { text: 'Provider error 503', failed: true })
	}
	const board = await h.call('GET', '/api/board')
	expect(board.body.failing).toEqual({ issues: 2, runs: 2, reasons: ['Provider error 503'] })
})

test('runs ended by dropping an issue do not count as failing', async () => {
	await h.as('t1')('POST', '/api/issue/run', { stage: 'research' })
	await h.call('POST', '/api/issues/t1/drop', {})
	const board = await h.call('GET', '/api/board')
	expect(board.body.failing.issues).toBe(0)
})
