import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { freePort, git, scratchRepo, setup, type Harness } from './fixtures/harness.ts'
import { SIGNATURE_HEADER, sign } from './webhook.ts'

let h: Harness
let work: string

beforeEach(() => {
	h = setup({ webhookEveryMs: 0 })
	work = scratchRepo(h.dir).work
})
afterEach(() => h.close())

let nextId = 1
async function rpc(method: string, params?: unknown, headers: Record<string, string> = {}) {
	const res = await fetch(`http://127.0.0.1:${h.port}/mcp`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
		body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, ...(params !== undefined && { params }) })
	})
	return { status: res.status, body: (await res.json()) as Record<string, any> }
}

/** Calls a tool and parses its JSON answer; `error` is the text of a tool that failed. */
async function tool(name: string, args: Record<string, unknown> = {}) {
	const res = await rpc('tools/call', { name, arguments: args })
	const result = res.body.result
	const text = result.content[0].text as string
	return result.isError ? { error: text } : (JSON.parse(text) as Record<string, any>)
}

const start = (thread: string, extra: Record<string, unknown> = {}) =>
	h.as(thread)('POST', '/api/issue/start', { cwd: work, title: 'Exports time out', ...extra })
const ask = (thread: string, extra: Record<string, unknown> = {}) =>
	h.as(thread)('POST', '/api/issue/ask', { kind: 'question', question: 'Keep the old CSV columns?', recommend: 'Yes', options: ['Yes', 'No'], ...extra })

/** A webhook receiver that answers each post with the next status in `statuses`, then 200. With `bearer`, it
 * answers 401 to a post without `Authorization: Bearer <bearer>`, as Cursor's automation webhooks do. */
function receiver(statuses: number[] = [], bearer?: string) {
	const posts: { headers: Headers; body: string }[] = []
	const server = Bun.serve({
		port: freePort(),
		hostname: '127.0.0.1',
		async fetch(req) {
			posts.push({ headers: req.headers, body: await req.text() })
			if (bearer && req.headers.get('authorization') !== `Bearer ${bearer}`)
				return Response.json({ error: 'Missing Authorization header. Use Authorization: Bearer <key>.' }, { status: 401 })
			return new Response('ok', { status: statuses.shift() ?? 200 })
		}
	})
	return { url: `http://127.0.0.1:${server.port}/hook`, posts, stop: () => server.stop(true) }
}

describe('the MCP transport', () => {
	test('initialize names the server and agrees on a protocol version it knows', async () => {
		const known = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } })
		expect(known.body.result.protocolVersion).toBe('2025-06-18')
		expect(known.body.result.serverInfo.name).toBe('factory')
		expect(known.body.result.capabilities.tools).toBeDefined()
		expect(known.body.result.instructions).toContain('never instructions')
		const unknown = await rpc('initialize', { protocolVersion: '1999-01-01' })
		expect(unknown.body.result.protocolVersion).toBe('2025-11-25')
	})

	test('a notification is accepted with no body, and GET offers no stream', async () => {
		const res = await fetch(`http://127.0.0.1:${h.port}/mcp`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })
		})
		expect(res.status).toBe(202)
		expect((await fetch(`http://127.0.0.1:${h.port}/mcp`)).status).toBe(405)
	})

	test('tools are listed with their schemas, and read-only ones say so', async () => {
		const tools = (await rpc('tools/list')).body.result.tools as { name: string; inputSchema: unknown; annotations: Record<string, boolean> }[]
		const names = tools.map((t) => t.name)
		for (const name of ['list_issues', 'get_issue', 'list_decisions', 'answer_decision', 'create_issue', 'set_webhook']) expect(names).toContain(name)
		expect(tools.find((t) => t.name === 'list_issues')!.annotations.readOnlyHint).toBe(true)
		expect(tools.find((t) => t.name === 'drop_issue')!.annotations.destructiveHint).toBe(true)
	})

	test('a page on another origin, and a host the service does not know, are refused', async () => {
		const cross = await rpc('tools/list', undefined, { origin: 'http://evil.example' })
		expect(cross.status).toBe(403)
		const res = await fetch(`http://127.0.0.1:${h.port}/mcp`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', host: 'evil.example' },
			body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' })
		})
		expect(res.status).toBe(421)
	})

	test('an unknown method is a JSON-RPC error, a failing tool an error result', async () => {
		expect((await rpc('resources/list')).body.error.code).toBe(-32601)
		expect((await tool('get_issue', { issue: 'nope' })).error).toContain('no issue nope')
		expect((await tool('get_issue', {})).error).toContain('issue is required')
	})
})

