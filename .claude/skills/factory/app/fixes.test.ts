// What probing the first build turned up: duplicate races, dead threads, the stage shown, the tailnet
// names, a long issue text, and settings stored before a key existed.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { networkInterfaces } from 'node:os'
import { MIGRATIONS, openDatabase, parseResolved, type IssueRow } from './db.ts'
import { scratchRepo, setup, tempDir, type Harness } from './fixtures/harness.ts'

let h: Harness
let work: string

beforeEach(() => {
	h = setup()
	work = scratchRepo(h.dir).work
})
afterEach(() => h.close())

const start = (thread: string, extra: Record<string, unknown> = {}) =>
	h.as(thread)('POST', '/api/issue/start', { cwd: work, title: 'Exports time out', ...extra })
const sends = () => h.calls().filter((c) => c.args[1] === 'send')
const starts = () => h.calls().filter((c) => c.args[1] === 'start')
const openCount = () => (h.server.db.query(`select count(*) as n from issues where state = 'open'`).get() as { n: number }).n
const ended = { code: 0, out: JSON.stringify({ thread: { status: 'completed', pendingRequestCount: 0 } }) }
const later = (minutes: number) => Date.now() + minutes * 60_000

test('two threads starting one item at the same moment make one issue', async () => {
	const [a, b] = await Promise.all([start('t1', { source: 'sentry:1' }), start('t2', { source: 'sentry:1' })])
	expect(openCount()).toBe(1)
	const answers = [a.body, b.body]
	expect(answers.filter((x) => x.issue)).toHaveLength(1)
	expect(answers.filter((x) => x.duplicateOf)).toHaveLength(1)
})

test('two new calls for one item start one thread, and a failed start frees the item', async () => {
	const body = { cwd: work, title: 'Exports time out', source: 'sentry:2' }
	const [a, b] = await Promise.all([h.call('POST', '/api/threads', body), h.call('POST', '/api/threads', body)])
	expect(starts()).toHaveLength(1)
	expect([a.body, b.body].filter((x) => x.duplicateOf)).toHaveLength(1)

	h.replies({ start: { code: 1, out: 'T3 Code is not running' } })
	const failed = await h.call('POST', '/api/threads', { ...body, source: 'sentry:3' })
	expect(failed.status).toBe(500)
	h.replies({})
	const retried = await h.call('POST', '/api/threads', { ...body, source: 'sentry:3' })
	expect(retried.body.duplicateOf).toBeUndefined()
	expect(starts()).toHaveLength(3)
})

test('a database holding duplicate open issues migrates, keeping the oldest open', () => {
	const home = tempDir()
	const old = openDatabase(home, MIGRATIONS.slice(0, 1))
	const insert = old.query(`insert into issues (id, title, repo, root, source, settings, created_at, updated_at)
		values ($id, 'x', 'acme/api', '/x', 'sentry:9', '{}', $at, $at)`)
	insert.run({ id: 'older', at: 1 })
	insert.run({ id: 'newer', at: 2 })
	old.close()
	const db = openDatabase(home)
	const rows = db.query('select id, state, outcome from issues order by created_at').all() as Partial<IssueRow>[]
	expect(rows).toEqual([
		{ id: 'older', state: 'open', outcome: null },
		{ id: 'newer', state: 'closed', outcome: 'duplicate' }
	])
	expect(db.query(`select name from sqlite_master where name = 'issues_open_source'`).get()).toBeTruthy()
	db.close()
	rmSync(home, { recursive: true, force: true })
})

test('three quiet checks where T3 cannot show the thread mark it gone; a show that works clears it', async () => {
	await start('t1')
	for (const minutes of [30, 35, 40]) await h.server.checkQuiet(later(minutes))
	let board = await h.call('GET', '/api/board')
	expect(board.body.issues[0].threadGone).toBe(true)
	expect(board.body.needsYou).toBe(1)
	expect(sends()).toHaveLength(0)
	h.replies({ showByThread: { t1: ended } })
	await h.server.checkQuiet(later(45))
	board = await h.call('GET', '/api/board')
	expect(board.body.issues[0].threadGone).toBe(false)
})

test('drop closes the issue, ends its runs, and tells a thread T3 still has', async () => {
	await start('t1')
	await h.as('t1')('POST', '/api/issue/run', { stage: 'research' })
	h.replies({ showByThread: { t1: ended } })
	const dropped = await h.call('POST', '/api/issues/t1/drop', { reason: 'Not worth it' })
	expect(dropped.body).toEqual({ ok: true, told: true })
	const issue = await h.call('GET', '/api/issues/t1')
	expect(issue.body.issue.outcome).toBe('dropped')
	expect(issue.body.runs[0].state).toBe('failed')
	expect(sends()).toHaveLength(1)
	expect(sends()[0]!.stdin).toContain('Not worth it')
	expect((await h.call('POST', '/api/issues/t1/drop', {})).status).toBe(409)
})

