// Derived view models and normalized API shapes shared by the web page and native clients.
import type { DecisionRow, EventRow, FindingRow, RoundRow, RunRow } from './db.ts'
import type { Measured } from './evidence.ts'
import { STAGES, type Stage } from './settings.ts'

export type IssueGroup = 'needs' | 'working' | 'waiting' | 'paused' | 'done'
export type StatusTone = 'warn' | 'bad' | 'live' | 'ok' | 'idle'
export type StageCellState = 'running' | 'failed' | 'findings' | 'current' | 'done' | 'skipped' | 'pending'

export type DerivedStage = {
	stage: Stage
	state: StageCellState
	runs: number
	failed: boolean
	openFindings: number
	importantFindings: number
	startedAt: number | null
	endedAt: number | null
}

export type DerivedStatus = {
	group: IssueGroup
	tone: StatusTone
	label: string
	detail: string | null
	since: number | null
	until: number | null
	alarm: string | null
	actionLabel: string
	running: boolean
	attention: boolean
	stages: DerivedStage[]
}

export type IssueBrief = {
	asked: string | null
	planned: string | null
	built: string | null
	plan: string | null
	outline: string[]
	criteria: string[]
	later: { title: string; body?: string; after?: string[] }[]
	claims: { claim: string; evidence: string }[]
	measured: Measured | null
	media: string | null
	tryIt: string | null
	notChecked: string[]
	leftOut: string[]
	decisions: { decision: string; confidence: string }[]
}

export type PublicEvent = {
	id: number
	issueId: string
	runId: string | null
	at: number
	kind: string
	text: string
}

export type PublicRound = {
	n: number
	startedAt: number
	startHead: string
	lastHead: string
	pushes: number
	endedAt: number | null
}

export type StreamEvent = {
	id: number
	issue: string | null
	kind: string
	open: number
	needsYou: number
	needsByRepo: Record<string, number>
	title?: string
	summary?: string
}

export type WaitingInfo = {
	on: string
	note: string | null
	since: number | null
	until: number | null
	who: string[]
	overdue: boolean
	safetyNet: string
}

const OUTCOME_LABELS: Record<string, string> = {
	shipped: 'Shipped',
	reviewed: 'Reviewed',
	'not-a-bug': 'Not a bug',
	duplicate: 'Duplicate',
	'already-fixed': 'Already fixed',
	dropped: 'Dropped'
}

const cap = (value: string) => (value ? value[0]!.toUpperCase() + value.slice(1) : '')
const plural = (n: number, singular: string, multiple = `${singular}s`) => `${n} ${n === 1 ? singular : multiple}`
const dotted = (...parts: (string | null | undefined | false)[]) => parts.filter(Boolean).join(' · ') || null

export function outcomeLabel(outcome: string | null | undefined) {
	if (!outcome) return 'Closed'
	return OUTCOME_LABELS[outcome] ?? cap(outcome.replaceAll('-', ' '))
}

export const publicEvent = (e: EventRow): PublicEvent => ({
	id: e.id,
	issueId: e.issue_id,
	runId: e.run_id,
	at: e.at,
	kind: e.kind,
	text: e.text
})

export const publicRound = (r: RoundRow): PublicRound => ({
	n: r.n,
	startedAt: r.started_at,
	startHead: r.start_head,
	lastHead: r.last_head,
	pushes: r.pushes,
	endedAt: r.ended_at
})

function latestDoneResult(runs: RunRow[], stage: Stage, subject: 'plan' | 'pr' | null = null): Record<string, unknown> | null {
	for (let i = runs.length - 1; i >= 0; i--) {
		const r = runs[i]!
		if (r.stage !== stage || r.subject !== subject || r.state !== 'done' || !r.result) continue
		try {
			const parsed = JSON.parse(r.result) as { outcome?: string; result?: Record<string, unknown> }
			if (parsed.outcome === 'done' && parsed.result) return parsed.result
		} catch {
			// Skip malformed stored result.
		}
	}
	return null
}

const strOrNull = (v: unknown) => (typeof v === 'string' && v.length > 0 ? v : null)
const strList = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])

