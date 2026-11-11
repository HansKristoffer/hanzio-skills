// The PR as the factory sees it: what `gh` read turned into state, which comments count, what needs
// action, what blocks the merge, and the merge gate. Pure functions; the server stores and serves them.
import type { RawPr } from './gh.ts'
import { sameLogin, type Settings } from './settings.ts'

export const MARKER = (issue: string) => `<!-- factory:${issue} -->`
const MARKED = /<!-- factory:[^>]+ -->/
const BODY_MAX = 8000
const TRUSTED = new Set(['OWNER', 'MEMBER', 'COLLABORATOR'])
export const HIDDEN = '[hidden: written by someone outside the project]'

export type PrState = {
	url: string
	number: number
	state: 'open' | 'merged' | 'closed'
	draft: boolean
	head: string
	base: string
	author: string
	checks: { state: 'none' | 'pending' | 'passing' | 'failing'; failing: string[] }
	bots: { login: string; reviewedHead: boolean }[]
	mergeable: 'mergeable' | 'conflicting' | 'unknown'
	mergeState: string
	reviewDecision: '' | 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED'
	approvedBy: { login: string; commit: string; at: number }[]
	changesRequestedBy: string[]
	requested: string[]
	rules: { approvals: number; resolveThreads: boolean; dismissStale: boolean } | null
	mergedBy?: string
	syncedAt: number
}

export type Comment = {
	id: string
	author: string
	authorKind: 'person' | 'bot'
	association: string
	trusted: boolean
	byFactory: boolean
	body: string
	createdAt: number
	editedAt: number | null
}

export type Item = {
	id: string
	kind: 'thread' | 'review' | 'comment'
	path: string | null
	line: number | null
	url: string
	state: string
	commit: string | null
	truncated: boolean
	createdAt: number
	comments: Comment[]
}

/** What the factory did with an item, as stored. */
export type Handling = { handled: string | null; handledAt: number | null; seenAt: number | null }

export type PrItem = {
	id: string
	kind: Item['kind']
	path?: string
	line?: number
	url: string
	state: string
	comments: { author: string; authorKind: 'person' | 'bot'; body: string; at: number }[]
	isNew: boolean
	truncated: boolean
}

const time = (value: unknown) => (typeof value === 'string' && value ? Date.parse(value) : 0)

function author(node: Record<string, any>) {
	const login = String(node.author?.login ?? 'ghost')
	const bot = node.author?.__typename === 'Bot' || node.author?.is_bot === true || login.endsWith('[bot]')
	return { login, kind: bot ? ('bot' as const) : ('person' as const), association: String(node.authorAssociation ?? 'NONE') }
}

/** Decision 4: a comment counts when its author belongs to the repository, is a bot, or is listed in
 * `trust`, and is not listed in `ignore`. */
export function isTrusted(who: { login: string; kind: 'person' | 'bot'; association: string }, settings: Settings) {
	if (settings.ignore.some((login) => sameLogin(login, who.login))) return false
	return TRUSTED.has(who.association) || who.kind === 'bot' || settings.trust.some((login) => sameLogin(login, who.login))
}

function comment(node: Record<string, any>, settings: Settings, written: Set<string>, createdKey = 'createdAt'): Comment {
	const who = author(node)
	const body = String(node.body ?? '')
	return {
		id: String(node.id),
		author: who.login,
		authorKind: who.kind,
		association: who.association,
		trusted: isTrusted(who, settings),
		byFactory: MARKED.test(body) || written.has(String(node.id)),
		body: body.length > BODY_MAX ? `${body.slice(0, BODY_MAX)}\n[cut at ${BODY_MAX} characters; read the rest on GitHub]` : body,
		createdAt: time(node[createdKey]),
		editedAt: node.lastEditedAt ? time(node.lastEditedAt) : null
	}
}

