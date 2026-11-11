// Settings come in layers: built-in defaults, `global`, the project's factory.config.yaml, then the
// page's settings for that repository. A later layer wins. An issue resolves them once, at start.

export type Target = {
	provider?: string
	model?: string
	options?: Record<string, string | boolean>
}

export type StageSettings = Target & { note?: string }

export const STAGES = ['research', 'plan', 'implement', 'review', 'land'] as const
export type Stage = (typeof STAGES)[number]
export const DELEGATED = ['research', 'plan', 'implement', 'review'] as const
export type DelegatedStage = (typeof DELEGATED)[number]

export type Settings = {
	orchestrator: Target
	stages: Record<DelegatedStage, StageSettings> & { land: { note?: string } }
	planApproval: 'auto' | 'always' | 'never'
	reviewRounds: number
	rulings: string
}

export type PartialSettings = {
	orchestrator?: Target
	stages?: { [S in Stage]?: Settings['stages'][S] }
	planApproval?: Settings['planApproval']
	reviewRounds?: number
	rulings?: string
}

export type Source = 'default' | 'global' | 'file' | 'repo'
export type Resolved = { settings: Settings; sources: Record<string, Source> }
export type Layers = { global?: PartialSettings; file?: PartialSettings | null; repo?: PartialSettings }

export const defaults: Settings = {
	orchestrator: { provider: 'claudeAgent', model: 'claude-fable-5-2', options: { effort: 'medium' } },
	stages: {
		research: { provider: 'claudeAgent', model: 'claude-sonnet-5-5', options: { effort: 'high' } },
		plan: { provider: 'claudeAgent', model: 'claude-opus-5-5', options: { effort: 'high' } },
		implement: {},
		review: { provider: 'codex', model: 'gpt-6-astra', options: { reasoningEffort: 'high' } },
		land: {}
	},
	planApproval: 'auto',
	reviewRounds: 2,
	rulings: ''
}

const APPROVALS = ['auto', 'always', 'never']

const isObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value)

function checkKeys(value: Record<string, unknown>, allowed: string[], path: string) {
	for (const key of Object.keys(value)) {
		if (!allowed.includes(key)) throw new Error(`${path}${key}: unknown key`)
	}
}

function checkString(value: unknown, path: string) {
	if (typeof value !== 'string') throw new Error(`${path}: must be text`)
}

function checkTarget(value: Record<string, unknown>, path: string, extra: string[] = []) {
	checkKeys(value, ['provider', 'model', 'options', ...extra], path ? `${path}.` : '')
	const hasProvider = value.provider !== undefined
	const hasModel = value.model !== undefined
	if (hasProvider !== hasModel) throw new Error(`${path}: provider and model must be given together`)
	if (value.options !== undefined && !hasModel) throw new Error(`${path}.options: needs provider and model`)
	if (hasProvider) checkString(value.provider, `${path}.provider`)
	if (hasModel) checkString(value.model, `${path}.model`)
	if (value.options !== undefined) {
		if (!isObject(value.options)) throw new Error(`${path}.options: must be a mapping`)
		for (const [key, option] of Object.entries(value.options)) {
			if (typeof option !== 'string' && typeof option !== 'boolean') {
				throw new Error(`${path}.options.${key}: must be text or true/false`)
			}
		}
	}
}

/** Checks one layer and returns it typed. The message names the key's path, such as `stages.reviw: unknown key`. */
export function validate(value: unknown, where = 'settings'): PartialSettings {
	if (value === null || value === undefined) return {}
	if (!isObject(value)) throw new Error(`${where}: must be a mapping`)
	checkKeys(value, ['orchestrator', 'stages', 'planApproval', 'reviewRounds', 'rulings'], '')
	if (value.orchestrator !== undefined) {
		if (!isObject(value.orchestrator)) throw new Error('orchestrator: must be a mapping')
		checkTarget(value.orchestrator, 'orchestrator')
	}
	if (value.stages !== undefined) {
		if (!isObject(value.stages)) throw new Error('stages: must be a mapping')
		checkKeys(value.stages, [...STAGES], 'stages.')
		for (const [stage, settings] of Object.entries(value.stages)) {
			const path = `stages.${stage}`
			if (!isObject(settings)) throw new Error(`${path}: must be a mapping`)
			if (stage === 'land') checkKeys(settings, ['note'], `${path}.`)
			else checkTarget(settings, path, ['note'])
			if (settings.note !== undefined) checkString(settings.note, `${path}.note`)
		}
	}
	if (value.planApproval !== undefined && !APPROVALS.includes(value.planApproval as string)) {
		throw new Error(`planApproval: must be one of ${APPROVALS.join(', ')}`)
	}
	if (value.reviewRounds !== undefined) {
		const rounds = value.reviewRounds
		if (typeof rounds !== 'number' || !Number.isInteger(rounds) || rounds < 0 || rounds > 5) {
			throw new Error('reviewRounds: must be a whole number from 0 to 5')
		}
	}
	if (value.rulings !== undefined) checkString(value.rulings, 'rulings')
	return value as PartialSettings
}

const targetOf = (value: Target): Target => {
	const target: Target = { provider: value.provider, model: value.model }
	if (value.options) target.options = value.options
	return target
}

/** Resolves the layers in order. A target (provider, model, options) is one unit: a layer that sets one replaces it whole. */
export function resolve(layers: Layers): Resolved {
	const settings: Settings = structuredClone(defaults)
	const sources: Record<string, Source> = {}
	const mark = (key: string, source: Source) => {
		sources[key] = source
	}
	mark('orchestrator', 'default')
	for (const stage of STAGES) {
		if (stage !== 'land') mark(`stages.${stage}`, 'default')
		mark(`stages.${stage}.note`, 'default')
	}
	for (const key of ['planApproval', 'reviewRounds', 'rulings']) mark(key, 'default')

	const ordered: [Source, PartialSettings | null | undefined][] = [
		['global', layers.global],
		['file', layers.file],
		['repo', layers.repo]
	]
	for (const [source, layer] of ordered) {
		if (!layer) continue
		if (layer.orchestrator?.model) {
			settings.orchestrator = targetOf(layer.orchestrator)
			mark('orchestrator', source)
		}
		for (const stage of STAGES) {
			const given = layer.stages?.[stage]
			if (!given) continue
			if (stage !== 'land' && 'model' in given && given.model) {
				const note = settings.stages[stage].note
				settings.stages[stage] = { ...targetOf(given), ...(note !== undefined && { note }) }
				mark(`stages.${stage}`, source)
			}
			if (given.note !== undefined) {
				settings.stages[stage].note = given.note
				mark(`stages.${stage}.note`, source)
			}
		}
		if (layer.planApproval !== undefined) {
			settings.planApproval = layer.planApproval
			mark('planApproval', source)
		}
		if (layer.reviewRounds !== undefined) {
			settings.reviewRounds = layer.reviewRounds
			mark('reviewRounds', source)
		}
		if (layer.rulings !== undefined) {
			settings.rulings = layer.rulings
			mark('rulings', source)
		}
	}

	// A stage with no target of its own runs on the orchestrator's model.
	for (const stage of DELEGATED) {
		if (!settings.stages[stage].model) {
			const note = settings.stages[stage].note
			settings.stages[stage] = { ...targetOf(settings.orchestrator), ...(note !== undefined && { note }) }
			sources[`stages.${stage}`] = sources.orchestrator as Source
		}
	}
	return { settings, sources }
}

/** The target a delegated stage runs on, without its note. */
export function stageTarget(settings: Settings, stage: DelegatedStage): Target {
	return targetOf(settings.stages[stage])
}