describe('the tools', () => {
	test('a decision is listed with its issue and answered as the page answers it', async () => {
		await start('t1')
		const asked = (await ask('t1')).body.decision
		const listed = await tool('list_issues')
		expect(listed.issues[0]).toMatchObject({ id: 't1', needsYou: true, url: expect.stringContaining('#/issue/t1') })
		expect(listed.issues[0].decisions[0].id).toBe(asked)

		const { decisions } = await tool('list_decisions')
		expect(decisions).toHaveLength(1)
		expect(decisions[0]).toMatchObject({ id: asked, options: ['Yes', 'No'], recommendation: 'Yes', issue: { id: 't1', repo: 'acme/api' } })

		await tool('answer_decision', { decision: asked, answer: 'No' })
		expect((await tool('list_decisions')).decisions).toHaveLength(0)
		const status = (await h.as('t1')('POST', '/api/issue/status', {})).body
		expect(status.decisions[0]).toMatchObject({ answer: 'No', answeredVia: 'mcp' })
		const sent = h.calls().filter((c) => c.args[1] === 'send' && c.args[2] === 't1')
		expect(sent.at(-1)!.stdin).toContain('No')
		expect((await tool('answer_decision', { decision: asked, answer: 'Yes' })).error).toContain('already answered')
	})

	test('get_issue keeps the newest events only', async () => {
		await start('t1')
		for (const n of [1, 2, 3]) await h.as('t1')('POST', '/api/issue/report', { text: `step ${n}` })
		const issue = await tool('get_issue', { issue: 't1', events: 2 })
		expect(issue.events.map((e: { text: string }) => e.text)).toEqual(['step 2', 'step 3'])
		expect(issue.eventsLeftOut).toBe(2)
		expect(issue.body).toBeNull()
	})

	test('create_issue starts a thread in a repository the factory knows', async () => {
		const unknown = (await tool('create_issue', { repo: 'acme/api', title: 'Slow search' })).error
		expect(unknown).toContain('no repository acme/api')
		expect(unknown).toContain('with cwd')
		await start('t1')
		const created = await tool('create_issue', { repo: 'acme/api', title: 'Slow search', body: 'Takes 9s.', source: 'gh:7' })
		expect(created).toMatchObject({ issue: 'thread-new-1', branch: 'factory/slow-search', title: 'Slow search', repo: 'acme/api', source: 'gh:7' })
		const again = await tool('create_issue', { repo: 'acme/api', title: 'Slow search', source: 'gh:7' })
		expect(again.duplicateOf.id).toBe('thread-new-1')
	})

	test('settings set through the MCP are what the page reads', async () => {
		await tool('set_settings', { scope: 'global', settings: { reviewRounds: 4 } })
		expect((await tool('get_settings')).global).toEqual({ reviewRounds: 4 })
		expect((await tool('set_settings', { scope: 'global', settings: { reviewRounds: 'many' } })).error).toBeDefined()
	})

	test('drop_issue closes the issue', async () => {
		await start('t1')
		await tool('drop_issue', { issue: 't1', reason: 'not ours' })
		expect((await tool('list_issues', { state: 'closed' })).issues[0]).toMatchObject({ id: 't1', outcome: 'dropped' })
	})
})

describe("T3 Code's projects", () => {
	const starts = () => h.calls().filter((c) => c.args[1] === 'start')

	/** acme/api (which the factory works in), a library checkout, a plain folder, an archived and a deleted project. */
	function projects() {
		mkdirSync(join(h.dir, 'lib'))
		const { work: lib, other } = scratchRepo(join(h.dir, 'lib'), 'acme/tiny-lib')
		const notes = join(h.dir, 'notes')
		mkdirSync(notes)
		h.projects([
			{ id: 'p-api', title: 'api', root: work },
			{ id: 'p-lib', title: 'tiny-lib', root: lib, model: { instanceId: 'codex', model: 'gpt-6-luna' } },
			{ id: 'p-notes', title: 'notes', root: notes },
			{ id: 'p-old', title: 'old', root: join(h.dir, 'gone'), archived: true },
			{ id: 'p-deleted', title: 'deleted', root: lib, deleted: true }
		])
		return { lib, notes, other }
	}

	test('list_projects lists every project T3 Code has, the factory\'s and the others', async () => {
		const { lib, notes } = projects()
		await start('t1')
		const listed = (await tool('list_projects')).projects
		expect(listed).toEqual([
			{ id: 'p-api', title: 'api', path: work, repo: 'acme/api', git: true, factory: true },
			{ id: 'p-notes', title: 'notes', path: notes, repo: null, git: false, factory: false },
			{ id: 'p-lib', title: 'tiny-lib', path: lib, repo: 'acme/tiny-lib', git: true, factory: false, defaultModel: { provider: 'codex', model: 'gpt-6-luna' } }
		])
		const all = (await tool('list_projects', { archived: true })).projects
		expect(all.find((p: { id: string }) => p.id === 'p-old')).toMatchObject({ archived: true, missing: expect.any(String) })
	})

	test('without T3 Code\'s database, list_projects says where it looked', async () => {
		expect((await tool('list_projects')).error).toContain('no state database')
	})

	test('start_thread starts a plain thread in a worktree from the fetched default branch, with the message as written', async () => {
		const { lib, other } = projects()
		const started = await tool('start_thread', { project: 'tiny-lib', message: 'Bump Bun to 1.3\n\nThen run the tests.' })
		expect(started).toMatchObject({
			thread: 'thread-new-1',
			threadLink: 'https://app.t3.codes/threads/env/thread-new-1',
			project: { id: 'p-lib', repo: 'acme/tiny-lib', path: lib },
			workspace: { worktree: true, base: 'origin/main', branch: 't3/bump-bun-to-1-3' },
			model: { provider: 'codex', model: 'gpt-6-luna' }
		})
		const call = starts()[0]!
		expect(call.args).toEqual(['thread', 'start', 'p-lib', '-', '--worktree', 'origin/main', '--branch', 't3/bump-bun-to-1-3', '--json'])
		expect(call.stdin).toBe('Bump Bun to 1.3\n\nThen run the tests.')
		// The worktree starts from origin as it is now, not the local main behind it.
		expect(git(lib, 'rev-parse', 'origin/main')).toBe(git(other, 'rev-parse', 'HEAD'))
		// Nothing is tracked: no issue was registered.
		expect((await tool('list_issues', { state: 'all' })).issues).toEqual([])
	})

	test('a branch the checkout already has is not taken again', async () => {
		const { lib } = projects()
		git(lib, 'branch', 't3/fix-readme')
		const started = await tool('start_thread', { project: 'acme/tiny-lib', message: 'whatever', title: 'Fix README', provider: 'claudeAgent', model: 'claude-opus-5-5' })
		expect(started.workspace.branch).toBe('t3/fix-readme-2')
		expect(starts()[0]!.args).toEqual([
			'thread', 'start', 'p-lib', '-', '--title', 'Fix README', '--worktree', 'origin/main', '--branch', 't3/fix-readme-2', '--json', '--provider', 'claudeAgent', '--model', 'claude-opus-5-5'
		])
	})

	test('worktree: false, and a project that is no git checkout, work in the folder itself', async () => {
		const { notes } = projects()
		expect((await tool('start_thread', { project: 'p-api', message: 'Look around', worktree: false })).workspace).toEqual({ worktree: false, path: work })
		expect((await tool('start_thread', { project: notes, message: 'Tidy up' })).workspace).toEqual({ worktree: false, path: notes })
		expect(starts().map((c) => c.args)).toEqual([
			['thread', 'start', 'p-api', '-', '--json'],
			['thread', 'start', 'p-notes', '-', '--json']
		])
		expect((await tool('start_thread', { project: 'notes', message: 'x', worktree: true })).error).toContain('not a git repository')
	})

	test('a wrong project or a half-given model is refused before anything starts', async () => {
		projects()
		const unknown = (await tool('start_thread', { project: 'nope', message: 'x' })).error
		expect(unknown).toContain('no project nope')
		expect(unknown).toContain('tiny-lib')
		expect(unknown).toContain('Next: list_projects')
		expect((await tool('start_thread', { project: 'tiny-lib', message: 'x', model: 'gpt-6-luna' })).error).toContain('provider and model together')
		expect((await tool('start_thread', { project: 'notes', message: 'x', worktree: false, branch: 'b' })).error).toContain('leave it out')
		expect((await tool('start_thread', { project: 'old', message: 'x' })).error).toContain('is gone')
		expect((await tool('start_thread', { project: 'tiny-lib' })).error).toContain('message is required')
		expect(starts()).toEqual([])
	})
})

