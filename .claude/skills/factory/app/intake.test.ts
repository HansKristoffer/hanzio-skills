import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { scratchRepo, setup, type Harness } from './fixtures/harness.ts'
import { linearSource } from './intake.ts'

let h: Harness
let work: string

beforeEach(async () => {
	h = setup()
	work = scratchRepo(h.dir).work
	// The factory starts threads only in repositories it has a checkout of, which it learns from an issue.
	await h.as('t0')('POST', '/api/issue/start', { cwd: work, title: 'First issue' })
})
afterEach(() => h.close())

const starts = () => h.calls().filter((c) => c.args[1] === 'start')

describe('GitHub sources', () => {
	const issue = {
		number: 42,
		title: 'Exports time out',
		url: 'https://github.com/acme/api/issues/42',
		state: 'OPEN',
		labels: [{ name: 'bug' }],
		assignees: [],
		author: { login: 'kim' },
		createdAt: '2026-11-20T10:00:00Z',
		updatedAt: '2026-11-21T10:00:00Z'
	}

	test('lists open issues with what the factory did, and starts one with its text and comments', async () => {
		const saved = await h.call('POST', '/api/intake/sources', { kind: 'github', repo: 'acme/api', github: { label: 'factory' } })
		expect(saved.status).toBe(200)
		const id = saved.body.source.id
		expect(saved.body.source.github).toEqual({ repo: 'acme/api', label: 'factory' })

		h.gh.replies({
			'issue-list': {
				out: [
					issue,
					{
						...issue,
						number: 43,
						title: 'Typo',
						url: 'https://github.com/acme/api/issues/43',
						blockedBy: {
							nodes: [
								{ number: 42, state: 'OPEN', url: 'https://github.com/acme/api/issues/42' },
								{ number: 7, state: 'CLOSED', url: 'https://github.com/acme/api/issues/7' },
								{ number: 3, state: 'OPEN', url: 'https://github.com/acme/web/issues/3' }
							]
						}
					}
				]
			},
			'issue-view': {
				out: { ...issue, body: 'Large accounts time out after 30s.', comments: [{ author: { login: 'lee' }, body: 'Seen on acct 9 too.', createdAt: '2026-11-21T09:00:00Z' }] }
			}
		})
		const listed = await h.call('GET', `/api/intake/sources/${id}/items`)
		expect(listed.status).toBe(200)
		// An item waits on the open items that block it; a closed blocker no longer holds it.
		expect(listed.body.items.map((i: any) => [i.ref, i.labels, i.factory, i.blockedBy])).toEqual([
			['#42', ['bug'], null, []],
			['#43', ['bug'], null, ['#42', 'acme/web#3']]
		])
		const list = h.gh.calls().find((c) => c.args[0] === 'issue' && c.args[1] === 'list')!
		expect(list.args).toContain('--label')
		expect(list.args.slice(2, 4)).toEqual(['-R', 'acme/api'])

		const started = await h.call('POST', `/api/intake/sources/${id}/start`, { item: '42' })
		expect(started.status).toBe(200)
		expect(started.body.issue).toBe('thread-new-1')
		const message = starts().at(-1)!.stdin!
		expect(message).toContain('Source: https://github.com/acme/api/issues/42')
		expect(message).toContain('Large accounts time out after 30s.')
		expect(message).toContain('**lee** on 2026-11-21:\n\nSeen on acct 9 too.')
		expect(message).toContain('```untrusted')

		const again = await h.call('GET', `/api/intake/sources/${id}/items`)
		expect(again.body.items[0].factory).toMatchObject({ id: 'thread-new-1', state: 'open' })
		const twice = await h.call('POST', `/api/intake/sources/${id}/start`, { item: '42' })
		expect(twice.body.duplicateOf.id).toBe('thread-new-1')
		expect(starts()).toHaveLength(1)
	})

	test('a closed issue is not started, and a source holds the merge of what it starts', async () => {
		const { id } = (await h.call('POST', '/api/intake/sources', { kind: 'github', repo: 'acme/api', merge: 'never' })).body.source
		h.gh.replies({ 'issue-view': { out: { ...issue, state: 'CLOSED', body: '' } } })
		const closed = await h.call('POST', `/api/intake/sources/${id}/start`, { item: '42' })
		expect(closed.status).toBe(409)
		h.gh.replies({ 'issue-view': { out: { ...issue, body: 'x', comments: [] } } })
		await h.call('POST', `/api/intake/sources/${id}/start`, { item: '42' })
		const status = await h.as('thread-new-1')('POST', '/api/issue/status', {})
		expect(status.body.merge).toBe('never')
	})

	test('a source must start threads in a repository the factory has a checkout of', async () => {
		const res = await h.call('POST', '/api/intake/sources', { kind: 'github', repo: 'acme/web' })
		expect(res.status).toBe(400)
		expect(res.body.error).toContain('no checkout of acme/web')
		const bad = await h.call('POST', '/api/intake/sources', { kind: 'jira', repo: 'acme/api' })
		expect(bad.body.error).toContain('kind')
	})

	test('a source is edited and removed by its id', async () => {
		const { id } = (await h.call('POST', '/api/intake/sources', { kind: 'github', repo: 'acme/api' })).body.source
		await h.call('PUT', `/api/intake/sources/${id}`, { github: { repo: 'acme/api', label: 'bug' }, name: 'Bugs' })
		const view = (await h.call('GET', '/api/intake')).body
		expect(view.sources).toEqual([{ id, kind: 'github', name: 'Bugs', repo: 'acme/api', github: { repo: 'acme/api', label: 'bug' } }])
		expect(view.github).toEqual({ ok: true, login: 'factory-user' })
		expect((await h.call('DELETE', `/api/intake/sources/${id}`)).status).toBe(200)
		expect((await h.call('GET', '/api/intake')).body.sources).toEqual([])
	})
})

