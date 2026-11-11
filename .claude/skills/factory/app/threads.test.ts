import { afterEach, beforeEach, expect, test } from 'bun:test'
import { git, scratchRepo, setup, type Harness } from './fixtures/harness.ts'
import { parseStarted } from './t3.ts'

let h: Harness
let repo: ReturnType<typeof scratchRepo>

beforeEach(() => {
	h = setup()
	repo = scratchRepo(h.dir)
})
afterEach(() => h.close())

const newThread = (body: Record<string, unknown>) =>
	h.call('POST', '/api/threads', { cwd: repo.work, title: 'Exports time out', body: 'Big accounts.', ...body })
const starts = () => h.calls().filter((c) => c.args[1] === 'start')

test('new starts a thread on the orchestrator model in a worktree from origin, and registers its issue', async () => {
	const res = await newThread({ source: 'https://github.com/acme/api/issues/42' })
	expect(res.status).toBe(200)
	expect(res.body.issue).toBe('thread-new-1')
	expect(res.body.branch).toBe('factory/exports-time-out')
	const call = starts()[0]!
	expect(call.args).toEqual([
		'thread',
		'start',
		repo.work,
		'-',
		'--title',
		'Exports time out',
		'--worktree',
		'origin/main',
		'--branch',
		'factory/exports-time-out',
		'--json',
		'--provider',
		'claudeAgent',
		'--model',
		'claude-fable-5-2'
	])
	expect(call.stdin).toContain('factory skill')
	expect(call.stdin).toContain('```untrusted')
	const board = await h.call('GET', '/api/board')
	expect(board.body.issues[0].id).toBe('thread-new-1')
	expect(board.body.issues[0].threadLink).toBe('https://app.t3.codes/threads/env/thread-new-1')
})

test('the provider and model come from the settings resolved for that repository', async () => {
	await h.call('PUT', '/api/settings/repo:acme/api', { orchestrator: { provider: 'codex', model: 'gpt-6-luna' } })
	await newThread({})
	expect(starts()[0]!.args.slice(-4)).toEqual(['--provider', 'codex', '--model', 'gpt-6-luna'])
})

test('a branch origin already has gets the next free suffix', async () => {
	git(repo.other, 'push', '-q', 'origin', 'HEAD:refs/heads/factory/exports-time-out')
	git(repo.other, 'push', '-q', 'origin', 'HEAD:refs/heads/factory/exports-time-out-2')
	const res = await newThread({})
	expect(res.body.branch).toBe('factory/exports-time-out-3')
})

test('an open item is not started twice, a closed one only with again', async () => {
	const source = 'posthog:error:123'
	await newThread({ source })
	const dup = await newThread({ source })
	expect(dup.body.duplicateOf.id).toBe('thread-new-1')
	expect(starts()).toHaveLength(1)

	await h.as('thread-new-1')('POST', '/api/issue/close', { outcome: 'not-a-bug', summary: 'staging only' })
	const closed = await newThread({ source })
	expect(closed.body.closed[0].outcome).toBe('not-a-bug')
	expect(starts()).toHaveLength(1)

	h.replies({ start: { out: JSON.stringify({ thread: { threadId: 'thread-new-2' } }) } })
	const again = await newThread({ source, again: true })
	expect(again.body.issue).toBe('thread-new-2')
	expect(starts()).toHaveLength(2)
})

test('the thread that new started finds its issue with start, adding no row', async () => {
	await newThread({ source: 'https://github.com/acme/api/issues/7' })
	const started = await h.as('thread-new-1')('POST', '/api/issue/start', { cwd: repo.work })
	expect(started.body.issue).toBe('thread-new-1')
	const count = h.server.db.query('select count(*) as n from issues').get() as { n: number }
	expect(count.n).toBe(1)
})

test('the page starts threads only in repositories the factory has seen, and never takes a path', async () => {
	const unseen = await h.call('POST', '/api/threads', { repo: 'acme/api', title: 'x' })
	expect(unseen.status).toBe(400)
	expect(unseen.body.error).toContain('never seen')
	await newThread({})
	const seen = await h.call('POST', '/api/threads', { repo: 'acme/api', title: 'Second issue' })
	expect(seen.status).toBe(200)
})

test('the board counts open issues and the ones that wait for the user', async () => {
	await newThread({ source: 'a' })
	h.replies({ start: { out: JSON.stringify({ threadId: 'thread-new-2' }) } })
	await newThread({ source: 'b', title: 'Second' })
	await h.as('thread-new-2')('POST', '/api/issue/ask', { kind: 'blocked', question: 'Need the API key', recommend: 'Add it to Infisical' })
	const board = await h.call('GET', '/api/board')
	expect(board.body.open).toBe(2)
	expect(board.body.needsYou).toBe(1)
})

test('history lists issues closed in the window with their rounds and waits', async () => {
	await newThread({})
	const as = h.as('thread-new-1')
	await as('POST', '/api/issue/run', { stage: 'review' })
	await as('POST', '/api/issue/run', { stage: 'review', on: 'plan' })
	const decision = (await as('POST', '/api/issue/ask', { kind: 'question', question: 'Q?', recommend: 'A' })).body.decision
	await as('POST', '/api/issue/answer', { decision, text: 'A' })
	await as('POST', '/api/issue/close', { outcome: 'shipped', deploy: 'none', summary: 'ok' })
	h.server.db.query(`insert into issues (id, title, repo, root, settings, state, created_at, updated_at, closed_at)
		values ('old', 'Old', 'acme/api', '/x', '{}', 'closed', 0, 0, $at)`).run({ at: Date.now() - 8 * 24 * 60 * 60 * 1000 })
	const history = await h.call('GET', '/api/history?days=7')
	expect(history.body.issues.map((i: { id: string }) => i.id)).toEqual(['thread-new-1'])
	expect(history.body.issues[0].reviewRounds).toBe(1)
	expect(history.body.issues[0].decisions[0].waitedMinutes).toBe(0)
})

test('the id t3 thread start prints is read from JSON or plain text', () => {
	expect(parseStarted('{"threadId":"abc-123"}').threadId).toBe('abc-123')
	expect(parseStarted('{"thread":{"threadId":"abc-456","link":"https://x"}}')).toEqual({ threadId: 'abc-456', link: 'https://x' })
	expect(parseStarted('Started 3063e8e9-5379-4269-b087-fcf14f4e1d66').threadId).toBe('3063e8e9-5379-4269-b087-fcf14f4e1d66')
	expect(() => parseStarted('oops')).toThrow(/no thread id/)
})
