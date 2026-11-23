import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { networkInterfaces } from 'node:os'
import { MIGRATIONS, openDatabase } from './db.ts'
import { detectTailnet } from './server.ts'
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

describe('issues', () => {
	test('starting twice in one thread keeps one issue', async () => {
		const first = await start('t1', { body: 'Large accounts time out.' })
		expect(first.status).toBe(200)
		expect(first.body.issue).toBe('t1')
		const second = await start('t1')
		expect(second.body.issue).toBe('t1')
		const board = await h.call('GET', '/api/board')
		expect(board.body.open).toBe(1)
		expect(board.body.issues[0].repo).toBe('acme/api')
		expect(board.body.issues[0].stage).toBe('research')
	})

	test('the board names the stages that ran and the run that is going', async () => {
		await start('t1')
		const fresh = (await h.call('GET', '/api/board')).body.issues[0]
		expect(fresh.ran).toEqual([])
		expect(fresh.run).toBeNull()
		const research = (await h.as('t1')('POST', '/api/issue/run', { stage: 'research' })).body.run
		await h.as('child')('POST', `/api/runs/${research}/report`, { text: 'child crashed', failed: true })
		await h.as('t1')('POST', '/api/issue/run', { stage: 'implement' })
		const item = (await h.call('GET', '/api/board')).body.issues[0]
		expect(item.ran).toEqual(['research', 'implement'])
		expect(item.failedStages).toEqual(['research'])
		expect(item.findings).toEqual({ total: 0, open: 0, important: 0 })
		expect(item.run.stage).toBe('implement')
		expect(typeof item.run.startedAt).toBe('number')
	})

	test('a command without a thread is refused', async () => {
		const res = await h.call('POST', '/api/issue/status', {})
		expect(res.status).toBe(400)
		expect(res.body.error).toContain('T3 Code thread')
	})

	test("a run binds to its first reporter; another thread is refused, the issue's own thread may end it", async () => {
		await start('t1')
		const run = await h.as('t1')('POST', '/api/issue/run', { stage: 'land' })
		expect(run.status).toBe(200)
		const research = await h.as('t1')('POST', '/api/issue/run', { stage: 'research' })
		const id = research.body.run
		expect((await h.as('child-a')('POST', `/api/runs/${id}/report`, { text: 'reproduced' })).status).toBe(200)
		const other = await h.as('child-b')('POST', `/api/runs/${id}/report`, { text: 'mine now' })
		expect(other.status).toBe(403)
		expect(other.body.error).toContain('another thread')
		const ended = await h.as('t1')('POST', `/api/runs/${id}/report`, { text: 'child crashed', failed: true })
		expect(ended.status).toBe(200)
		const status = await h.as('t1')('POST', '/api/issue/status', {})
		const runs = status.body.runs as { id: string; state: string }[]
		expect(runs.find((r) => r.id === id)?.state).toBe('failed')
		expect(status.body.stage).toBe('land')
	})

	test('--done without --run is refused, and a closed issue takes no reports', async () => {
		await start('t1')
		expect((await h.as('t1')('POST', '/api/issue/report', { text: 'x', done: true })).status).toBe(400)
		const closed = await h.as('t1')('POST', '/api/issue/close', { outcome: 'not-a-bug', summary: 'CI runner path' })
		expect(closed.status).toBe(200)
		expect((await h.as('t1')('POST', '/api/issue/report', { text: 'late' })).status).toBe(409)
	})

	test('shipped needs a deploy, and close ends running runs', async () => {
		await start('t1')
		await h.as('t1')('POST', '/api/issue/run', { stage: 'land' })
		expect((await h.as('t1')('POST', '/api/issue/close', { outcome: 'shipped', summary: 'done' })).status).toBe(400)
		const ok = await h.as('t1')('POST', '/api/issue/close', {
			outcome: 'shipped',
			deploy: 'verified',
			summary: 'Merged and live',
			report: '**Outcome:** shipped'
		})
		expect(ok.status).toBe(200)
		const issue = await h.call('GET', '/api/issues/t1')
		expect(issue.body.issue.state).toBe('shipped')
		expect(issue.body.report).toBe('**Outcome:** shipped')
		expect(issue.body.runs[0].state).toBe('done')
	})

	test('the database refuses an event for an issue that does not exist', () => {
		expect(() =>
			h.server.db.query(`insert into events (issue_id, at, kind, text) values ('nope', 1, 'report', 'x')`).run()
		).toThrow(/FOREIGN KEY/)
	})

	test('a report over 2,000 characters is refused', async () => {
		await start('t1')
		const res = await h.as('t1')('POST', '/api/issue/report', { text: 'x'.repeat(2001) })
		expect(res.status).toBe(400)
		expect(res.body.error).toContain('2000')
	})
})