function checksOf(raw: RawPr): PrState['checks'] {
	const failing: string[] = []
	let pending = false
	if (raw.required?.length) {
		for (const check of raw.required) {
			if (check.bucket === 'fail' || check.bucket === 'cancel') failing.push(check.name)
			if (check.bucket === 'pending') pending = true
		}
	} else {
		const rollup = (raw.view.statusCheckRollup ?? []) as Record<string, any>[]
		if (!rollup.length) return { state: 'none', failing }
		for (const check of rollup) {
			const name = String(check.name ?? check.context ?? 'check')
			if (check.__typename === 'StatusContext') {
				if (check.state === 'FAILURE' || check.state === 'ERROR') failing.push(name)
				if (check.state === 'PENDING' || check.state === 'EXPECTED') pending = true
				continue
			}
			if (check.status !== 'COMPLETED') pending = true
			else if (['FAILURE', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE'].includes(check.conclusion)) failing.push(name)
		}
	}
	if (failing.length) return { state: 'failing', failing }
	return { state: pending ? 'pending' : raw.required?.length || raw.view.statusCheckRollup?.length ? 'passing' : 'none', failing }
}

function rulesOf(raw: RawPr): PrState['rules'] {
	if (!raw.rules) return null
	const rule = raw.rules.find((r) => r.type === 'pull_request')?.parameters ?? {}
	return {
		approvals: Number(rule.required_approving_review_count ?? 0),
		resolveThreads: rule.required_review_thread_resolution === true,
		dismissStale: rule.dismiss_stale_reviews_on_push === true
	}
}

/** Turns what `gh` read into the PR's state and its items. `written` holds the ids of what the factory posted. */
export function normalize(raw: RawPr, settings: Settings, written: Set<string> = new Set(), now = Date.now()) {
	const view = raw.view
	const prAuthor = String(view.author?.login ?? '')
	const head = String(view.headRefOid ?? '')
	const items: Item[] = []

	for (const node of raw.threads) {
		const nodes = (node.comments?.nodes ?? []) as Record<string, any>[]
		const comments = nodes.map((c) => comment(c, settings, written))
		items.push({
			id: String(node.id),
			kind: 'thread',
			path: node.path ?? null,
			line: node.line ?? null,
			url: String(nodes[0]?.url ?? view.url),
			state: node.isResolved ? 'resolved' : node.isOutdated ? 'outdated' : 'open',
			commit: null,
			truncated: Number(node.comments?.totalCount ?? 0) > nodes.length,
			createdAt: comments[0]?.createdAt ?? 0,
			comments
		})
	}
	const reviews = raw.reviews.filter((r) => r.state !== 'PENDING')
	for (const node of reviews) {
		const c = comment(node, settings, written, 'submittedAt')
		items.push({
			id: String(node.id),
			kind: 'review',
			path: null,
			line: null,
			url: String(node.url ?? view.url),
			state: String(node.state),
			commit: node.commit?.oid || null,
			truncated: false,
			createdAt: c.createdAt,
			comments: [c]
		})
	}
	for (const node of raw.comments) {
		const c = comment(node, settings, written)
		items.push({
			id: String(node.id),
			kind: 'comment',
			path: null,
			line: null,
			url: String(node.url ?? view.url),
			state: 'open',
			commit: null,
			truncated: false,
			createdAt: c.createdAt,
			comments: [c]
		})
	}

	// Each trusted person's standing review: their newest that approved, requested changes or was dismissed.
	const standing = new Map<string, Item>()
	for (const item of items.filter((i) => i.kind === 'review').sort((a, b) => a.createdAt - b.createdAt)) {
		const c = item.comments[0]!
		if (!c.trusted || c.authorKind !== 'person' || !['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(item.state)) continue
		standing.set(c.author.toLowerCase(), item)
	}
	const approvedBy = [...standing.values()]
		.filter((r) => r.state === 'APPROVED' && !sameLogin(r.comments[0]!.author, prAuthor))
		.map((r) => ({ login: r.comments[0]!.author, commit: r.commit ?? '', at: r.createdAt }))
	const changesRequestedBy = [...standing.values()].filter((r) => r.state === 'CHANGES_REQUESTED').map((r) => r.comments[0]!.author)

	const decision = String(view.reviewDecision ?? '')
	const pr: PrState = {
		url: String(view.url),
		number: Number(view.number),
		state: view.state === 'MERGED' ? 'merged' : view.state === 'CLOSED' ? 'closed' : 'open',
		draft: view.isDraft === true,
		head,
		base: String(view.baseRefName ?? ''),
		author: prAuthor,
		checks: checksOf(raw),
		bots: settings.bots.map((login) => ({
			login,
			reviewedHead: items.some((i) => i.kind === 'review' && i.commit === head && sameLogin(i.comments[0]!.author, login))
		})),
		mergeable: view.mergeable === 'MERGEABLE' ? 'mergeable' : view.mergeable === 'CONFLICTING' ? 'conflicting' : 'unknown',
		mergeState: String(view.mergeStateStatus ?? ''),
		reviewDecision: (['APPROVED', 'CHANGES_REQUESTED', 'REVIEW_REQUIRED'].includes(decision) ? decision : '') as PrState['reviewDecision'],
		approvedBy,
		changesRequestedBy,
		requested: ((view.reviewRequests ?? []) as Record<string, any>[]).map((r) => String(r.login ?? r.slug ?? r.name ?? '')).filter(Boolean),
		rules: rulesOf(raw),
		...(view.mergedBy?.login && { mergedBy: String(view.mergedBy.login) }),
		syncedAt: now
	}
	return { pr, items }
}

// ---- the two rules over stored items (decision 6) ----

const counts = (c: Comment) => c.trusted && !c.byFactory
const lastTouch = (c: Comment) => Math.max(c.createdAt, c.editedAt ?? 0)

/** An item needs action while a trusted comment, not the factory's, is newer than the factory's last handling of it. */
export function needsAction(item: Item, handling: Handling) {
	if (item.kind === 'thread' && item.state === 'resolved') return false
	if (item.kind === 'review' && !item.comments[0]?.body.trim()) return false
	return item.comments.some((c) => counts(c) && (handling.handledAt === null || lastTouch(c) > handling.handledAt))
}

/** The person whose conversation this is: the author of its first comment that counts, when a person. */
const owner = (item: Item) => {
	const first = item.comments.find(counts)
	return first?.authorKind === 'person' ? first.author : null
}

/** A person's conversation blocks the merge until it is resolved, or that person approves after its newest comment. */
export function blocksMerge(item: Item, pr: PrState) {
	if (item.kind !== 'thread' || item.state === 'resolved') return false
	const person = owner(item)
	if (!person) return false
	const newest = Math.max(...item.comments.map(lastTouch))
	return !pr.approvedBy.some((a) => sameLogin(a.login, person) && a.at > newest)
}

/** What the orchestrator may read of an item: trusted comments only, an outsider's opening replaced. */
export function printable(item: Item, handling: Handling): PrItem {
	const comments = item.comments.filter(counts).map((c) => ({ author: c.author, authorKind: c.authorKind, body: c.body, at: c.createdAt }))
	const first = item.comments[0]
	if (first && !first.trusted && !first.byFactory && comments.length) {
		comments.unshift({ author: 'hidden', authorKind: 'person', body: HIDDEN, at: first.createdAt })
	}
	const newest = Math.max(0, ...item.comments.filter(counts).map(lastTouch))
	return {
		id: item.id,
		kind: item.kind,
		...(item.path && { path: item.path }),
		...(item.line && { line: item.line }),
		url: item.url,
		state: item.state,
		comments,
		isNew: handling.seenAt === null || newest > handling.seenAt,
		truncated: item.truncated
	}
}

/** Comments that count for nothing: written by someone outside the project, not by the factory. */
export const hiddenCount = (items: Item[]) => items.flatMap((i) => i.comments).filter((c) => !c.trusted && !c.byFactory).length

/** Whether any comment in the item, the first that counts, is a person's (rounds are for people's requests). */
export const fromPerson = (item: Item) => item.comments.some((c) => counts(c) && c.authorKind === 'person')

// ---- the merge gate (decisions 10, 12, 14, 15) ----

export type Blocker = {
	code:
		| 'no-pr'
		| 'draft'
		| 'checks'
		| 'conflict'
		| 'bots'
		| 'items'
		| 'threads'
		| 'changes-requested'
		| 'approval'
		| 'internal-review'
		| 'decisions'
		| 'risk-unchecked'
		| 'risk'
		| 'merge-setting'
		| 'round-budget'
	text: string
}
export type Gate = { ready: boolean; head: string; blockers: Blocker[] }

export type GateInput = {
	pr: PrState | null
	items: { item: Item; handling: Handling }[]
	settings: Settings
	merge: Settings['merge']
	/** The current head has an internal review with nothing important open, or one is not needed. */
	internalCovered: boolean
	openDecisions: number
	/** A merge decision about the current head was answered Merge. */
	mergeApproved: boolean
	riskHead: string | null
	riskRule: string | null
	roundBudget: string | null
}

/** Decision 10: approval is needed when GitHub or the project says so. */
export function approvalNeeded(pr: PrState, settings: Settings) {
	if (settings.approval === 'required') return true
	if (settings.approval === 'off') return false
	if ((pr.rules?.approvals ?? 0) > 0 || pr.reviewDecision === 'REVIEW_REQUIRED' || settings.reviewers.length) return true
	return pr.rules === null && pr.mergeState === 'BLOCKED' && pr.checks.state === 'passing' && pr.mergeable !== 'conflicting' && !pr.draft
}

export function computeGate(input: GateInput): Gate {
	const { pr, settings } = input
	if (!pr) return { ready: false, head: '', blockers: [{ code: 'no-pr', text: 'no PR synced yet: run factory pr sync' }] }
	const blockers: Blocker[] = []
	const add = (code: Blocker['code'], text: string) => blockers.push({ code, text })
	if (pr.state !== 'open') add('no-pr', `the PR is ${pr.state}`)
	if (pr.draft) add('draft', 'the PR is a draft: run factory pr ready')
	if (pr.mergeable === 'conflicting') add('conflict', `the PR conflicts with ${pr.base}`)
	if (pr.checks.state !== 'passing') {
		add(
			'checks',
			pr.checks.state === 'failing'
				? `failing checks: ${pr.checks.failing.join(', ')}`
				: pr.checks.state === 'pending'
					? 'checks are still running'
					: 'no checks reported for the head'
		)
	}
	const missing = pr.bots.filter((b) => !b.reviewedHead).map((b) => b.login)
	if (missing.length) add('bots', `waiting for ${missing.join(', ')} to review the head`)
	const acting = input.items.filter(({ item, handling }) => needsAction(item, handling))
	if (acting.length) add('items', `${acting.length} review item${acting.length === 1 ? '' : 's'} need${acting.length === 1 ? 's' : ''} action`)
	const blocking = input.items.filter(({ item }) => blocksMerge(item, pr))
	const unresolved = input.items.filter(({ item }) => item.kind === 'thread' && item.state !== 'resolved')
	if (blocking.length) {
		const people = [...new Set(blocking.map(({ item }) => `@${owner(item)}`))]
		add('threads', `${blocking.length} conversation${blocking.length === 1 ? '' : 's'} by ${people.join(', ')} not resolved`)
	} else if (pr.rules?.resolveThreads && unresolved.length) {
		add('threads', `the branch rules require resolved conversations, and ${unresolved.length} are open`)
	}
	if (pr.changesRequestedBy.length) add('changes-requested', `changes requested by ${pr.changesRequestedBy.map((l) => `@${l}`).join(', ')}`)
	if (approvalNeeded(pr, settings)) {
		const need = Math.max(1, pr.rules?.approvals ?? 0)
		if (pr.approvedBy.length < need) {
			add('approval', `needs ${need} approval${need === 1 ? '' : 's'} from someone other than @${pr.author}; has ${pr.approvedBy.length}`)
		}
	}
	if (!input.internalCovered) add('internal-review', `the head ${pr.head.slice(0, 7)} has no clean internal review and no approval on it`)
	if (input.openDecisions) add('decisions', `${input.openDecisions} decision${input.openDecisions === 1 ? ' waits' : 's wait'} for an answer`)
	if (input.riskHead !== pr.head) add('risk-unchecked', `the leave-open rules were not checked on ${pr.head.slice(0, 7)}: run factory risk`)
	else if (input.riskRule && !input.mergeApproved) add('risk', `a leave-open rule holds: ${input.riskRule}`)
	if (input.merge === 'never') add('merge-setting', 'merge is never: a person merges this PR')
	else if (input.merge === 'ask' && !input.mergeApproved) add('merge-setting', 'merge is ask: a merge decision on this head must be answered Merge')
	if (input.roundBudget) add('round-budget', input.roundBudget)
	return { ready: blockers.length === 0, head: pr.head, blockers }
}

/** Puts the reviewer notes in the PR body, replacing an earlier copy, so running ready twice changes nothing. */
export function withSections(body: string, sections: string) {
	const start = body.indexOf('<!-- factory:review-notes -->')
	const endMarker = '<!-- /factory:review-notes -->'
	const end = body.indexOf(endMarker)
	if (start >= 0 && end > start) return `${body.slice(0, start)}${sections}${body.slice(end + endMarker.length)}`
	return `${body.trimEnd()}\n\n${sections}\n`
}