describe('the webhook', () => {
	test('a blocking decision is posted, signed with the secret set_webhook gave once', async () => {
		const hook = receiver()
		try {
			const set = await tool('set_webhook', { url: hook.url })
			expect(set.webhook.events).toEqual(['decision', 'stuck'])
			expect(set.secret).toHaveLength(64)
			expect((await tool('get_webhook')).secret).toBeUndefined()

			await start('t1')
			await ask('t1', { provisional: true })
			const blocking = (await ask('t1', { kind: 'blocked', question: 'No staging access', recommend: 'Grant it', options: [] })).body.decision
			await h.server.webhook.flush()
			expect(hook.posts).toHaveLength(1)
			const post = hook.posts[0]!
			expect(post.headers.get(SIGNATURE_HEADER)).toBe(sign(set.secret, post.body))
			expect(post.headers.get('x-factory-event')).toBe('decision')
			const payload = JSON.parse(post.body)
			expect(payload).toMatchObject({
				event: 'decision',
				issue: { id: 't1', repo: 'acme/api', url: expect.stringContaining('#/issue/t1') },
				decision: { id: blocking, provisional: false, question: 'No staging access' },
				act: { tool: 'answer_decision', arguments: { decision: blocking } },
				mcp: expect.stringMatching(/\/mcp$/)
			})
			expect(payload.text).toContain('No staging access')
			expect((await tool('get_webhook')).recent[0]).toMatchObject({ event: 'decision', state: 'sent', lastStatus: 200 })
		} finally {
			hook.stop()
		}
	})

	test('a post the receiver refuses is sent again later, and the posts after it do not wait for it', async () => {
		const hook = receiver([500])
		try {
			await tool('set_webhook', { url: hook.url, events: ['*'] })
			await start('t1')
			await h.server.webhook.flush()
			expect(hook.posts).toHaveLength(1)
			const view = await tool('get_webhook')
			expect(view.pending).toBe(1)
			expect(view.recent[0]).toMatchObject({ event: 'started', state: 'pending', attempts: 1, lastStatus: 500 })

			await ask('t1')
			await h.server.webhook.flush()
			expect(hook.posts.map((p) => JSON.parse(p.body).event)).toEqual(['started', 'decision'])
			const later = Date.now() + 60_000
			await h.server.webhook.flush(() => later)
			expect(hook.posts.map((p) => JSON.parse(p.body).event)).toEqual(['started', 'decision', 'started'])
			expect((await tool('get_webhook')).pending).toBe(0)
		} finally {
			hook.stop()
		}
	})

	test('test_webhook says whether the receiver took the post; url null removes the webhook', async () => {
		expect((await tool('test_webhook')).error).toContain('no webhook is set')
		const hook = receiver()
		try {
			await tool('set_webhook', { url: hook.url, secret: 'a-secret-the-receiver-knows' })
			const tested = await tool('test_webhook')
			expect(tested).toMatchObject({ state: 'sent', status: 200 })
			expect(hook.posts[0]!.headers.get(SIGNATURE_HEADER)).toBe(sign('a-secret-the-receiver-knows', hook.posts[0]!.body))
			const rotated = await tool('set_webhook', { rotateSecret: true })
			expect(rotated.secret).not.toBe('a-secret-the-receiver-knows')
			expect(rotated.webhook.url).toBe(hook.url)
			await tool('set_webhook', { url: null })
			expect((await tool('get_webhook')).webhook).toBeNull()
		} finally {
			hook.stop()
		}
	})

	test('a thread that stops answering its nudges is posted as stuck once', async () => {
		const hook = receiver()
		try {
			await tool('set_webhook', { url: hook.url })
			await start('t1')
			const ended = { code: 0, out: JSON.stringify({ thread: { status: 'completed', pendingRequestCount: 0 } }) }
			h.replies({ showByThread: { t1: ended } })
			const later = (minutes: number) => Date.now() + minutes * 60_000
			for (const minutes of [21, 42, 63]) await h.server.checkQuiet(later(minutes))
			await h.server.webhook.flush()
			expect(hook.posts.map((p) => JSON.parse(p.body))).toMatchObject([{ event: 'stuck', reason: 'quiet', issue: { id: 't1' } }])
		} finally {
			hook.stop()
		}
	})

	test('* takes every event and stays *, and a secret you give is not echoed', async () => {
		const set = await tool('set_webhook', { url: 'https://hooks.example/f', events: ['*'], secret: 'given-by-the-receiver-0001' })
		expect(set.webhook.events).toEqual(['*'])
		expect(set.secret).toBeUndefined()
	})

	test('times come back as ISO strings, and the resolved settings only when asked', async () => {
		await start('t1')
		const issue = await tool('get_issue', { issue: 't1' })
		expect(issue.issue.createdAt).toMatch(/^\d{4}-\d\d-\d\dT/)
		expect(issue.settings).toBeUndefined()
		expect((await tool('get_issue', { issue: 't1', settings: true })).settings.reviewRounds).toBe(2)
	})

	test('a bad URL or event is refused', async () => {
		expect((await tool('set_webhook', { url: 'ftp://x' })).error).toContain('not http')
		expect((await tool('set_webhook', { url: 'https://x.example', events: ['everything'] })).error).toContain('not one of')
	})

	test('headers are sent with every post, the signature is unchanged, and get_webhook masks their values', async () => {
		const hook = receiver([], 'cursor-key-0123456789')
		try {
			const set = await tool('set_webhook', { url: hook.url, events: ['*'], headers: { Authorization: 'Bearer cursor-key-0123456789', 'X-Team': 'factory-team' } })
			expect(set.webhook.headers).toEqual({ Authorization: 'Bearer ***', 'X-Team': '***' })
			expect(JSON.stringify(set)).not.toContain('cursor-key')

			const tested = await tool('test_webhook')
			expect(tested).toMatchObject({ state: 'sent', status: 200 })
			await start('t1')
			await h.server.webhook.flush()
			expect(hook.posts).toHaveLength(2)
			for (const post of hook.posts) {
				expect(post.headers.get('authorization')).toBe('Bearer cursor-key-0123456789')
				expect(post.headers.get('x-team')).toBe('factory-team')
				expect(post.headers.get('content-type')).toBe('application/json')
				expect(post.headers.get(SIGNATURE_HEADER)).toBe(sign(set.secret, post.body))
			}

			const view = await tool('get_webhook')
			expect(view.webhook.headers).toEqual({ Authorization: 'Bearer ***', 'X-Team': '***' })
			expect(JSON.stringify(view)).not.toContain('cursor-key')
			// Leaving headers out keeps them.
			expect((await tool('set_webhook', { events: ['decision'] })).webhook.headers).toEqual({ Authorization: 'Bearer ***', 'X-Team': '***' })
		} finally {
			hook.stop()
		}
	})

	test('a receiver that wants a Bearer header refuses the post until set_webhook gives one', async () => {
		const hook = receiver([], 'cursor-key-0123456789')
		try {
			await tool('set_webhook', { url: hook.url })
			const refused = await tool('test_webhook')
			expect(refused).toMatchObject({ state: 'pending', status: 401 })
			expect(refused.error).toContain('Missing Authorization header')

			await tool('set_webhook', { url: hook.url, headers: { Authorization: 'Bearer cursor-key-0123456789' } })
			expect(await tool('test_webhook')).toMatchObject({ state: 'sent', status: 200, error: null })
			// The refused test post is still retried as before, now with the header.
			await h.server.webhook.flush(() => Date.now() + 60_000)
			expect((await tool('get_webhook')).recent.map((r: { state: string }) => r.state)).toEqual(['sent', 'sent'])
		} finally {
			hook.stop()
		}
	})

	test('retry_webhook sends the headers, and headers: {} clears them', async () => {
		const hook = receiver([401, 401, 401, 401, 401, 401])
		try {
			await tool('set_webhook', { url: hook.url, events: ['started'], headers: { authorization: 'Bearer k-0123456789' } })
			await start('t1')
			const day = 24 * 60 * 60 * 1000
			for (let i = 0; i < 6; i++) await h.server.webhook.flush(() => Date.now() + i * day)
			const post = (await tool('get_webhook')).recent[0]
			expect(post).toMatchObject({ state: 'failed', attempts: 6, lastStatus: 401 })
			await tool('retry_webhook', { delivery: post.id })
			await h.server.webhook.flush()
			expect(hook.posts).toHaveLength(7)
			expect(hook.posts.every((p) => p.headers.get('authorization') === 'Bearer k-0123456789')).toBe(true)
			expect((await tool('get_webhook')).recent[0]).toMatchObject({ state: 'sent', lastStatus: 200 })

			expect((await tool('set_webhook', { headers: {} })).webhook.headers).toEqual({})
			await tool('test_webhook')
			expect(hook.posts.at(-1)!.headers.get('authorization')).toBeNull()
		} finally {
			hook.stop()
		}
	})

	test('a receiver that echoes the header back does not get its value into the post log', async () => {
		const server = Bun.serve({
			port: freePort(),
			hostname: '127.0.0.1',
			fetch: (req) => new Response(`bad key ${req.headers.get('authorization')}`, { status: 403 })
		})
		try {
			await tool('set_webhook', { url: `http://127.0.0.1:${server.port}/hook`, headers: { Authorization: 'Bearer secret-0123456789' } })
			const tested = await tool('test_webhook')
			expect(tested.error).toBe('answered 403: bad key ***')
		} finally {
			server.stop(true)
		}
	})

	test('reserved header names and values with a line break are refused, naming the header and never its value', async () => {
		for (const name of ['Content-Type', 'content-length', 'Host', 'X-Factory-Signature-256', 'x-factory-event']) {
			expect((await tool('set_webhook', { url: 'https://x.example', headers: { [name]: 'v' } })).error).toContain(`${name} is set by the factory itself`)
		}
		for (const value of ['Bearer a\r\nX-Evil: 1', 'Bearer a\nb', 'Bearer a\rb']) {
			const error = (await tool('set_webhook', { url: 'https://x.example', headers: { Authorization: value } })).error
			expect(error).toContain('the value of Authorization holds a line break')
			expect(error).not.toContain('Bearer a')
		}
		expect((await tool('set_webhook', { url: 'https://x.example', headers: { 'Bad Name': 'v' } })).error).toContain('is not a header name')
		expect((await tool('set_webhook', { url: 'https://x.example', headers: { A: 'x', a: 'y' } })).error).toContain('a is given twice')
		expect((await tool('set_webhook', { url: 'https://x.example', headers: { A: 1 } })).error).toContain('must be a string')
		expect((await tool('set_webhook', { url: 'https://x.example', headers: ['Authorization'] })).error).toContain('headers must be object')
		expect((await tool('get_webhook')).webhook).toBeNull()
	})

	test('pending posts survive a restart', async () => {
		const hook = receiver([503])
		try {
			await tool('set_webhook', { url: hook.url, events: ['started'] })
			await start('t1')
			await h.server.webhook.flush()
			h.restart()
			// The flush the service starts with finds the post not yet due.
			await h.server.webhook.flush()
			expect(hook.posts).toHaveLength(1)
			await h.server.webhook.flush(() => Date.now() + 60_000)
			expect(hook.posts).toHaveLength(2)
			expect((await tool('get_webhook')).recent[0]).toMatchObject({ state: 'sent', attempts: 2 })
		} finally {
			hook.stop()
		}
	})
})

