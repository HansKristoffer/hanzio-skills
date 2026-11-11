import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { scratchRepo, setup, type Harness } from './fixtures/harness.ts'
import { t3Binary } from './t3.ts'

let h: Harness

beforeEach(async () => {
	h = setup()
	const { work } = scratchRepo(h.dir)
	await h.as('t1')('POST', '/api/issue/start', { cwd: work, title: 'Pick a colour' })
})
afterEach(() => h.close())

const ask = (body: Record<string, unknown>) =>
	h.as('t1')('POST', '/api/issue/ask', { kind: 'question', recommend: 'Blue', options: ['Blue', 'Green'], ...body })
const answer = (id: string, value: string) => h.call('POST', `/api/decisions/${id}/answer`, { answer: value })
const sends = () => h.calls().filter((c) => c.args[1] === 'send')

test('answers wait until every blocking question is answered, then go as one message', async () => {
	const first = (await ask({ question: 'Blue or green?' })).body.decision
	const second = (await ask({ question: 'Round or square?', recommend: 'Round' })).body.decision
	const held = await answer(first, 'Green')
	expect(held.body.held).toBe(true)
	expect(sends()).toHaveLength(0)
	await answer(second, 'Square')
	const sent = sends()
	expect(sent).toHaveLength(1)
	expect(sent[0]!.args.slice(0, 3)).toEqual(['thread', 'send', 't1'])
	expect(sent[0]!.stdin).toContain(`${first} ("Blue or green?"): Green`)
	expect(sent[0]!.stdin).toContain(`${second} ("Round or square?"): Square`)
	const board = await h.call('GET', '/api/board')
	expect(board.body.needsYou).toBe(0)
})

test('a provisional answer names what the work went on with', async () => {
	const id = (await ask({ question: 'Keep the old field?', recommend: 'Keep it as an alias', provisional: true })).body.decision
	await answer(id, 'Drop it')
	expect(sends()[0]!.stdin).toContain('Drop it (you went on with: Keep it as an alias)')
})

test('a failed send stays under Needs you and can be sent again', async () => {
	h.replies({ send: { code: 1, out: 'thread not found' } })
	const id = (await ask({ question: 'Blue or green?' })).body.decision
	const res = await answer(id, 'Green')
	expect(res.body.error).toContain('thread not found')
	let board = await h.call('GET', '/api/board')
	expect(board.body.needsYou).toBe(1)
	expect(board.body.issues[0].decisions[0].delivery).toBe('failed')
	h.replies({})
	const retry = await h.call('POST', '/api/issues/t1/deliver', {})
	expect(retry.body.delivered).toBe(1)
	board = await h.call('GET', '/api/board')
	expect(board.body.needsYou).toBe(0)
})

test('an answer that was being sent when the server stopped is offered again', async () => {
	const id = (await ask({ question: 'Blue or green?' })).body.decision
	h.server.db.query(`update decisions set answer = 'Green', answered_via = 'page', delivery = 'sending' where id = $id`).run({ id })
	h.restart()
	const board = await h.call('GET', '/api/board')
	expect(board.body.issues[0].decisions[0].delivery).toBe('failed')
})

test('a second answer is refused', async () => {
	const id = (await ask({ question: 'Blue or green?' })).body.decision
	await answer(id, 'Green')
	expect((await answer(id, 'Blue')).status).toBe(409)
})

test('plan, merge and blocked decisions cannot be provisional, and every decision needs a recommendation', async () => {
	expect((await ask({ kind: 'merge', question: 'Merge?', provisional: true })).status).toBe(400)
	expect((await h.as('t1')('POST', '/api/issue/ask', { kind: 'question', question: 'x' })).status).toBe(400)
})

test('the merge is held while any decision has no answer', async () => {
	const id = (await ask({ question: 'Keep the alias?', provisional: true })).body.decision
	expect((await h.as('t1')('POST', '/api/issue/status', {})).body.mergeHeld).toBe(true)
	await h.as('t1')('POST', '/api/issue/answer', { decision: id, text: 'Yes' })
	const status = await h.as('t1')('POST', '/api/issue/status', {})
	expect(status.body.mergeHeld).toBe(false)
	expect(status.body.decisions[0].answeredVia).toBe('thread')
	expect(status.body.decisions[0].answer).toBe('Yes')
})

test('the t3 binary is the running server version, else the one on PATH', () => {
	const saved = { t3: process.env.FACTORY_T3, home: process.env.T3CODE_HOME }
	delete process.env.FACTORY_T3
	try {
		const home = join(h.dir, 't3home')
		process.env.T3CODE_HOME = home
		expect(t3Binary()).toBe('t3')
		const binary = join(home, 'runtime', 'versions', '1.2.3', 't3')
		mkdirSync(join(binary, '..'), { recursive: true })
		writeFileSync(binary, '')
		writeFileSync(join(home, 'runtime', 'service-state.json'), JSON.stringify({ activeVersion: '1.2.3' }))
		expect(t3Binary()).toBe(binary)
		rmSync(binary)
		expect(t3Binary()).toBe('t3')
	} finally {
		process.env.FACTORY_T3 = saved.t3
		if (saved.home === undefined) delete process.env.T3CODE_HOME
		else process.env.T3CODE_HOME = saved.home
	}
})
