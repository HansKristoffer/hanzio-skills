#!/usr/bin/env bun
// A stand-in for GitHub's `gh` in tests. It records each call (arguments and stdin) as a JSON line in
// FAKE_GH_LOG. Reads are answered from FAKE_GH_PR, a RawPr as `readPr` returns it (paged as `--paginate
// --slurp` pages them); anything else from FAKE_GH_REPLY: { <key>: { code?, out? } }.
import { appendFileSync, existsSync, readFileSync } from 'node:fs'

const args = process.argv.slice(2)
const stdin = args.includes('-') ? await Bun.stdin.text() : null
if (process.env.FAKE_GH_LOG) appendFileSync(process.env.FAKE_GH_LOG, `${JSON.stringify({ args, stdin })}\n`)

const read = (path?: string) => (path && existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null)
const pr = read(process.env.FAKE_GH_PR) as Record<string, any> | null
const replies = (read(process.env.FAKE_GH_REPLY) ?? {}) as Record<string, { code?: number; out?: unknown }>

const query = args.find((a) => a.startsWith('query=')) ?? ''
const key =
	args[0] === 'pr'
		? args[1]!
		: query.includes('addPullRequestReviewThreadReply')
			? 'reply'
			: query.includes('resolveReviewThread')
				? 'resolve'
				: query.includes('reviewThreads(')
					? 'threads'
					: query.includes('reviews(')
						? 'reviews'
						: query.includes('comments(')
							? 'comments'
							: args[1] === 'user'
								? 'user'
								: args.some((a) => a.includes('/rules/branches/'))
									? 'rules'
									: args.some((a) => a.includes('/actions/workflows'))
										? 'workflows'
									: args.some((a) => a.includes('/compare/'))
										? 'compare'
										: args.some((a) => a.endsWith('/requested_reviewers'))
											? 'rerequest'
											: args[0] === 'api' && /^repos\/[^/]+\/[^/]+$/.test(args[1] ?? '')
												? 'repo'
												: 'other'

function pages(nodes: unknown[], size: number, connection: string) {
	const out = []
	for (let i = 0; i === 0 || i < nodes.length; i += size) {
		out.push({ data: { repository: { pullRequest: { [connection]: { nodes: nodes.slice(i, i + size), pageInfo: {} } } } } })
	}
	return out
}

const fromPr: Record<string, () => unknown> = pr
	? {
			view: () => (args.includes('body') ? { body: pr.body ?? '' } : pr.view),
			checks: () => pr.required,
			rules: () => pr.rules,
			workflows: () => String(pr.workflows ?? 3),
			threads: () => pages(pr.threads, 50, 'reviewThreads'),
			reviews: () => pages(pr.reviews, 100, 'reviews'),
			comments: () => pages(pr.comments, 100, 'comments')
		}
	: {}
const defaults: Record<string, unknown> = {
	user: 'factory-user',
	// `--jq .private` of a public repository.
	repo: 'false',
	compare: 'ahead',
	reply: { data: { addPullRequestReviewThreadReply: { comment: { id: `PRRC_${Date.now()}`, url: 'https://github.com/acme/api/pull/1#r' } } } }
}

const reply = replies[key]
if (reply) {
	if (reply.out !== undefined) console.log(typeof reply.out === 'string' ? reply.out : JSON.stringify(reply.out))
	process.exit(reply.code ?? 0)
}
if (key === 'rules' && pr && pr.rules === null) {
	console.error('HTTP 403: Upgrade to GitHub Pro')
	process.exit(1)
}
const answer = fromPr[key]?.() ?? defaults[key]
if (answer !== undefined) console.log(typeof answer === 'string' ? answer : JSON.stringify(answer))
process.exit(0)