/** Flat summary extracted from the latest completed research, plan, and implement results. */
export function deriveBrief(runs: RunRow[]): IssueBrief {
	const research = latestDoneResult(runs, 'research')
	const plan = latestDoneResult(runs, 'plan')
	const impl = latestDoneResult(runs, 'implement')
	const later = Array.isArray(plan?.later)
		? (plan.later as unknown[])
				.filter((x): x is { title: string; body?: string; after?: unknown } => !!x && typeof x === 'object' && typeof (x as { title?: unknown }).title === 'string')
				.map((x) => ({
					title: x.title,
					...(typeof x.body === 'string' ? { body: x.body } : {}),
					...(Array.isArray(x.after) ? { after: strList(x.after) } : {})
				}))
		: []
	const claims = Array.isArray(impl?.claims)
		? (impl.claims as unknown[])
				.filter(
					(x): x is { claim: string; evidence: string } =>
						!!x && typeof x === 'object' && typeof (x as { claim?: unknown }).claim === 'string' && typeof (x as { evidence?: unknown }).evidence === 'string'
				)
				.map((x) => ({ claim: x.claim, evidence: x.evidence }))
		: []
	const decisions = Array.isArray(impl?.decisions)
		? (impl.decisions as unknown[])
				.filter(
					(x): x is { decision: string; confidence: string } =>
						!!x && typeof x === 'object' && typeof (x as { decision?: unknown }).decision === 'string' && typeof (x as { confidence?: unknown }).confidence === 'string'
				)
				.map((x) => ({ decision: x.decision, confidence: x.confidence }))
		: []
	return {
		asked: strOrNull(research?.asked),
		planned: strOrNull(plan?.planned),
		built: strOrNull(impl?.built),
		plan: strOrNull(plan?.plan),
		outline: strList(plan?.outline),
		criteria: strList(plan?.criteria),
		later,
		claims,
		measured: impl?.measured && typeof impl.measured === 'object' ? (impl.measured as Measured) : null,
		media: strOrNull(impl?.media),
		tryIt: strOrNull(impl?.tryIt),
		notChecked: strList(impl?.notChecked),
		leftOut: strList(impl?.leftOut),
		decisions
	}
}

export type DeriveStatusInput = {
	state: string
	outcome: string | null
	stage: Stage
	threadGone: boolean
	undelivered: boolean
	stuck: boolean
	decisions: DecisionRow[]
	waiting: WaitingInfo | null
	runs: RunRow[]
	findings: FindingRow[]
	prChecks: string | null
}

