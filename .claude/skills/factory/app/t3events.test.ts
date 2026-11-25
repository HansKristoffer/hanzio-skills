import { afterEach, beforeEach, expect, test } from 'bun:test'
import { fakeT3Server } from './fixtures/fake-t3-server.ts'
import { scratchRepo, setup, type Harness } from './fixtures/harness.ts'

let h: Harness
let t3: ReturnType<typeof fakeT3Server>
let work: string
const GRACE_MS = 300
const ended = { code: 0, out: JSON.stringify({ thread: { status: 'completed', pendingRequestCount: 0 } }) }
const working = { code: 0, out: JSON.stringify({ thread: { status: 'running', pendingRequestCount: 0 } }) }

function boot(server = fakeT3Server()) {
	t3 = server
	process.env.FACTORY_T3_URL = t3.url
	h = setup({ t3Events: true, settleGraceMs: GRACE_MS })
	work = scratchRepo(h.dir).work
}
beforeEach(() => boot())
afterEach(() => {
	h.close()
	t3.stop()
	delete process.env.FACTORY_T3_URL
})

/** Waits until `check` holds, or fails after `ms`. */
async function until(check: () => boolean | Promise<boolean>, ms = 5000) {
	const deadline = Date.now() + ms
	while (!(await check())) {
		if (Date.now() > deadline) throw new Error('timed out waiting')
		await Bun.sleep(25)
	}
}
const live = async () => (await h.call('GET', '/api/mcp')).body.t3Events.state === 'live'
const nudges = () => h.calls().filter((c) => c.args[1] === 'send' && (c.stdin ?? '').includes('Run factory status'))
const start = (thread: string) => h.as(thread)('POST', '/api/issue/start', { cwd: work, title: 'Exports time out' })

test('the service signs itself in with a read-only pairing code, no browser, and streams the turns that end', async () => {
	await until(live)
	expect(t3.state).toMatchObject({ registered: 1, approved: 1 })
	const pairing = h.calls().find((c) => c.args[0] === 'auth' && c.args[1] === 'pairing')!
	expect(pairing.args).toEqual(expect.arrayContaining(['create', '--scope', 'orchestration:read', '--ttl', '5m', '--json']))
	const { params } = t3.state.streams[0]!.body
	expect(params).toMatchObject({ name: 'thread.run_settled', arguments: { includeSubagentChildren: true }, cursor: null })
	expect(params._meta['io.modelcontextprotocol/protocolVersion']).toBe('2026-07-28')
	const info = (await h.call('GET', '/api/mcp')).body.t3Events
	expect(Date.parse(info.expiresAt) || info.expiresAt).toBeGreaterThan(Date.now() + 29 * 24 * 60 * 60 * 1000)
})

test('a turn that ends with nothing running is nudged after the grace, not after 20 minutes', async () => {
	await start('t1')
	await until(live)
	h.replies({ showByThread: { t1: ended } })
	t3.settle('t1')
	await until(() => nudges().length === 1)
	expect(nudges()[0]!.stdin).toContain('ended its turn with nothing running')
	// The row is written once the send returns, a moment after the fake t3 logged it.
	const nudge = () => h.server.db.query(`select text from events where issue_id = 't1' and kind = 'nudge'`).get() as { text: string } | null
	await until(() => nudge() !== null)
	expect(nudge()!.text).toBe('Nudged: the turn ended with no next step')
})

test("a child's turn that ends while the issue's thread works again is left alone", async () => {
	await start('t1')
	await until(live)
	h.replies({ showByThread: { t1: working } })
	t3.settle('child-1', 't1')
	await Bun.sleep(GRACE_MS * 3)
	expect(nudges()).toHaveLength(0)
})

test('a turn that ends while a stage run is open keeps the 20 quiet minutes, since its child may not have reported yet', async () => {
	await start('t1')
	await h.as('t1')('POST', '/api/issue/run', { stage: 'research' })
	await until(live)
	h.replies({ showByThread: { t1: ended } })
	t3.settle('t1')
	await Bun.sleep(GRACE_MS * 3)
	expect(nudges()).toHaveLength(0)
})

test('after one nudge, the next turn that ends waits for the 20 quiet minutes, so nothing is stuck within minutes', async () => {
	await start('t1')
	await until(live)
	h.replies({ showByThread: { t1: ended } })
	t3.settle('t1')
	await until(() => nudges().length === 1)
	t3.settle('t1')
	await Bun.sleep(GRACE_MS * 3)
	expect(nudges()).toHaveLength(1)
})

test('turns in threads the factory does not know are ignored', async () => {
	await start('t1')
	await until(live)
	h.replies({ showByThread: { t1: ended, other: ended } })
	t3.settle('other')
	await Bun.sleep(GRACE_MS * 3)
	expect(nudges()).toHaveLength(0)
})

test('a revoked session signs in again with the same client and streams again', async () => {
	await until(live)
	t3.revokeAll()
	await until(() => t3.state.streams.length === 2 && t3.state.approved === 2)
	await until(live)
	expect(t3.state.registered).toBe(1)
})

test('after a restart the stream resumes from the last cursor, on the same session', async () => {
	await start('t1')
	await until(live)
	h.replies({ showByThread: { t1: working } })
	t3.settle('t1')
	await until(() => (h.server.db.query(`select value from settings where scope = 't3-events'`).get() as { value: string }).value.includes('"c.1"'))
	h.restart()
	await until(() => t3.state.streams.length === 2)
	expect(t3.state.streams[1]!.body.params.cursor).toBe('c.1')
	expect(t3.state.approved).toBe(1)
})

test('a session close to its end is renewed, and the old one revoked', async () => {
	h.close()
	t3.stop()
	// Two days left, under the three the service keeps in hand.
	boot(fakeT3Server({ tokenSeconds: 2 * 24 * 60 * 60 }))
	await until(live)
	h.restart()
	await until(() => t3.state.approved === 2 && t3.state.revoked.length === 1)
	expect(t3.state.revoked[0]).toBe(t3.state.tokens[0])
})

test('a T3 Code that serves no events is shown as unsupported, and the sweep goes on', async () => {
	h.close()
	t3.stop()
	boot(fakeT3Server({ noEvents: true }))
	await until(async () => (await h.call('GET', '/api/mcp')).body.t3Events.state === 'unsupported')
	expect((await h.call('GET', '/api/mcp')).body.t3Events.error).toContain('serves no thread.run_settled events')
})