describe('Linear sources', () => {
	let linear: ReturnType<typeof Bun.serve>
	const seen: { auth: string | null; query: string; variables: any }[] = []
	const node = (identifier: string, team = 'ENG') => ({
		id: `id-${identifier}`,
		identifier,
		title: `Title of ${identifier}`,
		url: `https://linear.app/acme/issue/${identifier}/title-of-${identifier.toLowerCase()}`,
		createdAt: '2026-11-20T10:00:00Z',
		updatedAt: '2026-11-21T10:00:00Z',
		priorityLabel: 'High',
		state: { name: 'Todo', type: 'unstarted' },
		labels: { nodes: [{ name: 'Bug' }] },
		assignee: null,
		creator: { name: 'Kim' },
		project: null,
		team: { key: team },
		inverseRelations: {
			nodes:
				identifier === 'ENG-13'
					? [
							{ type: 'blocks', issue: { identifier: 'ENG-12', state: { type: 'unstarted' } } },
							{ type: 'blocks', issue: { identifier: 'ENG-1', state: { type: 'completed' } } },
							{ type: 'related', issue: { identifier: 'ENG-2', state: { type: 'started' } } }
						]
					: []
		}
	})

	beforeEach(() => {
		seen.length = 0
		linear = Bun.serve({
			port: 0,
			hostname: '127.0.0.1',
			async fetch(req) {
				const { query, variables } = (await req.json()) as { query: string; variables: any }
				const auth = req.headers.get('authorization')
				seen.push({ auth, query, variables })
				if (auth !== 'lin_api_good') return Response.json({ errors: [{ message: 'Authentication required' }] }, { status: 401 })
				if (query.includes('viewer')) return Response.json({ data: { viewer: { name: 'Hans' }, organization: { name: 'Acme', urlKey: 'acme' } } })
				if (query.includes('issues(')) {
					return Response.json({ data: { issues: { nodes: [node('ENG-12'), node('ENG-13')], pageInfo: { hasNextPage: false, endCursor: null } } } })
				}
				if (query.includes('issue(')) {
					const team = variables.id.startsWith('OPS') ? 'OPS' : 'ENG'
					return Response.json({
						data: {
							issue: {
								...node(variables.id, team),
								description: 'Checkout fails on Safari.',
								comments: { nodes: [{ body: 'Repro on iOS 19.', createdAt: '2026-11-21T08:00:00Z', user: { name: 'Lee' } }] }
							}
						}
					})
				}
				return Response.json({ data: { teams: { nodes: [{ key: 'OPS', name: 'Ops' }, { key: 'ENG', name: 'Engineering' }] } } })
			}
		})
		process.env.FACTORY_LINEAR_URL = `http://127.0.0.1:${linear.port}/graphql`
	})
	afterEach(() => {
		linear.stop(true)
		delete process.env.FACTORY_LINEAR_URL
	})

	test('a key Linear refuses is not kept, and a good one is checked and never shown', async () => {
		const bad = await h.call('PUT', '/api/intake/linear', { apiKey: 'lin_api_bad' })
		expect(bad.status).toBe(401)
		expect((await h.call('GET', '/api/intake')).body.linear).toEqual({ connected: false })

		const good = await h.call('PUT', '/api/intake/linear', { apiKey: 'lin_api_good' })
		expect(good.body).toMatchObject({ ok: true, name: 'Hans', organization: 'Acme' })
		const view = await h.call('GET', '/api/intake')
		expect(view.body.linear).toMatchObject({ connected: true, name: 'Hans', organization: 'Acme' })
		expect(JSON.stringify(view.body)).not.toContain('lin_api_good')
		expect((await h.call('GET', '/api/intake/linear/teams')).body.teams.map((t: any) => t.key)).toEqual(['ENG', 'OPS'])

		await h.call('DELETE', '/api/intake/linear')
		expect((await h.call('GET', '/api/intake')).body.linear).toEqual({ connected: false })
	})

	test("lists a team's open issues and starts one with its description and comments", async () => {
		await h.call('PUT', '/api/intake/linear', { apiKey: 'lin_api_good' })
		const { id } = (await h.call('POST', '/api/intake/sources', { kind: 'linear', repo: 'acme/api', linear: { team: 'eng', label: 'Bug' } })).body.source

		const listed = await h.call('GET', `/api/intake/sources/${id}/items`)
		expect(listed.body.items.map((i: any) => [i.ref, i.url, i.priority, i.blockedBy])).toEqual([
			['ENG-12', 'https://linear.app/acme/issue/ENG-12', 'High', []],
			['ENG-13', 'https://linear.app/acme/issue/ENG-13', 'High', ['ENG-12']]
		])
		const list = seen.find((s) => s.query.includes('issues('))!
		expect(list.auth).toBe('lin_api_good')
		expect(list.variables.filter).toEqual({
			team: { key: { eq: 'ENG' } },
			state: { type: { nin: ['completed', 'canceled'] } },
			labels: { name: { eqIgnoreCase: 'Bug' } }
		})

		const started = await h.call('POST', `/api/intake/sources/${id}/start`, { item: 'ENG-12' })
		expect(started.body.issue).toBe('thread-new-1')
		const message = starts().at(-1)!.stdin!
		expect(message).toContain('Source: https://linear.app/acme/issue/ENG-12')
		expect(message).toContain('Checkout fails on Safari.')
		expect(message).toContain('- Priority: High')
		expect(message).toContain('**Lee** on 2026-11-21:\n\nRepro on iOS 19.')
		expect((await h.call('GET', `/api/intake/sources/${id}/items`)).body.items[0].factory.id).toBe('thread-new-1')

		const other = await h.call('POST', `/api/intake/sources/${id}/start`, { item: 'OPS-1' })
		expect(other.status).toBe(400)
		expect(other.body.error).toContain('not in team ENG')
	})

	test('a Linear source lists nothing until Linear is connected', async () => {
		const { id } = (await h.call('POST', '/api/intake/sources', { kind: 'linear', repo: 'acme/api', linear: { team: 'ENG' } })).body.source
		const res = await h.call('GET', `/api/intake/sources/${id}/items`)
		expect(res.status).toBe(409)
		expect(res.body.error).toContain('not connected')
	})
})