const lan = Object.values(networkInterfaces())
	.flat()
	.find((i) => i && i.family === 'IPv4' && !i.internal)?.address
test.skipIf(!lan)('the page drops an issue from another machine on the tailnet', async () => {
	h.close()
	h = setup({ tailnet: { ip: lan!, name: 'test-host.tail.ts.net' } })
	work = scratchRepo(h.dir).work
	await start('t1')
	const res = await fetch(`http://${lan}:${h.port}/api/issues/t1/drop`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: '{}'
	})
	expect(res.status).toBe(200)
})

test('the stage shown is the newest run still running, else the newest run', async () => {
	await start('t1')
	await h.as('t1')('POST', '/api/issue/run', { stage: 'land' })
	const fix = (await h.as('t1')('POST', '/api/issue/run', { stage: 'implement' })).body.run
	expect((await h.as('t1')('POST', '/api/issue/status', {})).body.stage).toBe('implement')
	await h.as('t1')('POST', `/api/runs/${fix}/report`, { text: 'fixed', failed: true })
	expect((await h.as('t1')('POST', '/api/issue/status', {})).body.stage).toBe('land')
})

test('starting a stage again ends its run that never ended', async () => {
	await start('t1')
	const first = (await h.as('t1')('POST', '/api/issue/run', { stage: 'research' })).body.run
	await h.as('t1')('POST', '/api/issue/run', { stage: 'research' })
	const runs = (await h.as('t1')('POST', '/api/issue/status', {})).body.runs as { id: string; state: string; summary: string }[]
	expect(runs.filter((r) => r.state === 'running')).toHaveLength(1)
	const old = runs.find((r) => r.id === first)!
	expect(old.state).toBe('failed')
	expect(old.summary).toContain('Superseded')
})

test('the short tailnet name is an allowed host', async () => {
	h.close()
	h = setup({ tailnet: { ip: '127.0.0.2', name: 'worker.tail1234.ts.net' } })
	for (const host of ['worker', 'worker.tail1234.ts.net', '127.0.0.2']) {
		const res = await fetch(`http://127.0.0.2:${h.port}/api/board`, { headers: { host: `${host}:${h.port}` } })
		expect(res.status).toBe(200)
	}
})

test('a tailnet address that cannot be bound leaves the server up on loopback', async () => {
	h.close()
	h = setup({ tailnet: { ip: '203.0.113.7', name: 'nowhere.tail.ts.net' } })
	expect((await h.call('GET', '/api/board')).status).toBe(200)
})

test('new reads the thread link from thread show when thread start prints none', async () => {
	h.replies({
		start: { out: JSON.stringify({ threadId: 'mcp:abc', projectId: 'p', runId: 'r' }) },
		showByThread: { 'mcp:abc': { out: JSON.stringify({ thread: { status: 'running', link: 'https://app.t3.codes/t/abc' } }) } }
	})
	const res = await h.call('POST', '/api/threads', { cwd: work, title: 'Linked' })
	expect(res.body.threadLink).toBe('https://app.t3.codes/t/abc')
	expect((await h.call('GET', '/api/issues/mcp%3Aabc')).body.issue.threadLink).toBe('https://app.t3.codes/t/abc')
})

test('an issue text over 100,000 characters is cut, and says how much was left out', async () => {
	const res = await start('t1', { body: 'x'.repeat(150_000) })
	expect(res.status).toBe(200)
	const body = (await h.call('GET', '/api/issues/t1')).body.body as string
	expect(body.startsWith('x'.repeat(100_000))).toBe(true)
	expect(body).toContain('50,000 more characters were left out')
})

test('settings stored before a key existed read that key as its default', async () => {
	await start('t1')
	const row = h.server.db.query(`select * from issues where id = 't1'`).get() as IssueRow
	const stored = JSON.parse(row.settings)
	delete stored.settings.reviewRounds
	delete stored.settings.merge
	h.server.db.query('update issues set settings = $s where id = $id').run({ s: JSON.stringify(stored), id: 't1' })
	const read = parseResolved(h.server.db.query(`select * from issues where id = 't1'`).get() as IssueRow)
	expect(read.settings.reviewRounds).toBe(2)
	expect(read.settings.merge).toBe('auto')
})
