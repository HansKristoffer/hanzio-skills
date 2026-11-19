// Stage results are checked against one definition and kept; the review's findings become a ledger
// whose context the service writes, so a review never sees the implementer's claims.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { buildBrief } from './brief.ts'
import { scratchRepo, setup, type Harness } from './fixtures/harness.ts'
import { RESULT_SHAPES, check, describe, example, outcomeShape, type ResultKind } from './results.ts'
import { defaults } from './settings.ts'

let h: Harness
const as = (path: string, body: Record<string, unknown> = {}) => h.as('t1')('POST', path, body)

beforeEach(async () => {
	h = setup()
	const { work } = scratchRepo(h.dir)
	await as('/api/issue/start', { cwd: work, title: 'Exports time out' })
})
afterEach(() => h.close())

const done = (result: unknown) => ({ outcome: 'done', result })
async function runWith(stage: string, result: unknown, extra: Record<string, unknown> = {}) {
	const run = (await as('/api/issue/run', { stage, ...extra })).body.run as string
	const res = await h.as('child')('POST', `/api/runs/${run}/report`, { text: 'done', done: true, result })
	return { run, res }
}

const research = { asked: 'Exports of large accounts time out', kind: 'bug', size: 'S', route: 'implement', reproduction: { command: 'bun test x', base: 'ba5e123', observed: '1 fail' }, checks: [] }
const implement = (findings?: unknown[]) => ({
	built: 'Exports of any size now finish',
	prUrl: 'https://github.com/acme/api/pull/7',
	commit: 'abc1234',
	claims: [{ claim: 'Exports stream', evidence: 'IMPLEMENTER-CLAIM-TEXT' }],
	notChecked: [],
	leftOut: [],
	decisions: [],
	...(findings && { findings })
})
const review = (findings: unknown[], extra: Record<string, unknown> = {}) => ({
	commit: 'abc1234',
	findings,
	reproductionOnHead: 'passes',
	testsFailWithoutFix: true,
	risk: { door: 'two-way', reach: 'module', unrelated: [], focus: ['src/export.ts'] },
	...extra
})
const important = { file: 'src/export.ts', line: 12, severity: 'important', text: 'The stream is never closed' }

test('every stage takes a valid result, and refuses a wrong key naming its path while the run stays open', async () => {
	for (const kind of Object.keys(RESULT_SHAPES) as ResultKind[]) {
		expect(check(done(example(RESULT_SHAPES[kind])), outcomeShape(kind))).toBeNull()
	}
	const run = (await as('/api/issue/run', { stage: 'research' })).body.run
	const bad = await h.as('child')('POST', `/api/runs/${run}/report`, { text: 'x', done: true, result: done({ ...research, sise: 'S' }) })
	expect(bad.status).toBe(400)
	expect(bad.body.error).toContain('result.result.sise: unknown key')
	const missing = await h.as('child')('POST', `/api/runs/${run}/report`, { text: 'x', done: true })
	expect(missing.body.error).toContain('needs --result-file')
	let runs = (await as('/api/issue/status')).body.runs
	expect(runs[0].state).toBe('running')
	const ok = await h.as('child')('POST', `/api/runs/${run}/report`, { text: 'x', done: true, result: done(research) })
	expect(ok.status).toBe(200)
	runs = (await as('/api/issue/status')).body.runs
	expect(runs[0].result.result.route).toBe('implement')
})

test('research can finish on its recommendation and carry the question, which reaches the implementer', async () => {
	const question = { question: 'Web only, or the app too?', recommendation: 'Web only', options: ['Both'], oneWay: false }
	const { res } = await runWith('research', done({ ...research, undecided: [question] }))
	expect(res.status).toBe(200)
	expect((await as('/api/issue/run', { stage: 'implement' })).body.brief).toContain('Web only, or the app too?')
})

test('a stop outcome is checked against its own shape', () => {
	const shape = outcomeShape('research')
	expect(check({ outcome: 'blocked', missing: 'API key', tried: ['env'] }, shape)).toBeNull()
	expect(check({ outcome: 'blocked', missing: 'API key' }, shape)).toBe('result.tried: is missing')
	expect(check({ outcome: 'gave-up' }, shape)).toContain("result.outcome: \"gave-up\" is not one of 'done'")
})

test("the brief shows the shape the service checks, and the shape's own example passes", () => {
	for (const stage of ['research', 'plan', 'implement', 'review'] as const) {
		const brief = buildBrief({ stage, runId: 'r_1', settings: defaults, issue: { title: 't', source: null, body: null } })
		const kind = stage
		expect(brief).toContain(describe(RESULT_SHAPES[kind]))
		expect(check(done(example(RESULT_SHAPES[kind])), outcomeShape(kind))).toBeNull()
	}
})

test('status says when a run ended without a result', async () => {
	const run = (await as('/api/issue/run', { stage: 'research' })).body.run
	await as(`/api/runs/${run}/report`, { text: 'child died', failed: true })
	const runs = (await as('/api/issue/status')).body.runs
	expect(runs[0].result).toBeNull()
	expect(runs[0].resultMissing).toBe('ended without a result')
})

