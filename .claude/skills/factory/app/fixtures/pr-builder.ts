// Builds what `readPr` returns, in GitHub's shapes, for tests of the review rules.
import type { RawPr } from '../gh.ts'

export const HEAD = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'
let n = 0
const id = (prefix: string) => `${prefix}_${++n}`
/** Comments start a day ago, so every one is in the past whatever the clock says. */
const START = Date.now() - 24 * 60 * 60 * 1000
export const minute = (m: number) => START + m * 60_000
const at = (m: number) => new Date(minute(m)).toISOString()

type Who = { login: string; association?: string; bot?: boolean }
const author = (who: Who) => ({
	authorAssociation: who.association ?? (who.bot ? 'NONE' : 'MEMBER'),
	author: { login: who.login, __typename: who.bot ? 'Bot' : 'User' }
})

export const member = (login = 'anna'): Who => ({ login, association: 'MEMBER' })
export const outsider = (login = 'stranger'): Who => ({ login, association: 'NONE' })
export const bot = (login = 'greptile-apps'): Who => ({ login, bot: true })

export function comment(who: Who, body: string, minute: number, extra: Record<string, unknown> = {}) {
	return { id: id('C'), body, url: `https://github.com/acme/api/pull/7#c${n}`, createdAt: at(minute), lastEditedAt: null, ...author(who), ...extra }
}

export function thread(comments: ReturnType<typeof comment>[], state: { resolved?: boolean; outdated?: boolean } = {}) {
	return {
		id: id('PRRT'),
		isResolved: !!state.resolved,
		isOutdated: !!state.outdated,
		path: 'src/export.ts',
		line: 12,
		comments: { totalCount: comments.length, nodes: comments }
	}
}

export function review(who: Who, state: string, minute: number, body = '', commit = HEAD) {
	return { id: id('PRR'), state, body, url: `https://github.com/acme/api/pull/7#r${n}`, submittedAt: at(minute), lastEditedAt: null, commit: { oid: commit }, ...author(who) }
}

export function rawPr(parts: Partial<RawPr> & { view?: Record<string, unknown>; body?: string } = {}): RawPr & { body?: string } {
	return {
		required: [{ name: 'tests', bucket: 'pass' }],
		rules: [{ type: 'pull_request', parameters: { required_approving_review_count: 0, required_review_thread_resolution: false } }],
		threads: [],
		reviews: [],
		comments: [],
		...parts,
		view: {
			number: 7,
			url: 'https://github.com/acme/api/pull/7',
			state: 'OPEN',
			isDraft: false,
			headRefOid: HEAD,
			baseRefName: 'main',
			author: { login: 'maintainer', is_bot: false },
			mergeable: 'MERGEABLE',
			mergeStateStatus: 'CLEAN',
			reviewDecision: '',
			statusCheckRollup: [{ __typename: 'CheckRun', name: 'tests', status: 'COMPLETED', conclusion: 'SUCCESS' }],
			reviewRequests: [],
			...parts.view
		}
	}
}