/** Single source of truth for issue grouping, status tone, next-step label, CTA label, and stage strip. */
export function deriveStatus(input: DeriveStatusInput): DerivedStatus {
	const { state, outcome, stage, threadGone, undelivered, stuck, decisions, waiting, runs, findings, prChecks } = input
	const openDecisions = decisions.filter((d) => d.answer === null && d.superseded_by === null)
	const pendingDelivery = decisions.filter((d) => d.answered_via === 'page' && d.delivery !== 'sent')
	const activeRun = runs.filter((r) => r.state === 'running').at(-1) ?? null
	const hasOpen = (kind: string) => openDecisions.some((d) => d.kind === kind)
	const attention = state === 'open' && (threadGone || undelivered || stuck || prChecks === 'failing' || hasOpen('blocked'))

	const actionLabel = hasOpen('plan')
		? 'Review plan'
		: hasOpen('merge')
			? 'Review & merge'
			: hasOpen('blocked')
				? 'Unblock'
				: openDecisions.length
					? 'Decide'
					: 'Open'

	let group: IssueGroup
	let tone: StatusTone
	let label: string
	let detail: string | null = null
	let since: number | null = null
	let until: number | null = null
	let alarm: string | null = null
	let running = false

	if (state !== 'open') {
		group = 'done'
		tone = outcome === 'shipped' ? 'ok' : 'idle'
		label = outcomeLabel(outcome ?? state)
	} else if (threadGone) {
		group = 'needs'
		tone = 'bad'
		label = 'Thread gone'
		detail = 'T3 Code cannot find its thread'
	} else if (undelivered) {
		group = 'needs'
		tone = 'bad'
		label = 'Message stuck'
		detail = 'Resume queue in T3 Code'
	} else if (stuck) {
		group = 'needs'
		tone = 'bad'
		label = 'Stuck'
		detail = 'No report after nudge'
	} else if (openDecisions.length) {
		const questions = openDecisions.filter((d) => d.kind === 'question').length
		const what = [
			questions ? plural(questions, 'question') : null,
			hasOpen('plan') ? 'plan to approve' : null,
			hasOpen('merge') ? 'merge to decide' : null,
			hasOpen('blocked') ? 'blocked' : null
		].filter(Boolean)
		group = 'needs'
		tone = hasOpen('blocked') ? 'bad' : 'warn'
		label = cap(what.join(', '))
		if (openDecisions.some((d) => !d.provisional)) {
			detail = 'Paused'
			since = Math.min(...openDecisions.map((d) => d.asked_at))
		} else {
			detail = 'Work goes on, merge waits'
		}
	} else if (pendingDelivery.length) {
		group = 'needs'
		tone = 'warn'
		label = 'Answer not delivered'
	} else if (waiting && waiting.on === 'limit') {
		group = 'paused'
		tone = 'idle'
		label = 'Usage limit'
		detail = dotted(waiting.note, 'Resumes automatically')
		until = waiting.until
	} else if (waiting) {
		group = 'waiting'
		tone = waiting.overdue ? 'warn' : 'idle'
		label = `Waiting on ${waiting.on}${waiting.overdue ? ' (overdue)' : ''}`
		detail = dotted(waiting.who.length ? waiting.who.join(', ') : null, waiting.note)
		since = waiting.since
		until = waiting.until
		alarm = waiting.safetyNet !== 'on' ? `Safety net ${waiting.safetyNet}` : null
	} else if (activeRun) {
		group = 'working'
		tone = 'live'
		running = true
		label = `${activeRun.subject === 'plan' ? 'Plan review' : cap(activeRun.stage)} running`
		detail = activeRun.model
		since = activeRun.started_at
	} else {
		group = 'paused'
		tone = 'idle'
		label = runs.length ? 'Between runs' : 'Starting'
	}

	const closed = state !== 'open'
	const at = outcome === 'shipped' ? STAGES.length : STAGES.indexOf(stage)
	const prFindings = findings.filter((f) => f.severity !== 'pre-existing')
	const openFindingsCount = prFindings.filter((f) => f.outcome === null || f.outcome === 'upheld').length
	const importantFindingsCount = prFindings.filter((f) => f.severity === 'important' && (f.outcome === null || f.outcome === 'upheld')).length

	const stages: DerivedStage[] = STAGES.map((st, n) => {
		const mine = runs.filter((r) => r.stage === st)
		const last = mine.at(-1) ?? null
		const isNow = n === at && !closed
		const isRun = isNow && running
		const isFail = last?.state === 'failed' && !isRun
		const isDone = (n < at && mine.length > 0) || (closed && outcome === 'shipped' && mine.length > 0)
		const isSkip = n < at && mine.length === 0
		const revOpen = st === 'review' ? openFindingsCount : 0
		const revImportant = st === 'review' ? importantFindingsCount : 0
		let cellState: StageCellState = 'pending'
		if (isRun) cellState = 'running'
		else if (isFail) cellState = 'failed'
		else if (revOpen > 0 && (isNow || isDone)) cellState = 'findings'
		else if (isNow) cellState = 'current'
		else if (isDone) cellState = 'done'
		else if (isSkip) cellState = 'skipped'
		return {
			stage: st,
			state: cellState,
			runs: mine.length,
			failed: last?.state === 'failed',
			openFindings: revOpen,
			importantFindings: revImportant,
			startedAt: last?.started_at ?? null,
			endedAt: last?.ended_at ?? null
		}
	})

	return {
		group,
		tone,
		label,
		detail,
		since,
		until,
		alarm,
		actionLabel,
		running,
		attention,
		stages
	}
}
