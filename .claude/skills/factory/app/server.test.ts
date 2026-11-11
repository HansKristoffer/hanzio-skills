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
	expect(seen).toContain('event: change')
	expect(seen).toContain('"issue":"t1"')
}, 20_000)

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