describe('what the audit asked for', () => {
	test('wrong arguments are refused, every one at once, before anything runs', async () => {
		const bad = await tool('list_issues', { state: 'bogus', needsYou: 'yes', colour: 'red' })
		expect(bad.error).toContain('state: "bogus" is not one of open, closed, all')
		expect(bad.error).toContain('needsYou must be boolean, not string')
		expect(bad.error).toContain('colour is not an argument')
		expect((await tool('get_issue', { issue: 't1', events: 9999 })).error).toContain('events is at most 500')
		const empty = (await tool('create_issue', {})).error
		expect(empty).toContain('give repo')
		expect(empty).toContain('give a title')
		const hook = (await tool('set_webhook', { url: 'ftp://x', secret: 'short', events: ['nonsense'] })).error
		expect(hook).toContain('not http')
		expect(hook).toContain('nonsense')
		expect(hook).toContain('16 characters')
	})

	test('an unknown id says which tool lists the right ones; a distinct part of an id is enough', async () => {
		expect((await tool('get_issue', { issue: 'nope-nope' })).error).toContain('Next: list_issues')
		expect((await tool('get_decision', { decision: 'd_00000000' })).error).toContain('Next: list_decisions')
		await start('mcp:9e7e9dbb-a9d9')
		expect((await tool('get_issue', { issue: '9e7e9dbb' })).issue.id).toBe('mcp:9e7e9dbb-a9d9')
	})

	test('a closed issue needs nobody, and its leftover decisions are marked closed', async () => {
		await start('t1')
		await ask('t1', { kind: 'blocked', question: 'Need access', recommend: 'Grant it', options: [] })
		await tool('drop_issue', { issue: 't1', reason: 'not ours' })
		const listed = (await tool('list_issues', { state: 'closed' })).issues[0]
		expect(listed.needsYou).toBeUndefined()
		const issue = await tool('get_issue', { issue: 't1' })
		expect(issue).toMatchObject({ gate: null, mergeHeld: false, closed: expect.stringContaining('closed') })
	})

	test('"recommended" takes the recommendation, and the answer can be read back', async () => {
		await start('t1')
		const id = (await ask('t1', { recommend: 'Keep them' })).body.decision
		const answered = await tool('answer_decision', { decision: id, answer: 'recommended' })
		expect(answered.answer).toBe('Keep them')
		expect(await tool('get_decision', { decision: id })).toMatchObject({ answer: 'Keep them', answeredVia: 'mcp', issue: { id: 't1' } })
		expect((await tool('list_decisions', { state: 'answered' })).decisions[0].id).toBe(id)
		const events = (await tool('get_issue', { issue: 't1' })).events.map((e: { text: string }) => e.text)
		expect(events.some((t: string) => t.startsWith('Answered through the MCP'))).toBe(true)
	})

	test('wait_for_update returns when the issue changes, and times out when nothing does', async () => {
		await start('t1')
		const waiting = tool('wait_for_update', { issue: 't1', timeoutSeconds: 10 })
		await Bun.sleep(50)
		await h.as('t1')('POST', '/api/issue/report', { text: 'tests green' })
		const woke = await waiting
		expect(woke).toMatchObject({ changed: true, changes: [{ issue: 't1', kind: 'report', text: 'tests green' }] })
		// What happened between two calls is returned at once from the cursor, not lost.
		await h.as('t1')('POST', '/api/issue/report', { text: 'pushed' })
		const caught = await tool('wait_for_update', { since: woke.cursor, timeoutSeconds: 5 })
		expect(caught.changes.map((c: { text: string }) => c.text)).toEqual(['pushed'])
		expect(await tool('wait_for_update', { since: caught.cursor, timeoutSeconds: 1 })).toMatchObject({ timedOut: true })
	})

	test('message_thread sends the thread a turn, read_thread shows its messages', async () => {
		await start('t1')
		h.replies({ showByThread: { t1: { code: 0, out: JSON.stringify({ thread: { status: 'completed', pendingRequestCount: 0 } }) } } })
		await tool('message_thread', { issue: 't1', message: 'Also update the README.' })
		const sent = h.calls().filter((c) => c.args[1] === 'send' && c.args[2] === 't1').at(-1)!
		expect(sent.stdin).toContain('Also update the README.')
		const read = await tool('read_thread', { issue: 't1' })
		expect(read.status).toBe('completed')
		expect(read.messages.at(-1).text).toContain('Also update the README.')
	})

	test('dev_environment status says when there is none; history is a summary unless full', async () => {
		await start('t1')
		expect(await tool('dev_environment', { issue: 't1', action: 'status' })).toMatchObject({ state: 'none' })
		await h.as('t1')('POST', '/api/issue/close', { outcome: 'not-a-bug', summary: 'staging only' })
		const summary = (await tool('history')).issues[0]
		expect(summary).toMatchObject({ id: 't1', outcome: 'not-a-bug', runs: 0 })
		expect(summary.decisions).toEqual([])
		expect((await tool('history', { full: true })).issues[0].runs).toEqual([])
	})

	test('an unknown repository is refused everywhere; set_store answers with the store before', async () => {
		await start('t1')
		expect((await tool('set_store', { repo: 'nope/nope', store: 'file' })).error).toContain('no repository nope/nope')
		expect((await tool('list_issues', { repo: 'nope/nope' })).error).toContain('the factory knows acme/api')
		expect((await tool('history', { repo: 'nope/nope' })).error).toContain('no repository')
		expect(await tool('set_store', { repo: 'Acme/API', store: 'machine' })).toMatchObject({ store: 'machine', before: expect.stringContaining('not chosen') })
		expect(await tool('set_store', { repo: 'acme/api', store: 'file' })).toMatchObject({ before: 'machine' })
	})

	test('get_issue shows run outcomes unless full, and where its merge setting comes from', async () => {
		await start('t1')
		await h.as('t1')('POST', '/api/issue/update', { merge: 'ask' })
		const issue = await tool('get_issue', { issue: 't1' })
		expect(issue).toMatchObject({ merge: 'ask', mergeFrom: 'issue' })
	})

	test('factory_info lists the repositories create_issue takes', async () => {
		await start('t1')
		expect((await tool('factory_info')).repos).toEqual(['acme/api'])
	})
})

