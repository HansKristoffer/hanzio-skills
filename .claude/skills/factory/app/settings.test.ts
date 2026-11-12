import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { git, scratchRepo, setup, type Harness } from './fixtures/harness.ts'
import { defaults, resolve, stageTarget, validate } from './settings.ts'

describe('resolve', () => {
	test('a layer that sets a stage target replaces its options and leaves other stages alone', () => {
		const { settings, sources } = resolve({
			global: { stages: { plan: { provider: 'codex', model: 'gpt-6-astra', options: { reasoningEffort: 'max' } } } },
			repo: { stages: { review: { provider: 'claudeAgent', model: 'claude-opus-5-5' } } }
		})
		expect(settings.stages.review).toEqual({ provider: 'claudeAgent', model: 'claude-opus-5-5' })
		expect(settings.stages.plan.options).toEqual({ reasoningEffort: 'max' })
		expect(settings.stages.research).toEqual(defaults.stages.research)
		expect(sources['stages.review']).toBe('repo')
		expect(sources['stages.plan']).toBe('global')
		expect(sources['stages.research']).toBe('default')
	})

	test('implement runs on the orchestrator target unless it has its own', () => {
		const { settings } = resolve({ file: { orchestrator: { provider: 'codex', model: 'gpt-6-luna' } } })
		expect(settings.stages.implement).toEqual({ provider: 'codex', model: 'gpt-6-luna' })
		expect(resolve({}).settings.stages.implement).toEqual(defaults.orchestrator)
	})

	test('a note replaces by itself and keeps the target', () => {
		const { settings, sources } = resolve({
			global: { stages: { review: { note: 'Global note' } } },
			file: { stages: { review: { note: 'File note' } } }
		})
		expect(settings.stages.review.note).toBe('File note')
		expect(settings.stages.review.model).toBe('gpt-6-astra')
		expect(sources['stages.review.note']).toBe('file')
	})

	test('the later layer wins: repo over file over global', () => {
		const { settings, sources } = resolve({ global: { reviewRounds: 1 }, file: { reviewRounds: 3 }, repo: { reviewRounds: 0 } })
		expect(settings.reviewRounds).toBe(0)
		expect(sources.reviewRounds).toBe('repo')
	})
})

describe('validate', () => {
	const refused = (value: unknown) => {
		try {
			validate(value)
		} catch (error) {
			return (error as Error).message
		}
		return null
	}

	test('names the path of the bad key', () => {
		expect(refused({ stages: { reviw: {} } })).toBe('stages.reviw: unknown key')
		expect(refused({ colour: 'blue' })).toBe('colour: unknown key')
		expect(refused({ stages: { review: { model: 'x' } } })).toBe('stages.review: provider and model must be given together')
		expect(refused({ reviewRounds: -1 })).toBe('reviewRounds: must be a whole number from 0 to 5')
		expect(refused({ planApproval: 'sometimes' })).toBe('planApproval: must be one of auto, always, never')
		expect(refused({ stages: { land: { model: 'x' } } })).toBe('stages.land.model: unknown key')
		expect(refused({ orchestrator: { provider: 'a', model: 'b', options: { effort: 3 } } })).toBe(
			'orchestrator.options.effort: must be text or true/false'
		)
	})

	test('accepts a full layer', () => {
		expect(refused({ orchestrator: { provider: 'claudeAgent', model: 'claude-fable-5-2', options: { effort: 'medium' } }, rulings: 'x' })).toBeNull()
	})
})

