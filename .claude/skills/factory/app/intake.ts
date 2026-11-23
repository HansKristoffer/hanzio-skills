// The Intake page's sources: GitHub issues read with the service's own `gh`, and Linear issues read with an
// API key kept on this machine. A source lists open items, and starting one reads it again in full (its text
// and comments), so the thread gets what the tracker holds now rather than what the page showed.
import { randomBytes } from 'node:crypto'
import { gh } from './gh.ts'

export const SOURCE_KINDS = ['github', 'linear'] as const
export type SourceKind = (typeof SOURCE_KINDS)[number]

/** Where items come from, and the factory repository whose checkout a started thread works in. */
export type IntakeSource = {
	id: string
	kind: SourceKind
	name: string
	repo: string
	/** `label` narrows the list to items with that label; the page filters further. */
	github?: { repo: string; label?: string }
	linear?: { team: string; label?: string; project?: string }
	/** Holds the merge of every item started from this source, whatever the project's setting. */
	merge?: 'ask' | 'never'
}

/** One open item as the page lists it. `key` is what the start call names: the number, or Linear's identifier. */
export type IntakeItem = {
	key: string
	ref: string
	url: string
	title: string
	state: string
	labels: string[]
	assignees: string[]
	author: string | null
	priority: string | null
	project: string | null
	createdAt: number
	updatedAt: number
}

/** An item read in full for a thread: `body` holds its text, its facts and its comments. */
export type FullItem = { title: string; url: string; body: string }

const GH_REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const TEAM_KEY = /^[A-Za-z0-9_-]{1,20}$/
const LIST_LIMIT = 200
const COMMENTS_MAX = 50
const TIMEOUT_MS = 15_000

export const linearUrl = () => process.env.FACTORY_LINEAR_URL || 'https://api.linear.app/graphql'

export class IntakeError extends Error {
	constructor(
		readonly status: number,
		message: string
	) {
		super(message)
	}
}
const fail = (status: number, message: string): never => {
	throw new IntakeError(status, message)
}

const str = (value: unknown, name: string, max: number, problems: string[]) => {
	if (value === undefined || value === null || value === '') return undefined
	if (typeof value !== 'string') {
		problems.push(`${name}: give text`)
		return undefined
	}
	const trimmed = value.trim()
	if (trimmed.length > max) problems.push(`${name}: at most ${max} characters`)
	return trimmed || undefined
}

/** Checks a source the page sends. `repos` are the repositories the factory knows a checkout of. */
export function parseSource(input: Record<string, unknown>, before: IntakeSource | null, repos: string[]): IntakeSource {
	const problems: string[] = []
	const kind = (input.kind ?? before?.kind) as SourceKind
	if (!SOURCE_KINDS.includes(kind)) problems.push(`kind: give ${SOURCE_KINDS.join(' or ')}`)
	const repo = (str(input.repo, 'repo', 200, problems) ?? before?.repo)?.toLowerCase()
	if (!repo) problems.push('repo: name the factory repository the threads start in')
	else if (!repos.includes(repo)) {
		problems.push(`repo: the factory has no checkout of ${repo}; it knows ${repos.join(', ') || 'no repository yet'}`)
	}
	const merge = input.merge === undefined ? before?.merge : input.merge || undefined
	if (merge !== undefined && merge !== 'ask' && merge !== 'never') problems.push('merge: give ask, never, or leave it empty')

	const source: IntakeSource = {
		id: before?.id ?? `src_${randomBytes(4).toString('hex')}`,
		kind,
		name: '',
		repo: repo ?? '',
		...(merge && { merge: merge as 'ask' | 'never' })
	}
	if (kind === 'github') {
		const given = (input.github ?? {}) as Record<string, unknown>
		const ghRepo = (str(given.repo, 'github.repo', 200, problems) ?? repo)?.toLowerCase()
		if (!ghRepo || !GH_REPO.test(ghRepo)) problems.push('github.repo: give <owner/name>')
		const label = str(given.label, 'github.label', 100, problems)
		source.github = { repo: ghRepo ?? '', ...(label && { label }) }
		source.name = str(input.name, 'name', 80, problems) ?? `${ghRepo}${label ? ` · ${label}` : ''}`
	} else if (kind === 'linear') {
		const given = (input.linear ?? {}) as Record<string, unknown>
		const team = str(given.team, 'linear.team', 20, problems)?.toUpperCase()
		if (!team || !TEAM_KEY.test(team)) problems.push('linear.team: give the team key, such as ENG')
		const label = str(given.label, 'linear.label', 100, problems)
		const project = str(given.project, 'linear.project', 200, problems)
		source.linear = { team: team ?? '', ...(label && { label }), ...(project && { project }) }
		source.name = str(input.name, 'name', 80, problems) ?? `Linear ${team}${label ? ` · ${label}` : ''}${project ? ` · ${project}` : ''}`
	}
	if (problems.length) fail(400, problems.join('; '))
	return source
}

// ---- GitHub ----

type GhIssue = {
	number: number
	title: string
	url: string
	state?: string
	body?: string
	labels?: { name: string }[]
	assignees?: { login: string }[]
	author?: { login: string } | null
	createdAt?: string
	updatedAt?: string
	comments?: { author?: { login: string } | null; body: string; createdAt: string }[]
}

