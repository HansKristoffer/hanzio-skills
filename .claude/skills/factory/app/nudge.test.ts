import { afterEach, beforeEach, expect, test } from 'bun:test'
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