describe('round three', () => {
	test('short, ambiguous and unknown ids get different errors; a decision id works without d_', async () => {
		expect((await tool('get_issue', { issue: 'c28' })).error).toContain('6 characters or more')
		await start('mcp:aaaa1111')
		await start('mcp:aaaa2222')
		expect((await tool('get_issue', { issue: 'mcp:aaaa' })).error).toContain('ambiguous issue id mcp:aaaa: 2 issues')
		const id = (await ask('mcp:aaaa1111')).body.decision as string
		expect((await tool('get_decision', { decision: id.slice(2) })).id).toBe(id)
	})

	test('list_issues finds an item by source and by how it ended, newest first', async () => {
		await start('t1', { source: 'gh:1' })
		await start('t2', { source: 'gh:2' })
		await h.as('t1')('POST', '/api/issue/close', { outcome: 'not-a-bug', summary: 'works as meant' })
		expect((await tool('list_issues', { state: 'all', source: 'gh:1' })).issues.map((i: { id: string }) => i.id)).toEqual(['t1'])
		expect((await tool('list_issues', { state: 'closed', outcome: 'not-a-bug' })).issues[0].summary).toBe('works as meant')
		expect((await tool('list_issues', { state: 'all', limit: 1 })).more).toContain('1 more')
	})

	test('wait_for_update pages through changes with a cursor and names each issue once', async () => {
		await start('t1')
		const from = (await tool('wait_for_update', { timeoutSeconds: 1 })).cursor
		for (const n of [1, 2, 3]) await h.as('t1')('POST', '/api/issue/report', { text: `step ${n}` })
		const first = await tool('wait_for_update', { since: from, limit: 2, timeoutSeconds: 1 })
		expect(first).toMatchObject({ more: true, issues: { t1: 'Exports time out' } })
		expect(first.changes.map((c: { text: string }) => c.text)).toEqual(['step 1', 'step 2'])
		const rest = await tool('wait_for_update', { since: first.cursor, limit: 2, timeoutSeconds: 1 })
		expect(rest.changes.map((c: { text: string }) => c.text)).toEqual(['step 3'])
		expect(rest.more).toBe(false)
	})

	test('a webhook post can be read as sent, and retrying one that arrived says why not', async () => {
		const hook = receiver()
		try {
			await tool('set_webhook', { url: hook.url, events: ['*'] })
			await start('t1')
			await h.server.webhook.flush()
			const post = (await tool('get_webhook')).recent[0]
			expect((await tool('get_webhook', { delivery: post.id })).body).toMatchObject({ event: 'started', issue: { id: 't1' } })
			expect((await tool('retry_webhook', { delivery: post.id })).error).toContain('is sent, not failed')
		} finally {
			hook.stop()
		}
	})

	test('the gate says who moves each blocker, and a repo gives its effective settings', async () => {
		await start('t1')
		const issue = await tool('get_issue', { issue: 't1' })
		expect(issue.gate.blockers[0]).toMatchObject({ code: 'no-pr', next: expect.stringContaining('refresh_pr') })
		expect((await tool('get_settings', { repo: 'acme/api' })).repos['acme/api'].effective.reviewRounds).toBe(2)
	})
})