describe('the service', () => {
	let h: Harness
	let work: string
	beforeEach(() => {
		h = setup()
		work = scratchRepo(h.dir).work
	})
	afterEach(() => h.close())

	test('a repository scope applies to that repository only, matched without case', async () => {
		git(work, 'remote', 'set-url', 'origin', 'git@github.com:Acme/API.git')
		const other = scratchRepo(join(h.dir, 'second'), 'acme/web').work
		expect((await h.call('PUT', '/api/settings/repo:acme/api', { stages: { review: { provider: 'claudeAgent', model: 'claude-opus-5-5' } } })).status).toBe(200)
		const api = await h.call('POST', '/api/settings/resolve', { cwd: work })
		expect(api.body.repo).toBe('acme/api')
		expect(api.body.settings.stages.review.model).toBe('claude-opus-5-5')
		expect(api.body.sources['stages.review']).toBe('repo')
		const web = await h.call('POST', '/api/settings/resolve', { cwd: other })
		expect(web.body.settings.stages.review.model).toBe('gpt-6-astra')
	})

	test('a bad setting is refused naming the key', async () => {
		const res = await h.call('PUT', '/api/settings/global', { reviewRounds: 9 })
		expect(res.status).toBe(400)
		expect(res.body.error).toContain('reviewRounds')
	})

	test('a running issue keeps its settings until it starts again', async () => {
		await h.as('t1')('POST', '/api/issue/start', { cwd: work, title: 'x' })
		await h.call('PUT', '/api/settings/global', { stages: { research: { provider: 'codex', model: 'gpt-6-luna' } } })
		const before = await h.as('t1')('POST', '/api/issue/run', { stage: 'research' })
		expect(before.body.target.model).toBe('claude-sonnet-5-5')
		expect((await h.call('POST', '/api/settings/resolve', { cwd: work })).body.settings.stages.research.model).toBe('gpt-6-luna')
		await h.as('t1')('POST', '/api/issue/start', { cwd: work })
		const after = await h.as('t1')('POST', '/api/issue/run', { stage: 'research' })
		expect(after.body.target.model).toBe('gpt-6-luna')
		const status = await h.as('t1')('POST', '/api/issue/status', {})
		expect(status.body.runs.map((r: { model: string }) => r.model)).toEqual(['claude-sonnet-5-5', 'gpt-6-luna'])
	})
})

test('the review keys validate, resolve by layer with a list replacing the list below, and name a bad login', () => {
	const file = validate({ reviewers: ['anna', 'acme/backend'], bots: ['greptile-apps[bot]'], approval: 'required', merge: 'never', ignore: ['copilot-pull-request-reviewer'], reviewOverdueHours: 48 })
	const { settings, sources } = resolve({ global: { reviewers: ['bob'], trust: ['contractor'] }, file, repo: { merge: 'ask' } })
	expect(settings.reviewers).toEqual(['anna', 'acme/backend'])
	expect(settings.trust).toEqual(['contractor'])
	expect(settings.merge).toBe('ask')
	expect(settings.approval).toBe('required')
	expect(sources).toMatchObject({ reviewers: 'file', trust: 'global', merge: 'repo', bots: 'file', reviewOverdueHours: 'file' })
	expect(() => validate({ reviewers: ['@anna'] })).toThrow('reviewers[0]: @anna is not a GitHub login or org/team')
	expect(() => validate({ trust: ['two words'] })).toThrow('trust[0]')
	expect(() => validate({ merge: 'sometimes' })).toThrow('merge: must be one of auto, ask, never')
	expect(() => validate({ reviewOverdueHours: 0 })).toThrow('reviewOverdueHours: must be a whole number from 1 to 720')
	expect(resolve({}).settings).toMatchObject({ reviewers: [], bots: [], approval: 'auto', merge: 'auto', trust: [], ignore: [], reviewOverdueHours: 24 })
})

test('a stage can name a fallback target, which a layer sets with or without the stage target', () => {
	const fallback = { provider: 'claudeAgent', model: 'claude-opus-5-5', options: { effort: 'high' } }
	const { settings, sources } = resolve({ global: { stages: { review: { fallback } } }, repo: { stages: { review: { provider: 'codex', model: 'gpt-6-luna' } } } })
	expect(settings.stages.review).toMatchObject({ provider: 'codex', model: 'gpt-6-luna', fallback })
	expect(sources['stages.review.fallback']).toBe('global')
	expect(stageTarget(settings, 'review', true)).toEqual(fallback)
	expect(stageTarget(settings, 'review')).toEqual({ provider: 'codex', model: 'gpt-6-luna' })
	expect(stageTarget(resolve({}).settings, 'review', true)).toBeNull()
	expect(() => validate({ stages: { review: { fallback: { provider: 'codex' } } } })).toThrow('stages.review.fallback: provider and model must be given together')
	expect(() => validate({ stages: { land: { fallback } } })).toThrow('stages.land.fallback: unknown key')
})