test('a review run takes no context from the orchestrator', async () => {
	const res = await as('/api/issue/run', { stage: 'review', context: 'The implementer says it is fine' })
	expect(res.status).toBe(400)
	expect(res.body.error).toContain('no --context-file')
})

test("review findings get ids; the next review lists them with their outcome and none of the implementer's claims", async () => {
	await runWith('research', done(research))
	await runWith('implement', done(implement()))
	const first = await runWith('review', done(review([important, { ...important, severity: 'nit', text: 'Rename x' }])))
	const [bug, nit] = first.res.body.findings as string[]
	expect(bug).toMatch(/^f_/)

	const fix = (await as('/api/issue/run', { stage: 'implement' })).body
	expect(fix.brief).toContain(bug)
	expect(fix.brief).toContain("Research's result")
	await h.as('child2')('POST', `/api/runs/${fix.run}/report`, {
		text: 'fixed',
		done: true,
		result: done(implement([{ id: bug, outcome: 'fixed', commit: 'def5678' }, { id: nit, outcome: 'declined', reason: 'x is the domain term' }]))
	})

	const second = (await as('/api/issue/run', { stage: 'review', on: 'pr', head: 'def5678' })).body.brief as string
	expect(second).toContain(`${bug} (important, src/export.ts:12)`)
	expect(second).toContain('[fixed in def5678]')
	expect(second).toContain('[declined: x is the domain term]')
	expect(second).toContain('git diff abc1234..def5678')
	expect(second).toContain("### Research's reproduction, red on the base")
	expect(second).toContain('"command": "bun test x"')
	expect(second).not.toContain('IMPLEMENTER-CLAIM-TEXT')
})

test('a later implement round is given the earlier result to return whole, without its finding outcomes', async () => {
	const first = (await as('/api/issue/run', { stage: 'implement' })).body
	expect(first.brief).not.toContain('Your result of the earlier round')
	await h.as('child')('POST', `/api/runs/${first.run}/report`, { text: 'done', done: true, result: done(implement()) })
	const [bug] = (await runWith('review', done(review([important])))).res.body.findings as string[]
	await runWith('implement', done(implement([{ id: bug, outcome: 'fixed', commit: 'def5678' }])))
	const brief = (await as('/api/issue/run', { stage: 'implement' })).body.brief as string
	const earlier = brief.split('### Your result of the earlier round')[1]!.split('\n### ')[0]!
	expect(earlier).toContain('IMPLEMENTER-CLAIM-TEXT')
	expect(earlier).toContain('Exports of any size now finish')
	expect(earlier).not.toContain('"findings"')
})

test("the risk of the PR is the widest any review round found, with every round's focus, on the page and in the PR's body", async () => {
	await runWith('implement', done(implement()))
	await as('/api/issue/update', { pr: 'https://github.com/acme/api/pull/7' })
	await runWith('review', done(review([], { risk: { door: 'one-way', reach: 'data', unrelated: [], focus: ['The migration drops a column'] } })))
	// The second round reads only the new commits, so its own verdict is narrower.
	await runWith('review', done(review([], { commit: 'def5678', risk: { door: 'two-way', reach: 'local', unrelated: [], focus: ['src/export.ts:12'] } })), { head: 'def5678' })
	expect((await as('/api/issue/status')).body.reviewRisk).toEqual({
		door: 'one-way',
		reach: 'data',
		focus: ['The migration drops a column', 'src/export.ts:12'],
		unrelated: []
	})
	const notes = (await as('/api/issue/pr/plan', { action: 'notes' })).body.sections as string
	expect(notes).toContain('### Where to look first\n\n- The migration drops a column\n- src/export.ts:12')
})

test('a review brief carries no reproduction when research could not make one', async () => {
	await runWith('research', done({ ...research, reproduction: { notPossible: 'Only on the customer tenant' } }))
	await runWith('implement', done(implement()))
	const brief = (await as('/api/issue/run', { stage: 'review', head: 'abc1234' })).body.brief as string
	expect(brief).not.toContain("Research's reproduction")
	expect(brief).not.toContain('Only on the customer tenant')
})

test('a declined finding the next review upholds is open again for the next implement run', async () => {
	await runWith('implement', done(implement()))
	const [bug] = (await runWith('review', done(review([important])))).res.body.findings as string[]
	await runWith('implement', done(implement([{ id: bug, outcome: 'declined', reason: 'Closed by the caller' }])))
	await runWith('review', done(review([], { upheld: [bug] })), { head: 'abc1234' })
	const findings = (await as('/api/issue/status')).body.findings as { id: string; outcome: string }[]
	expect(findings.find((f) => f.id === bug)?.outcome).toBe('upheld')
	expect((await as('/api/issue/run', { stage: 'implement' })).body.brief).toContain(bug)
	const unknown = await runWith('review', done(review([], { upheld: ['f_nope'] })), { head: 'x' })
	expect(unknown.res.body.error).toContain('f_nope is not a finding of this issue')
})