describe('MCP events (SEP-3415)', () => {
	const STATELESS = { 'mcp-protocol-version': '2026-07-28' }
	const meta = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' }
	const poll = (name: string, extra: Record<string, unknown> = {}, headers: Record<string, string> = { 'mcp-name': name }) =>
		rpc('events/poll', { name, arguments: {}, cursor: null, ...extra, _meta: meta }, { ...STATELESS, ...headers })

	/** Opens an events/stream and hands back each notification as it arrives, until `stop`. */
	async function stream(name: string, params: Record<string, unknown> = {}) {
		const abort = new AbortController()
		const res = await fetch(`http://127.0.0.1:${h.port}/mcp`, {
			method: 'POST',
			signal: abort.signal,
			headers: { 'content-type': 'application/json', accept: 'text/event-stream', 'mcp-name': name, ...STATELESS },
			body: JSON.stringify({ jsonrpc: '2.0', id: 'sub-1', method: 'events/stream', params: { name, arguments: {}, cursor: null, ...params, _meta: meta } })
		})
		expect(res.headers.get('content-type')).toBe('text/event-stream')
		const reader = res.body!.getReader()
		const decoder = new TextDecoder()
		let buffer = ''
		/** The next notification, or null when none comes within `ms`. */
		async function next(ms = 3000): Promise<Record<string, any> | null> {
			const deadline = Date.now() + ms
			for (;;) {
				const end = buffer.indexOf('\n\n')
				if (end >= 0) {
					const frame = buffer.slice(0, end)
					buffer = buffer.slice(end + 2)
					return JSON.parse(frame.replace(/^data: /, ''))
				}
				const left = deadline - Date.now()
				if (left <= 0) return null
				const chunk = await Promise.race([reader.read(), Bun.sleep(left).then(() => null)])
				if (!chunk || chunk.done) return null
				buffer += decoder.decode(chunk.value)
			}
		}
		return { next, stop: () => abort.abort() }
	}

	test('discover and initialize advertise the extension, and each event type offers poll and push', async () => {
		const discover = (await rpc('server/discover', { _meta: meta }, STATELESS)).body.result
		expect(discover.supportedVersions).toContain('2026-07-28')
		expect(discover.capabilities.extensions['io.modelcontextprotocol/events']).toEqual({})
		expect(discover.resultType).toBe('complete')
		const init = (await rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {} })).body.result
		expect(init.capabilities.extensions['io.modelcontextprotocol/events']).toEqual({})

		const { events } = (await rpc('events/list', { _meta: meta }, STATELESS)).body.result
		expect(events.map((e: { name: string }) => e.name)).toEqual([
			'issue.update',
			'issue.decision',
			'issue.question',
			'issue.stuck',
			'issue.started',
			'issue.pr',
			'issue.closed'
		])
		for (const event of events) expect(event.delivery).toEqual(['poll', 'push'])
	})

	test('a poll from null starts at now; the next one returns what happened since, filtered by issue', async () => {
		await start('t1')
		const first = (await poll('issue.update')).body.result
		expect(first).toMatchObject({ events: [], truncated: false, hasMore: false, nextPollMs: 30000 })

		await start('t2', { title: 'Other issue' })
		await h.as('t1')('POST', '/api/issue/report', { text: 'Found the slow query' })
		const all = (await poll('issue.update', { cursor: first.cursor })).body.result
		expect(all.events.map((e: { data: { issue: string } }) => e.data.issue)).toEqual(['t2', 't1'])
		expect(all.events[1]).toMatchObject({ eventId: expect.stringMatching(/^ev_\d+$/), name: 'issue.update', data: { issue: 't1', kind: 'report', text: 'Found the slow query', repo: 'acme/api' } })
		expect(Date.parse(all.events[1].timestamp)).toBeGreaterThan(0)

		const one = (await poll('issue.update', { cursor: first.cursor, arguments: { issue: 't1' } })).body.result
		expect(one.events).toHaveLength(1)
		const none = (await poll('issue.update', { cursor: all.cursor })).body.result
		expect(none.events).toEqual([])
		expect(none.cursor).toBe(all.cursor)
	})

	test('maxEvents pages the backlog with hasMore', async () => {
		await start('t1')
		const from = (await poll('issue.update')).body.result.cursor
		for (const text of ['one', 'two', 'three']) await h.as('t1')('POST', '/api/issue/report', { text })
		const page = (await poll('issue.update', { cursor: from, maxEvents: 2 })).body.result
		expect(page.events.map((e: { data: { text: string } }) => e.data.text)).toEqual(['one', 'two'])
		expect(page.hasMore).toBe(true)
		const rest = (await poll('issue.update', { cursor: page.cursor, maxEvents: 2 })).body.result
		expect(rest.events.map((e: { data: { text: string } }) => e.data.text)).toEqual(['three'])
		expect(rest.hasMore).toBe(false)
	})

	test('a blocking decision is an issue.decision event with the webhook body, with or without a webhook, and its cursor outlives a restart', async () => {
		const from = (await poll('issue.decision')).body.result.cursor
		await start('t1')
		const blocking = (await ask('t1', { kind: 'blocked', question: 'No staging access', recommend: 'Grant it', options: [] })).body.decision
		h.restart()
		const { events } = (await poll('issue.decision', { cursor: from })).body.result
		expect(events).toHaveLength(1)
		expect(events[0]).toMatchObject({
			eventId: expect.stringMatching(/^nt_\d+$/),
			data: { event: 'decision', issue: { id: 't1', repo: 'acme/api' }, decision: { id: blocking }, act: { tool: 'answer_decision', arguments: { decision: blocking } } }
		})
	})

	test('a stream confirms first, sends each event as it happens, and a heartbeat with the cursor when quiet', async () => {
		await start('t1')
		const sub = await stream('issue.update', { heartbeatMs: 1000 })
		try {
			const active = (await sub.next())!
			expect(active.method).toBe('notifications/events/active')
			expect(active.params).toMatchObject({ truncated: false, heartbeatMs: 5000, _meta: { 'io.modelcontextprotocol/subscriptionId': 'sub-1' } })
			await h.as('t1')('POST', '/api/issue/report', { text: 'Pushed the fix' })
			const event = (await sub.next())!
			const cursor = event.params.cursor
			expect(event.method).toBe('notifications/events/event')
			expect(cursor).toMatch(/^\d+$/)
			expect(event.params).toMatchObject({ name: 'issue.update', data: { issue: 't1', text: 'Pushed the fix' } })
			const beat = (await sub.next(7000))!
			expect(beat.method).toBe('notifications/events/heartbeat')
			expect(beat.params.cursor).toBe(cursor)
		} finally {
			sub.stop()
		}
	}, 15_000)

	test('a stream from a cursor replays what it missed first', async () => {
		await start('t1')
		const from = (await poll('issue.update')).body.result.cursor
		await h.as('t1')('POST', '/api/issue/report', { text: 'While you were away' })
		const sub = await stream('issue.update', { cursor: from })
		try {
			expect((await sub.next())!.method).toBe('notifications/events/active')
			expect((await sub.next())!.params.data.text).toBe('While you were away')
		} finally {
			sub.stop()
		}
	})

	test('a cursor from another database, or below what was pruned, says truncated', async () => {
		await start('t1')
		expect((await poll('issue.update', { cursor: '999999' })).body.result.truncated).toBe(true)
		const db = h.server.db
		db.query(`insert into notices (event, issue_id, at, payload) values ('closed', 't1', 1, '{}')`).run()
		const { pruneOld } = await import('./db.ts')
		pruneOld(db)
		expect((await poll('issue.closed', { cursor: '0' })).body.result.truncated).toBe(true)
	})

	test('wrong requests get the spec errors, and webhook delivery is refused as unsupported', async () => {
		expect((await poll('issue.nope')).body.error.code).toBe(-32023)
		expect((await poll('issue.update', { arguments: { colour: 'red' } })).body.error.code).toBe(-32602)
		expect((await poll('issue.update', { arguments: { issue: 'nope' } })).body.error.message).toContain('no issue nope')
		expect((await poll('issue.update', { cursor: 'abc' })).body.error.code).toBe(-32602)
		const mismatch = await poll('issue.update', {}, { 'mcp-name': 'issue.closed' })
		expect(mismatch.status).toBe(400)
		expect(mismatch.body.error.code).toBe(-32020)
		// Clients written before SEP-3415 send no Mcp-Name.
		expect((await poll('issue.update', {}, {})).body.result.events).toEqual([])
		const subscribe = await rpc('events/subscribe', { name: 'issue.update', arguments: {}, delivery: { mode: 'webhook', url: 'https://x.example/h', secret: 'whsec_x' } }, { 'mcp-name': 'issue.update' })
		expect(subscribe.body.error).toMatchObject({ code: -32026, data: { feature: 'deliveryMode', value: 'webhook' } })
		const version = await rpc('tools/list', { _meta: { 'io.modelcontextprotocol/protocolVersion': '1999-01-01' } })
		expect(version.body.error).toMatchObject({ code: -32022, data: { supported: expect.arrayContaining(['2026-07-28']) } })
	})
})
