// The result each stage's child reports with `factory report --done --result-file`. One definition per
// stage gives both the text the brief shows and the check the service runs, so they cannot drift.

export type Shape =
	| { t: 'string' }
	| { t: 'number' }
	| { t: 'boolean' }
	| { t: 'enum'; values: readonly (string | boolean)[] }
	| { t: 'list'; of: Shape; max?: number }
	| { t: 'object'; fields: Record<string, Shape>; optional: readonly string[] }
	| { t: 'either'; of: readonly Shape[] }

const str: Shape = { t: 'string' }
const num: Shape = { t: 'number' }
const bool: Shape = { t: 'boolean' }
const oneOf = (...values: (string | boolean)[]): Shape => ({ t: 'enum', values })
const list = (of: Shape, max?: number): Shape => ({ t: 'list', of, ...(max !== undefined && { max }) })
const obj = (fields: Record<string, Shape>, optional: string[] = []): Shape => ({ t: 'object', fields, optional })
const either = (...of: Shape[]): Shape => ({ t: 'either', of })

/** A question only the user can settle, with what the stage went on with. */
const undecided = list(obj({ question: str, recommendation: str, options: list(str), oneWay: bool }, ['options']))

const reviewFinding = (withFile: boolean) =>
	obj(
		{
			...(withFile && { file: str, line: num }),
			severity: withFile ? oneOf('important', 'nit', 'pre-existing') : oneOf('important', 'nit'),
			title: str,
			text: str
		},
		withFile ? ['line', 'title'] : ['title']
	)

export const RESULT_SHAPES = {
	research: obj(
		{
			kind: oneOf('bug', 'feature'),
			size: oneOf('S', 'M', 'L'),
			route: oneOf('implement', 'plan'),
			reproduction: either(obj({ command: str }), obj({ notPossible: str })),
			checks: list(obj({ command: str, baseline: str })),
			undecided,
			notes: str
		},
		['undecided', 'notes']
	),
	plan: obj({
		plan: str,
		criteria: list(str, 5),
		proof: str,
		undecided,
		later: list(obj({ title: str, body: str }))
	}),
	'review-plan': obj({ findings: list(reviewFinding(false)), upheld: list(str) }, ['upheld']),
	implement: obj(
		{
			prUrl: str,
			commit: str,
			claims: list(obj({ claim: str, evidence: str })),
			notChecked: list(str),
			decisions: list(obj({ decision: str, confidence: oneOf('low', 'medium', 'high') })),
			findings: list(obj({ id: str, outcome: oneOf('fixed', 'declined'), commit: str, reason: str }, ['commit', 'reason']))
		},
		['findings']
	),
	review: obj(
		{
			commit: str,
			findings: list(reviewFinding(true)),
			testsFailWithoutFix: oneOf(true, false, 'no-new-tests'),
			risk: obj({
				door: oneOf('one-way', 'two-way'),
				reach: oneOf('local', 'module', 'app', 'data'),
				unrelated: list(str),
				focus: list(str)
			}),
			upheld: list(str)
		},
		['upheld']
	)
} as const satisfies Record<string, Shape>

export type ResultKind = keyof typeof RESULT_SHAPES

/** Every outcome a child can end with: done with its stage's result, or one of the stops. */
export function outcomeShape(kind: ResultKind): Shape {
	return either(
		obj({ outcome: oneOf('done'), result: RESULT_SHAPES[kind] }),
		obj({ outcome: oneOf('not-a-bug', 'already-fixed'), reason: str }),
		obj({ outcome: oneOf('duplicate'), duplicateOf: str }),
		obj({ outcome: oneOf('blocked'), missing: str, tried: list(str) }),
		obj({ outcome: oneOf('needs-decision'), question: str, recommendation: str, options: list(str), oneWay: bool }, ['options'])
	)
}