test('the orchestrator records its own outcome for a finding', async () => {
	await runWith('implement', done(implement()))
	const [bug] = (await runWith('review', done(review([{ ...important, severity: 'pre-existing', title: 'Old leak' }])))).res.body.findings
	const res = await as('/api/issue/finding', { id: bug, outcome: 'filed', note: 'https://github.com/acme/api/issues/9' })
	expect(res.status).toBe(200)
	const findings = (await as('/api/issue/status')).body.findings
	expect(findings[0]).toMatchObject({ outcome: 'filed', outcomeNote: 'https://github.com/acme/api/issues/9' })
})

test('the issue warns when review and implement run on one provider', async () => {
	expect((await as('/api/issue/status')).body.warnings).toEqual([])
	await h.call('PUT', '/api/settings/global', { stages: { review: { provider: 'claudeAgent', model: 'claude-opus-5-5' } } })
	await as('/api/issue/start', {})
	expect((await as('/api/issue/status')).body.warnings[0]).toContain('both run on claudeAgent')
})

test('a stage runs on its fallback only when asked and when the settings name one', async () => {
	const refused = await as('/api/issue/run', { stage: 'review', fallback: true })
	expect(refused.status).toBe(400)
	expect(refused.body.error).toContain('the settings name no fallback for review')
	await h.call('PUT', '/api/settings/global', { stages: { review: { fallback: { provider: 'claudeAgent', model: 'claude-opus-5-5' } } } })
	await as('/api/issue/start', {})
	expect((await as('/api/issue/run', { stage: 'review' })).body.target.model).toBe('gpt-6-astra')
	const second = await as('/api/issue/run', { stage: 'review', fallback: true })
	expect(second.body.target).toEqual({ provider: 'claudeAgent', model: 'claude-opus-5-5' })
	const status = (await as('/api/issue/status', {})).body
	expect(status.runs.at(-1)).toMatchObject({ stage: 'review', provider: 'claudeAgent', model: 'claude-opus-5-5', state: 'running' })
})

test("a run that ended early leaves its progress lines to the next run of the stage, and an implement brief has the user's answers", async () => {
	const first = (await as('/api/issue/run', { stage: 'review' })).body.run as string
	await h.as('child')('POST', `/api/runs/${first}/report`, { text: 'Finding (important) src/export.ts:12: the stream is never closed' })
	await as(`/api/runs/${first}/report`, { text: 'The provider refused the run', failed: true })
	const again = (await as('/api/issue/run', { stage: 'review' })).body.brief as string
	expect(again).toContain('An earlier run of this stage ended without a result')
	expect(again).toContain('src/export.ts:12: the stream is never closed')

	const open = (await as('/api/issue/ask', { kind: 'question', provisional: true, question: 'Web only, or the app too?', recommend: 'Web only' })).body.decision
	expect((await as('/api/issue/run', { stage: 'implement' })).body.brief).toContain('Not answered yet. Build on the recommendation: Web only')
	await as('/api/issue/answer', { decision: open, text: 'Both' })
	const brief = (await as('/api/issue/run', { stage: 'implement' })).body.brief as string
	expect(brief).toContain('Answered: Both')
	expect((await as('/api/issue/run', { stage: 'review' })).body.brief).not.toContain('Questions asked of the user')
})

test('a feature research result may omit reproduction, and compact status trims superseded runs and plan markdown', async () => {
	const featureResearch = { asked: 'Add dark mode toggle', kind: 'feature', size: 'M', route: 'plan', checks: [] }
	expect((await runWith('research', done(featureResearch))).res.status).toBe(200)
	const planPayload = (body: string) => ({
		planned: 'Adds a theme toggle.',
		outline: ['Toggle in header'],
		plan: body,
		criteria: ['Toggle persists'],
		proof: 'screenshot',
		undecided: [],
		later: []
	})
	await runWith('plan', done(planPayload('first draft '.repeat(50))))
	await runWith('plan', done(planPayload('final plan '.repeat(100))))

	const compact = (await as('/api/issue/status', {})).body.runs as { stage: string; result: Record<string, any> }[]
	const planRuns = compact.filter((r) => r.stage === 'plan')
	expect(planRuns[0]!.result).toEqual({ outcome: 'done', superseded: true })
	expect(planRuns[1]!.result.result.plan).toBeUndefined()
	expect(planRuns[1]!.result.result.planChars).toBe('final plan '.repeat(100).length)
	expect(planRuns[1]!.result.result.outline).toEqual(['Toggle in header'])

	const full = (await as('/api/issue/status', { full: true })).body.runs as { stage: string; result: Record<string, any> }[]
	expect(full.filter((r) => r.stage === 'plan')[1]!.result.result.plan).toContain('final plan')
})