test("Linear's URL loses the title's slug, which changes with the title", () => {
	expect(linearSource('https://linear.app/acme/issue/ENG-12/checkout-fails')).toBe('https://linear.app/acme/issue/ENG-12')
	expect(linearSource('https://linear.app/acme/issue/ENG-12')).toBe('https://linear.app/acme/issue/ENG-12')
})

describe('new comments on the item an issue came from', () => {
	const url = 'https://github.com/acme/api/issues/42'
	const at = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString()
	const sends = () => h.calls().filter((c) => c.args[1] === 'send' && c.args[2] === 't9')
	const comments = (...list: { login: string; body: string; createdAt: string }[]) =>
		h.gh.replies({ 'issue-view': { out: { comments: list.map((c) => ({ author: { login: c.login }, body: c.body, createdAt: c.createdAt })) } } })

	beforeEach(async () => {
		await h.as('t9')('POST', '/api/issue/start', { cwd: work, title: 'Exports time out', body: 'Large accounts time out.', source: url })
	})

	test('reach the thread once and stay in the issue text, without the factory\'s own', async () => {
		comments(
			{ login: 'kim', body: 'Reported it last week.', createdAt: at(-60 * 24) },
			{ login: 'factory-bot', body: 'The factory took this.\n\n<!-- factory:t9 -->', createdAt: at(1) },
			{ login: 'lee', body: 'Only on accounts over 10k rows.', createdAt: at(2) }
		)
		await h.server.checkSources()
		expect(sends()).toHaveLength(1)
		const message = sends()[0]!.stdin!
		expect(message).toContain(`Factory: a new comment on ${url}`)
		expect(message).toContain('**lee**')
		expect(message).toContain('```untrusted')
		expect(message).not.toContain('Reported it last week')
		expect(message).not.toContain('The factory took this')
		expect(h.gh.calls().at(-1)!.args).toEqual(['issue', 'view', '42', '-R', 'acme/api', '--json', 'comments'])

		await h.server.checkSources()
		expect(sends()).toHaveLength(1)

		comments({ login: 'lee', body: 'Only on accounts over 10k rows.', createdAt: at(2) }, { login: 'kim', body: 'And on Safari.', createdAt: at(3) })
		await h.server.checkSources()
		expect(sends()).toHaveLength(2)
		const body = (await h.call('GET', '/api/issues/t9')).body.body as string
		expect(body.startsWith('Large accounts time out.')).toBe(true)
		expect(body.match(/Comments added to the item after the factory took it in:/g)).toHaveLength(1)
		expect(body.indexOf('10k rows')).toBeLessThan(body.indexOf('And on Safari.'))
	})

	test('an item the service cannot read is left alone', async () => {
		await h.as('t8')('POST', '/api/issue/start', { cwd: work, title: 'From feedback', source: 'feedreply:123' })
		h.gh.replies({ 'issue-view': { code: 1, out: 'not found' } })
		await h.server.checkSources()
		expect(h.calls().filter((c) => c.args[1] === 'send')).toHaveLength(0)
	})
})
