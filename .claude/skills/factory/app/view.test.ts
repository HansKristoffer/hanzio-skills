import { describe, expect, test } from 'bun:test'
import type { DecisionRow, FindingRow, RunRow } from './db.ts'
import { deriveBrief, deriveStatus } from './view.ts'

const baseInput = () => ({
	state: 'open',
	outcome: null as string | null,
	stage: 'research' as const,
	threadGone: false,
	undelivered: false,
	stuck: false,
	decisions: [] as DecisionRow[],
	waiting: null,
	runs: [] as RunRow[],
	findings: [] as FindingRow[],
	prChecks: null as string | null
})

const makeRun = (over: Partial<RunRow>): RunRow => ({
	id: 'r_1',
	issue_id: 't1',
	stage: 'research',
	subject: null,
	state: 'done',
	thread_id: null,
	provider: 'anthropic',
	model: 'claude-sonnet-4-6',
	options: null,
	summary: null,
	head: null,
	result: null,
	started_at: 1000,
	ended_at: 2000,
	...over
})

const makeDecision = (over: Partial<DecisionRow>): DecisionRow => ({
	id: 'd_1',
	issue_id: 't1',
	kind: 'question',
	provisional: 0,
	question: 'Blue or green?',
	body: null,
	recommendation: 'Blue',
	options: '["Blue","Green"]',
	answer: null,
	answered_via: null,
	answered_from: null,
	delivery: null,
	asked_at: 5000,
	answered_at: null,
	head: null,
	round: null,
	superseded_by: null,
	...over
})

describe('deriveStatus', () => {
	test('classifies open decisions, action labels, and blocking pause time', () => {
		const d = deriveStatus({
			...baseInput(),
			stage: 'plan',
			decisions: [
				makeDecision({ id: 'd_1', kind: 'question', asked_at: 4000 }),
				makeDecision({ id: 'd_2', kind: 'plan', question: 'Approve plan?', asked_at: 6000 })
			]
		})
		expect(d.group).toBe('needs')
		expect(d.tone).toBe('warn')
		expect(d.label).toBe('1 question, plan to approve')
		expect(d.detail).toBe('Paused')
		expect(d.since).toBe(4000)
		expect(d.actionLabel).toBe('Review plan')
		expect(d.attention).toBe(false)
	})

	test('classifies running stage, skipped stages, and open review findings', () => {
		const runs = [
			makeRun({ id: 'r_1', stage: 'research', state: 'done', started_at: 100, ended_at: 200 }),
			makeRun({ id: 'r_2', stage: 'implement', state: 'done', started_at: 300, ended_at: 400 }),
			makeRun({ id: 'r_3', stage: 'review', subject: 'pr', state: 'running', model: 'gpt-6-astra', started_at: 500, ended_at: null })
		]
		const findings: FindingRow[] = [
			{
				id: 'f_1',
				issue_id: 't1',
				run_id: 'r_3',
				subject: 'pr',
				severity: 'important',
				file: 'src/a.ts',
				line: 10,
				title: 'Race condition',
				text: 'Missing lock',
				outcome: null,
				outcome_note: null
			}
		]
		const d = deriveStatus({ ...baseInput(), stage: 'review', runs, findings, prChecks: 'failing' })
		expect(d.group).toBe('working')
		expect(d.tone).toBe('live')
		expect(d.running).toBe(true)
		expect(d.label).toBe('Review running')
		expect(d.detail).toBe('gpt-6-astra')
		expect(d.since).toBe(500)
		expect(d.attention).toBe(true)
		expect(d.stages.map((s) => [s.stage, s.state])).toEqual([
			['research', 'done'],
			['plan', 'skipped'],
			['implement', 'done'],
			['review', 'running'],
			['land', 'pending']
		])
		expect(d.stages[3]!.openFindings).toBe(1)
		expect(d.stages[3]!.importantFindings).toBe(1)
	})

	test('classifies usage limits and waiting on GitHub review', () => {
		const lim = deriveStatus({
			...baseInput(),
			waiting: { on: 'limit', note: 'Provider quota', since: 1000, until: 9000, who: [], overdue: false, safetyNet: 'on' }
		})
		expect(lim.group).toBe('paused')
		expect(lim.label).toBe('Usage limit')
		expect(lim.until).toBe(9000)

		const wait = deriveStatus({
			...baseInput(),
			waiting: { on: 'review', note: null, since: 2000, until: null, who: ['@anna'], overdue: true, safetyNet: 'off: gh error' }
		})
		expect(wait.group).toBe('waiting')
		expect(wait.tone).toBe('warn')
		expect(wait.label).toBe('Waiting on review (overdue)')
		expect(wait.detail).toBe('@anna')
		expect(wait.alarm).toBe('Safety net off: gh error')
	})
})

describe('deriveBrief', () => {
	test('flattens latest done results across research, plan, and implement', () => {
		const brief = deriveBrief([
			makeRun({ stage: 'research', result: JSON.stringify({ outcome: 'done', result: { asked: 'Fix timeout' } }) }),
			makeRun({
				stage: 'plan',
				result: JSON.stringify({
					outcome: 'done',
					result: { planned: 'Use cursor pagination', plan: '# Full plan', outline: ['Step 1'], criteria: ['Fast'], later: [{ title: 'UI polish', body: 'Refine loading state' }] }
				})
			}),
			makeRun({
				stage: 'implement',
				result: JSON.stringify({
					outcome: 'done',
					result: {
						built: 'Switched to cursor pagination',
						claims: [{ claim: 'Tests pass', evidence: 'bun test: 42 passed' }],
						tryIt: 'Run bun test',
						notChecked: ['Safari'],
						leftOut: ['Export CSV'],
						decisions: [{ decision: 'Page size 50', confidence: 'low' }]
					}
				})
			})
		])
		expect(brief.asked).toBe('Fix timeout')
		expect(brief.planned).toBe('Use cursor pagination')
		expect(brief.built).toBe('Switched to cursor pagination')
		expect(brief.plan).toBe('# Full plan')
		expect(brief.outline).toEqual(['Step 1'])
		expect(brief.criteria).toEqual(['Fast'])
		expect(brief.later).toEqual([{ title: 'UI polish', body: 'Refine loading state' }])
		expect(brief.claims).toEqual([{ claim: 'Tests pass', evidence: 'bun test: 42 passed' }])
		expect(brief.tryIt).toBe('Run bun test')
		expect(brief.notChecked).toEqual(['Safari'])
		expect(brief.leftOut).toEqual(['Export CSV'])
		expect(brief.decisions).toEqual([{ decision: 'Page size 50', confidence: 'low' }])
	})
})
