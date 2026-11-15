import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { freePort, scratchRepo, setup, type Harness } from './fixtures/harness.ts'
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

/** A webhook receiver that answers each post with the next status in `statuses`, then 200. */
function receiver(statuses: number[] = []) {
	const posts: { headers: Headers; body: string }[] = []
	const server = Bun.serve({
		port: freePort(),
		hostname: '127.0.0.1',
		async fetch(req) {
			posts.push({ headers: req.headers, body: await req.text() })
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
