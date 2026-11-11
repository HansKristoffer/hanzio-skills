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

const research = { kind: 'bug', size: 'S', route: 'implement', reproduction: { command: 'bun test x' }, checks: [] }
const implement = (findings?: unknown[]) => ({
	prUrl: 'https://github.com/acme/api/pull/7',
	commit: 'abc1234',
	claims: [{ claim: 'Exports stream', evidence: 'IMPLEMENTER-CLAIM-TEXT' }],
	notChecked: [],
	decisions: [],
	...(findings && { findings })
})
const review = (findings: unknown[], extra: Record<string, unknown> = {}) => ({
	commit: 'abc1234',
	findings,
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
	expect(second).not.toContain('IMPLEMENTER-CLAIM-TEXT')
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