const time = (iso?: string | null) => (iso ? Date.parse(iso) || 0 : 0)

async function ghJson<T>(args: string[], what: string): Promise<T> {
	const res = await gh(args)
	if (!res.ok) fail(502, `gh could not read ${what}: ${res.err || res.out || 'it failed'}`)
	try {
		return JSON.parse(res.out) as T
	} catch {
		return fail(502, `gh gave something other than JSON for ${what}`)
	}
}

async function githubList(source: IntakeSource): Promise<IntakeItem[]> {
	const { repo, label } = source.github!
	const args = ['issue', 'list', '-R', repo, '--state', 'open', '--limit', String(LIST_LIMIT)]
	if (label) args.push('--label', label)
	args.push('--json', 'number,title,url,state,labels,assignees,author,createdAt,updatedAt')
	const issues = await ghJson<GhIssue[]>(args, `the issues of ${repo}`)
	return issues.map((i) => ({
		key: String(i.number),
		ref: `#${i.number}`,
		url: i.url,
		title: i.title,
		state: (i.state ?? 'OPEN').toLowerCase(),
		labels: (i.labels ?? []).map((l) => l.name),
		assignees: (i.assignees ?? []).map((a) => a.login),
		author: i.author?.login ?? null,
		priority: null,
		project: null,
		createdAt: time(i.createdAt),
		updatedAt: time(i.updatedAt)
	}))
}

async function githubRead(source: IntakeSource, key: string): Promise<FullItem> {
	if (!/^\d+$/.test(key)) fail(400, `item: ${key} is not an issue number`)
	const { repo } = source.github!
	const i = await ghJson<GhIssue>(
		['issue', 'view', key, '-R', repo, '--json', 'number,title,url,state,body,labels,assignees,author,comments'],
		`${repo}#${key}`
	)
	if (i.state && i.state.toUpperCase() !== 'OPEN') fail(409, `${repo}#${key} is ${i.state.toLowerCase()}`)
	return {
		title: i.title,
		url: i.url,
		body: compose({
			text: i.body,
			facts: [
				['Issue', `${repo}#${i.number}`],
				['Opened by', i.author?.login],
				['Labels', (i.labels ?? []).map((l) => l.name).join(', ')],
				['Assignees', (i.assignees ?? []).map((a) => a.login).join(', ')]
			],
			comments: (i.comments ?? []).map((c) => ({ who: c.author?.login ?? 'someone', at: c.createdAt, body: c.body }))
		})
	}
}

/** Who the service's `gh` is signed in as, or why it cannot read GitHub. */
export async function githubViewer(): Promise<{ ok: true; login: string } | { ok: false; error: string }> {
	const res = await gh(['api', 'user', '--jq', '.login'])
	if (!res.ok) return { ok: false, error: res.err || res.out || 'gh is not signed in' }
	return { ok: true, login: res.out }
}

// ---- Linear ----

async function linear<T>(key: string, query: string, variables: Record<string, unknown> = {}): Promise<T> {
	let res: Response
	try {
		res = await fetch(linearUrl(), {
			method: 'POST',
			// A personal API key goes in as it is; an OAuth token already starts with `Bearer`.
			headers: { 'content-type': 'application/json', authorization: key },
			body: JSON.stringify({ query, variables }),
			signal: AbortSignal.timeout(TIMEOUT_MS)
		})
	} catch (error) {
		return fail(502, `Linear could not be reached: ${(error as Error).message}`)
	}
	const json = (await res.json().catch(() => null)) as { data?: T; errors?: { message: string }[] } | null
	if (res.status === 401 || res.status === 403) fail(401, 'Linear refused the API key; connect it again')
	if (!res.ok || !json || json.errors?.length || !json.data) {
		fail(502, `Linear answered ${res.status}: ${json?.errors?.map((e) => e.message).join('; ') || 'no data'}`)
	}
	return json!.data!
}

const LINEAR_ISSUE = `id identifier title url createdAt updatedAt priorityLabel
	state { name type } labels { nodes { name } } assignee { name } creator { name } project { name }`

type LinearIssue = {
	identifier: string
	title: string
	url: string
	createdAt: string
	updatedAt: string
	priorityLabel?: string | null
	state?: { name: string; type: string } | null
	labels?: { nodes: { name: string }[] }
	assignee?: { name: string } | null
	creator?: { name: string } | null
	project?: { name: string } | null
	description?: string | null
	comments?: { nodes: { body: string; createdAt: string; user?: { name: string } | null }[] }
}

/** Linear's URL ends in a slug of the title, which changes with it; the factory keys items without it. */
export const linearSource = (url: string) => url.replace(/^(https:\/\/linear\.app\/[^/]+\/issue\/[A-Za-z0-9-]+)\/.*$/, '$1')