/** The shape as the brief shows it, such as `{ kind: 'bug' | 'feature', line?: number }`. */
export function describe(shape: Shape): string {
	switch (shape.t) {
		case 'string':
		case 'number':
			return shape.t
		case 'boolean':
			return 'true | false'
		case 'enum':
			return shape.values.map((v) => (typeof v === 'string' ? `'${v}'` : String(v))).join(' | ')
		case 'list': {
			const inner = describe(shape.of)
			const item = shape.of.t === 'object' ? `[${inner}]` : `${shape.of.t === 'enum' || shape.of.t === 'either' ? `(${inner})` : inner}[]`
			return shape.max === undefined ? item : `${item} (at most ${shape.max})`
		}
		case 'object': {
			const fields = Object.entries(shape.fields).map(
				([key, value]) => `${key}${shape.optional.includes(key) ? '?' : ''}: ${describe(value)}`
			)
			return `{ ${fields.join(', ')} }`
		}
		case 'either':
			return shape.of.map(describe).join(' | ')
	}
}

/** A value of the shape, with every optional key filled, for the brief's example and the tests. */
export function example(shape: Shape): unknown {
	switch (shape.t) {
		case 'string':
			return '…'
		case 'number':
			return 1
		case 'boolean':
			return true
		case 'enum':
			return shape.values[0]
		case 'list':
			return [example(shape.of)]
		case 'object':
			return Object.fromEntries(Object.entries(shape.fields).map(([key, value]) => [key, example(value)]))
		case 'either':
			return example(shape.of[0]!)
	}
}

const isObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value)

/** Checks a value against a shape. Returns the first problem with the key's path, or null. */
export function check(value: unknown, shape: Shape, path = 'result'): string | null {
	switch (shape.t) {
		case 'string':
			return typeof value === 'string' ? null : `${path}: must be text`
		case 'number':
			return typeof value === 'number' && Number.isFinite(value) ? null : `${path}: must be a number`
		case 'boolean':
			return typeof value === 'boolean' ? null : `${path}: must be true or false`
		case 'enum':
			return shape.values.includes(value as string) ? null : `${path}: ${JSON.stringify(value)} is not one of ${describe(shape)}`
		case 'list': {
			if (!Array.isArray(value)) return `${path}: must be a list`
			if (shape.max !== undefined && value.length > shape.max) return `${path}: has ${value.length} items, at most ${shape.max}`
			for (const [i, item] of value.entries()) {
				const problem = check(item, shape.of, `${path}[${i}]`)
				if (problem) return problem
			}
			return null
		}
		case 'object': {
			if (!isObject(value)) return `${path}: must be an object`
			for (const key of Object.keys(value)) {
				if (!(key in shape.fields)) return `${path}.${key}: unknown key; the keys are ${Object.keys(shape.fields).join(', ')}`
			}
			for (const [key, field] of Object.entries(shape.fields)) {
				if (value[key] === undefined) {
					if (shape.optional.includes(key)) continue
					return `${path}.${key}: is missing`
				}
				const problem = check(value[key], field, `${path}.${key}`)
				if (problem) return problem
			}
			return null
		}
		case 'either': {
			const problems = shape.of.map((option) => check(value, option, path))
			if (problems.some((p) => p === null)) return null
			// For outcomes, explain against the branch the value names, not the first branch.
			if (isObject(value) && 'outcome' in value) {
				const named = shape.of.findIndex(
					(option) => option.t === 'object' && check(value.outcome, option.fields.outcome ?? str, '') === null
				)
				if (named >= 0) return problems[named]!
				const outcomes = shape.of.flatMap((o) => (o.t === 'object' && o.fields.outcome?.t === 'enum' ? o.fields.outcome.values : []))
				return `${path}.outcome: ${JSON.stringify(value.outcome)} is not one of ${outcomes.map((o) => `'${o}'`).join(', ')}`
			}
			return problems.find((p) => !p?.endsWith('must be an object')) ?? problems[0]!
		}
	}
}
