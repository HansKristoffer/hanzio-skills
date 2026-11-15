#!/usr/bin/env bun
// A stand-in for T3 Code's `t3` command in tests. It records each call (arguments and stdin) as a
// JSON line in FAKE_T3_LOG, and answers from FAKE_T3_REPLY: { send, start, show, showByThread }. Like T3 Code,
// a `show` lists the messages sent to that thread, unless `stuckQueue` names it.
import { appendFileSync, existsSync, readFileSync } from 'node:fs'

type Reply = { code?: number; out?: string }

const args = process.argv.slice(2)
const stdin = args.includes('-') ? await Bun.stdin.text() : null
if (process.env.FAKE_T3_LOG) appendFileSync(process.env.FAKE_T3_LOG, `${JSON.stringify({ args, stdin })}\n`)

const path = process.env.FAKE_T3_REPLY ?? ''
const replies: Record<string, unknown> = path && existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {}
const sub = args[1] ?? ''
const byThread = (replies.showByThread ?? {}) as Record<string, Reply>
const fallback: Record<string, Reply> = {
	send: { code: 0, out: 'sent' },
	show: { code: 1, out: '' },
	start: { code: 0, out: JSON.stringify({ threadId: 'thread-new-1', link: 'https://app.t3.codes/threads/env/thread-new-1' }) }
}
const reply = (sub === 'show' && args[2] && byThread[args[2]]) || (replies[sub] as Reply | undefined) || fallback[sub] || { code: 0 }
const stuck = (replies.stuckQueue ?? []) as string[]
if (sub === 'show' && reply.out && args[2] && !stuck.includes(args[2]) && process.env.FAKE_T3_LOG) {
	const sent = readFileSync(process.env.FAKE_T3_LOG, 'utf8')
		.split('\n')
		.filter(Boolean)
		.map((line) => JSON.parse(line) as { args: string[]; stdin: string | null })
		.filter((call) => call.args[1] === 'send' && call.args[2] === args[2])
		.map((call) => ({ role: 'user', runId: 'run', text: call.stdin ?? '' }))
	const shown = JSON.parse(reply.out)
	console.log(JSON.stringify({ ...shown, messages: [...(shown.messages ?? []), ...sent] }))
} else if (reply.out) console.log(reply.out)
process.exit(reply.code ?? 0)
