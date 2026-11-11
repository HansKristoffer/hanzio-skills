// Runs GitHub's `gh`. The CLI runs it in the thread's environment for every read and write, so the
// identity is always the thread's; the service runs only the read, with its own login, while an issue
// waits. FACTORY_GH points at another binary, which is what the tests use.

export const ghBinary = () => process.env.FACTORY_GH || 'gh'

export type GhResult = { ok: boolean; out: string; err: string }

export async function gh(args: string[], stdin?: string): Promise<GhResult> {
	let proc: ReturnType<typeof Bun.spawn>
	try {
		proc = Bun.spawn([ghBinary(), ...args], {
			stdin: stdin === undefined ? 'ignore' : new Blob([stdin]),
			env: { ...process.env, GH_PROMPT_DISABLED: '1', NO_COLOR: '1' },
			stdout: 'pipe',
			stderr: 'pipe'
		})
	} catch (error) {
		return { ok: false, out: '', err: `gh could not run: ${(error as Error).message}` }
	}
	const [out, err, code] = await Promise.all([
		new Response(proc.stdout as ReadableStream).text(),
		new Response(proc.stderr as ReadableStream).text(),
		proc.exited
	])
	return { ok: code === 0, out: out.trim(), err: err.trim() }
}

async function must(args: string[], stdin?: string) {
	const result = await gh(args, stdin)
	if (!result.ok) throw new Error(`gh ${args.slice(0, 3).join(' ')}: ${result.err || result.out || 'failed'}`)
	return result.out
}

export type PrRef = { owner: string; name: string; number: number; url: string }

export function parsePrUrl(url: string): PrRef {
	const match = url.match(/^https:\/\/[^/]+\/([^/]+)\/([^/]+)\/pull\/(\d+)/)
	if (!match) throw new Error(`${url} is not a pull request URL`)
	return { owner: match[1]!, name: match[2]!, number: Number(match[3]), url }
}

export const VIEW_FIELDS =
	'number,url,state,isDraft,headRefOid,baseRefName,author,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup,latestReviews,reviewRequests,mergedAt,mergedBy'

const PAGED = (connection: string, size: number, nodes: string) => `query($owner: String!, $name: String!, $pr: Int!, $endCursor: String) {
  repository(owner: $owner, name: $name) { pullRequest(number: $pr) {
    ${connection}(first: ${size}, after: $endCursor) { pageInfo { hasNextPage endCursor } nodes { ${nodes} } }
  } }
}`

const AUTHOR = 'authorAssociation author { login __typename }'
export const QUERIES = {
	threads: PAGED(
		'reviewThreads',
		50,
		`id isResolved isOutdated path line comments(first: 100) { totalCount nodes { id body url createdAt lastEditedAt ${AUTHOR} } }`
	),
	reviews: PAGED('reviews', 100, `id state body url submittedAt lastEditedAt commit { oid } ${AUTHOR}`),
	comments: PAGED('comments', 100, `id body url createdAt lastEditedAt ${AUTHOR}`)
}

/** Everything `pr sync` reads, as `gh` returned it. `pr.ts` turns it into state. */
export type RawPr = {
	view: Record<string, any>
	required: { name: string; bucket: string }[] | null
	rules: { type: string; parameters?: Record<string, unknown> }[] | null
	threads: Record<string, any>[]
	reviews: Record<string, any>[]
	comments: Record<string, any>[]
}

async function paged(ref: PrRef, key: keyof typeof QUERIES) {
	const out = await must([
		'api',
		'graphql',
		'--paginate',
		'--slurp',
		'-f',
		`query=${QUERIES[key]}`,
		'-f',
		`owner=${ref.owner}`,
		'-f',
		`name=${ref.name}`,
		'-F',
		`pr=${ref.number}`
	])
	const pages = JSON.parse(out) as { data: { repository: { pullRequest: Record<string, { nodes: unknown[] }> } } }[]
	const connection = { threads: 'reviewThreads', reviews: 'reviews', comments: 'comments' }[key]
	return pages.flatMap((page) => page.data.repository.pullRequest[connection]?.nodes ?? []) as Record<string, any>[]
}

/** Reads the PR with its checks, rules, conversations, reviews and comments. Throws when the PR cannot be read. */
export async function readPr(url: string): Promise<RawPr> {
	const ref = parsePrUrl(url)
	const view = JSON.parse(await must(['pr', 'view', url, '--json', VIEW_FIELDS])) as Record<string, any>
	const repo = `${ref.owner}/${ref.name}`
	const [checks, rules, threads, reviews, comments] = await Promise.all([
		// Exits non-zero both when checks are pending and when none are required: read the JSON when there is some.
		gh(['pr', 'checks', String(ref.number), '--repo', repo, '--required', '--json', 'name,bucket']),
		gh(['api', `repos/${repo}/rules/branches/${encodeURIComponent(view.baseRefName)}`]),
		paged(ref, 'threads'),
		paged(ref, 'reviews'),
		paged(ref, 'comments')
	])
	return {
		view,
		required: parseList(checks.out),
		rules: rules.ok ? parseList(rules.out) : null,
		threads,
		reviews,
		comments
	}
}

function parseList<T>(out: string): T[] | null {
	try {
		const parsed = JSON.parse(out)
		return Array.isArray(parsed) ? parsed : null
	} catch {
		return null
	}
}

// ---- writes, made by the CLI in the thread ----

export const login = async () => must(['api', 'user', '--jq', '.login'])

export const markReady = (url: string) => must(['pr', 'ready', url])

export const prBody = async (url: string) => (JSON.parse(await must(['pr', 'view', url, '--json', 'body'])) as { body: string }).body

export const setBody = (url: string, body: string) => must(['pr', 'edit', url, '--body-file', '-'], body)

export const addReviewers = (url: string, reviewers: string[]) => must(['pr', 'edit', url, '--add-reviewer', reviewers.join(',')])

/** Asks again someone who already reviewed; `gh pr edit --add-reviewer` may skip them. */
export const requestAgain = (ref: PrRef, reviewer: string) =>
	must(['api', '-X', 'POST', `repos/${ref.owner}/${ref.name}/pulls/${ref.number}/requested_reviewers`, '-f', `reviewers[]=${reviewer}`])

export const comment = (url: string, body: string) => must(['pr', 'comment', url, '--body-file', '-'], body)

export async function replyInThread(threadId: string, body: string) {
	const out = await must([
		'api',
		'graphql',
		'-F',
		`thread=${threadId}`,
		'-f',
		`body=${body}`,
		'-f',
		'query=mutation($thread: ID!, $body: String!) { addPullRequestReviewThreadReply(input: {pullRequestReviewThreadId: $thread, body: $body}) { comment { id url } } }'
	])
	return (JSON.parse(out) as { data: { addPullRequestReviewThreadReply: { comment: { id: string } } } }).data.addPullRequestReviewThreadReply
		.comment.id
}

export const resolveThread = (threadId: string) =>
	must([
		'api',
		'graphql',
		'-F',
		`thread=${threadId}`,
		'-f',
		'query=mutation($thread: ID!) { resolveReviewThread(input: {threadId: $thread}) { thread { isResolved } } }'
	])

/** Whether `commit` is in the history of `head`, asked of GitHub so no fetch is needed. */
export async function contains(ref: PrRef, head: string, commit: string) {
	const result = await gh(['api', `repos/${ref.owner}/${ref.name}/compare/${commit}...${head}`, '--jq', '.status'])
	return result.ok && (result.out === 'ahead' || result.out === 'identical')
}