describe('requests', () => {
	test('a foreign Host is refused', async () => {
		const res = await fetch(`http://127.0.0.1:${h.port}/api/board`, { headers: { host: 'evil.example:80' } })
		expect(res.status).toBe(421)
	})

	test('a write from another origin is refused', async () => {
		const res = await fetch(`http://127.0.0.1:${h.port}/api/settings/global`, {
			method: 'PUT',
			headers: { 'content-type': 'application/json', origin: 'http://evil.example' },
			body: '{}'
		})
		expect(res.status).toBe(403)
		const same = await fetch(`http://127.0.0.1:${h.port}/api/settings/global`, {
			method: 'PUT',
			headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${h.port}` },
			body: '{}'
		})
		expect(same.status).toBe(200)
	})

	test('a write without JSON is refused', async () => {
		const res = await fetch(`http://127.0.0.1:${h.port}/api/settings/global`, { method: 'PUT', body: '{}' })
		expect(res.status).toBe(415)
	})

	const lan = Object.values(networkInterfaces())
		.flat()
		.find((i) => i && i.family === 'IPv4' && !i.internal)?.address
	test.skipIf(!lan)('a caller that is not on loopback cannot use the CLI routes', async () => {
		h.close()
		h = setup({ tailnet: { ip: lan!, name: 'test-host' } })
		const res = await fetch(`http://${lan}:${h.port}/api/issue/status`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', 'x-factory-thread': 't1' },
			body: '{}'
		})
		expect(res.status).toBe(403)
		const board = await fetch(`http://${lan}:${h.port}/api/board`)
		expect(board.status).toBe(200)
	})
})

test('the stream stays open while quiet and then carries a change', async () => {
	await start('t1')
	const res = await fetch(`http://127.0.0.1:${h.port}/api/stream`)
	const reader = res.body!.getReader()
	await Bun.sleep(12_000)
	await h.as('t1')('POST', '/api/issue/report', { text: 'still here' })
	const decoder = new TextDecoder()
	let seen = ''
	const until = Date.now() + 3000
	while (!seen.includes('"issue":"t1"') && Date.now() < until) {
		const { value, done } = await reader.read()
		if (done) break
		seen += decoder.decode(value)
	}
	await reader.cancel()
	expect(seen).toContain('id: ')
	expect(seen).toContain('event: change')
	expect(seen).toContain('"issue":"t1"')
	expect(seen).toContain('"kind":"report"')
	expect(seen).toContain('"open":1')
	expect(seen).toContain('"needsYou":0')
	expect(seen).toContain('"title":"Exports time out"')
}, 20_000)

test('the long-poll changes endpoint wakes immediately on updates and catches missed events', async () => {
	await start('t1')
	const initial = (await h.call('GET', '/api/changes?after=0&wait=0')).body
	expect(initial.seq).toBeGreaterThan(0)

	const waiting = h.call('GET', `/api/changes?after=${initial.seq}&wait=10`)
	await Bun.sleep(50)
	await h.as('t1')('POST', '/api/issue/report', { text: 'progress tick' })
	const woke = (await waiting).body
	expect(woke.seq).toBeGreaterThan(initial.seq)
	expect(woke.events.at(-1)).toMatchObject({ issue: 't1', kind: 'report', summary: 'progress tick', open: 1, needsYou: 0 })

	// A client polling with an older sequence catches the event immediately without waiting.
	const caught = (await h.call('GET', `/api/changes?after=${initial.seq}&wait=0`)).body
	expect(caught.seq).toBe(woke.seq)
	expect(caught.events.some((e: { summary?: string }) => e.summary === 'progress tick')).toBe(true)
})

test('a database at an older version is migrated at start', () => {
	const home = tempDir()
	openDatabase(home).close()
	const db = openDatabase(home, [...MIGRATIONS, 'create table extra (x text)'])
	expect((db.query('pragma user_version').get() as { user_version: number }).user_version).toBe(MIGRATIONS.length + 1)
	expect(db.query(`select name from sqlite_master where name = 'extra'`).get()).toBeTruthy()
	db.close()
	rmSync(home, { recursive: true, force: true })
})

test('a machine without Tailscale runs the server on loopback only', () => {
	const path = process.env.PATH
	process.env.PATH = tempDir()
	try {
		expect(detectTailnet()).toBeNull()
	} finally {
		process.env.PATH = path
	}
})

test('page message sends a note to the thread, board exposes repos, derived state, and flat brief', async () => {
	await start('t1')
	const research = (await h.as('t1')('POST', '/api/issue/run', { stage: 'research' })).body.run
	await h.as('child')('POST', `/api/runs/${research}/report`, {
		text: 'done',
		done: true,
		result: { outcome: 'done', result: { asked: 'Large account exports time out', kind: 'bug', size: 'S', route: 'implement', checks: [] } }
	})
	const plan = (await h.as('t1')('POST', '/api/issue/run', { stage: 'plan' })).body.run
	await h.as('child-p')('POST', `/api/runs/${plan}/report`, {
		text: 'planned',
		done: true,
		result: {
			outcome: 'done',
			result: {
				planned: 'Stream rows in chunks.',
				outline: ['Chunk export queries'],
				plan: '# Plan\n\nStream CSV rows.',
				criteria: ['Export completes under 2s'],
				proof: 'unit test',
				undecided: [],
				later: [{ title: 'Add progress bar', body: 'Show export progress in UI.' }]
			}
		}
	})
	const board = (await h.call('GET', '/api/board')).body
	expect(board.repos).toEqual(['acme/api'])
	expect(board.needsByRepo).toEqual({})
	expect(board.issues[0].asked).toBe('Large account exports time out')
	expect(board.issues[0].autoShip).toBe(false)
	expect(board.issues[0].derived.group).toBe('paused')
	expect(board.issues[0].derived.stages.map((s: { stage: string; state: string }) => [s.stage, s.state])).toEqual([
		['research', 'done'],
		['plan', 'current'],
		['implement', 'pending'],
		['review', 'pending'],
		['land', 'pending']
	])
	expect(board.issues[0].lastEvent.issueId).toBe('t1')
	expect(board.issues[0].lastEvent.issue_id).toBeUndefined()

	const detail = (await h.call('GET', '/api/issues/t1')).body
	expect(detail.derived.group).toBe('paused')
	expect(detail.brief.asked).toBe('Large account exports time out')
	expect(detail.brief.planned).toBe('Stream rows in chunks.')
	expect(detail.brief.outline).toEqual(['Chunk export queries'])
	expect(detail.brief.criteria).toEqual(['Export completes under 2s'])
	expect(detail.brief.later).toEqual([{ title: 'Add progress bar', body: 'Show export progress in UI.' }])
	expect(detail.brief.plan).toContain('Stream CSV rows.')
	expect(detail.events[0].issueId).toBe('t1')
	expect(detail.events[0].issue_id).toBeUndefined()
	expect(detail.events.some((e: { runId: string | null }) => e.runId === research)).toBe(true)

	const health = (await h.call('GET', '/health')).body
	expect(health.ok).toBe(true)
	expect(health.pid).toBe(process.pid)
	expect(health.port).toBe(h.port)
	expect(health.tailnet).toBeNull()

	// Legacy consolidated routes are removed.
	expect((await h.call('GET', '/api/repos')).status).toBe(404)
	expect((await h.call('PUT', '/api/stores/acme/api', { store: 'machine' })).status).toBe(404)
	expect((await h.call('POST', '/api/decisions/d_none/answer', { answer: 'x' })).status).toBe(404)

	expect((await h.call('POST', '/api/github/fetch', { url: 'https://example.com/not-github' })).status).toBe(400)

	h.replies({ showByThread: { t1: { code: 0, out: JSON.stringify({ thread: { status: 'completed', pendingRequestCount: 0 } }) } } })
	const msg = await h.call('POST', '/api/issues/t1/message', { message: 'Please also check mobile layout' })
	expect(msg.status).toBe(200)
	const sends = h.calls().filter((c) => c.args[1] === 'send')
	expect(sends.at(-1)!.stdin).toContain('Please also check mobile layout')
})

test('page and large JSON responses support gzip and ETag conditional requests, and board.done includes cycle metrics', async () => {
	const first = await fetch(`http://127.0.0.1:${h.port}/`, { headers: { 'accept-encoding': 'gzip' } })
	expect(first.status).toBe(200)
	expect(first.headers.get('content-encoding')).toBe('gzip')
	const etag = first.headers.get('etag')
	expect(etag).toBeTruthy()
	const html = await first.text()
	expect(html).toContain('<!doctype html>')

	const notModified = await fetch(`http://127.0.0.1:${h.port}/`, { headers: { 'if-none-match': etag! } })
	expect(notModified.status).toBe(304)
	expect(await notModified.text()).toBe('')

	await start('t1', { body: 'x'.repeat(2000) })
	await h.as('t1')('POST', '/api/issue/run', { stage: 'review' })
	await h.as('t1')('POST', '/api/issue/close', { outcome: 'shipped', deploy: 'verified', summary: 'Shipped fast' })
	const boardRes = await fetch(`http://127.0.0.1:${h.port}/api/board`, { headers: { 'accept-encoding': 'gzip' } })
	expect(boardRes.status).toBe(200)
	const boardBody = await boardRes.json()
	expect(boardBody.done).toHaveLength(1)
	expect(boardBody.done[0].minutes).toBeGreaterThanOrEqual(0)
	expect(boardBody.done[0].reviewRounds).toBe(1)
	expect(boardBody.done[0].merged).toBeNull()

	const detailRes = await fetch(`http://127.0.0.1:${h.port}/api/issues/t1`, { headers: { 'accept-encoding': 'gzip' } })
	expect(detailRes.status).toBe(200)
	expect(detailRes.headers.get('content-encoding')).toBe('gzip')
	const detailBody = await detailRes.json()
	expect(detailBody.body).toHaveLength(2000)
})

test('GET /api/issues/batch returns multiple issue details matching single-issue reads and skips missing ids', async () => {
	await start('t1', { title: 'Batch alpha', body: 'a'.repeat(5000) })
	await start('t2', { title: 'Batch beta', body: 'b'.repeat(5000) })
	await h.as('t1')('POST', '/api/issue/report', { text: 'Alpha note' })
	await h.as('t2')('POST', '/api/issue/report', { text: 'Beta note' })

	const emptyRes = await h.call('GET', '/api/issues/batch')
	expect(emptyRes.status).toBe(200)
	expect(emptyRes.body).toEqual({ issues: {} })

	const batchHttp = await fetch(`http://127.0.0.1:${h.port}/api/issues/batch?ids=t1,t2,t1,missing`, {
		headers: { 'accept-encoding': 'gzip' }
	})
	expect(batchHttp.status).toBe(200)
	expect(batchHttp.headers.get('content-encoding')).toBe('gzip')
	const batchBody = await batchHttp.json()
	expect(Object.keys(batchBody.issues).sort()).toEqual(['t1', 't2'])

	const single1 = (await h.call('GET', '/api/issues/t1')).body
	const single2 = (await h.call('GET', '/api/issues/t2')).body
	expect(batchBody.issues.t1).toEqual(single1)
	expect(batchBody.issues.t2).toEqual(single2)
})