const linearItem = (i: LinearIssue): IntakeItem => ({
	key: i.identifier,
	ref: i.identifier,
	url: linearSource(i.url),
	title: i.title,
	state: i.state?.name ?? '',
	labels: (i.labels?.nodes ?? []).map((l) => l.name),
	assignees: i.assignee ? [i.assignee.name] : [],
	author: i.creator?.name ?? null,
	priority: i.priorityLabel && i.priorityLabel !== 'No priority' ? i.priorityLabel : null,
	project: i.project?.name ?? null,
	createdAt: time(i.createdAt),
	updatedAt: time(i.updatedAt)
})

async function linearList(source: IntakeSource, key: string): Promise<IntakeItem[]> {
	const { team, label, project } = source.linear!
	const filter: Record<string, unknown> = {
		team: { key: { eq: team } },
		// Done and canceled items are not work; triage, backlog, todo and started ones are.
		state: { type: { nin: ['completed', 'canceled'] } }
	}
	if (label) filter.labels = { name: { eqIgnoreCase: label } }
	if (project) filter.project = { name: { eqIgnoreCase: project } }
	const items: IntakeItem[] = []
	let after: string | null = null
	do {
		const data: { issues: { nodes: LinearIssue[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } } = await linear(
			key,
			`query($filter: IssueFilter, $after: String) { issues(first: 100, after: $after, filter: $filter, orderBy: updatedAt) {
				nodes { ${LINEAR_ISSUE} } pageInfo { hasNextPage endCursor } } }`,
			{ filter, after }
		)
		items.push(...data.issues.nodes.map(linearItem))
		after = data.issues.pageInfo.hasNextPage ? data.issues.pageInfo.endCursor : null
	} while (after && items.length < LIST_LIMIT)
	return items.slice(0, LIST_LIMIT)
}

async function linearRead(source: IntakeSource, key: string, apiKey: string): Promise<FullItem> {
	if (!/^[A-Za-z0-9]+-\d+$/.test(key)) fail(400, `item: ${key} is not a Linear identifier such as ENG-12`)
	const data = await linear<{ issue: (LinearIssue & { team?: { key: string } }) | null }>(
		apiKey,
		`query($id: String!) { issue(id: $id) { ${LINEAR_ISSUE} description team { key }
			comments(first: ${COMMENTS_MAX}) { nodes { body createdAt user { name } } } } }`,
		{ id: key }
	)
	const i = data.issue ?? fail(404, `Linear has no issue ${key}`)
	// The key alone could name an item of another team, which this source does not list.
	if (i.team && i.team.key.toUpperCase() !== source.linear!.team) fail(400, `${key} is not in team ${source.linear!.team}`)
	if (i.state && ['completed', 'canceled'].includes(i.state.type)) fail(409, `${key} is ${i.state.name.toLowerCase()}`)
	const item = linearItem(i)
	return {
		title: i.title,
		url: item.url,
		body: compose({
			text: i.description ?? '',
			facts: [
				['Issue', i.identifier],
				['State', i.state?.name],
				['Priority', item.priority],
				['Project', item.project],
				['Labels', item.labels.join(', ')],
				['Opened by', item.author],
				['Assignee', item.assignees.join(', ')]
			],
			comments: (i.comments?.nodes ?? [])
				.slice()
				.sort((a, b) => time(a.createdAt) - time(b.createdAt))
				.map((c) => ({ who: c.user?.name ?? 'someone', at: c.createdAt, body: c.body }))
		})
	}
}

/** Who the key belongs to, so the page shows the connection is good before it is saved. */
export async function linearViewer(key: string) {
	const data = await linear<{ viewer: { name: string; email?: string }; organization: { name: string; urlKey: string } }>(
		key,
		'{ viewer { name email } organization { name urlKey } }'
	)
	return { name: data.viewer.name, organization: data.organization.name }
}

export async function linearTeams(key: string) {
	const data = await linear<{ teams: { nodes: { key: string; name: string }[] } }>(key, '{ teams(first: 100) { nodes { key name } } }')
	return data.teams.nodes.map((t) => ({ key: t.key, name: t.name })).sort((a, b) => a.key.localeCompare(b.key))
}

// ---- Both ----

/** The item's text, then what the tracker knows about it, then its comments oldest first. */
function compose(item: { text?: string | null; facts: [string, string | null | undefined][]; comments: { who: string; at: string; body: string }[] }) {
	const parts = [(item.text ?? '').trim() || '(The item has no description.)']
	const facts = item.facts.filter(([, value]) => value).map(([name, value]) => `- ${name}: ${value}`)
	if (facts.length) parts.push(facts.join('\n'))
	if (item.comments.length) {
		parts.push(
			`Comments (${item.comments.length}):`,
			...item.comments.map((c) => `**${c.who}** on ${c.at.slice(0, 10)}:\n\n${c.body.trim()}`)
		)
	}
	return parts.join('\n\n')
}

const needsKey = (key: string | null) => key ?? fail(409, 'Linear is not connected: add its API key on the Intake page')

export function listItems(source: IntakeSource, linearKey: string | null) {
	return source.kind === 'github' ? githubList(source) : linearList(source, needsKey(linearKey))
}

export function readItem(source: IntakeSource, key: string, linearKey: string | null) {
	return source.kind === 'github' ? githubRead(source, key) : linearRead(source, key, needsKey(linearKey))
}
