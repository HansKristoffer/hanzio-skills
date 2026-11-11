// Runs T3 Code's own `t3` command. The running server's binary is preferred over a `t3` on PATH,
// which can be an older launcher. FACTORY_T3 points at another binary, which is what the tests use.
//
// Observed on 0.1.9-nightly: `t3 thread show --json` prints { thread, messages }; `thread.status` is
// `running` while a turn works and `completed` or `interrupted` once it ended, and
// `thread.pendingRequestCount` counts questions waiting for a person.
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const ENDED = new Set(['completed', 'interrupted', 'failed', 'error', 'stopped'])

export function t3Binary() {
	if (process.env.FACTORY_T3) return process.env.FACTORY_T3
	const home = process.env.T3CODE_HOME || join(homedir(), '.t3')
	try {
		const state = JSON.parse(readFileSync(join(home, 'runtime', 'service-state.json'), 'utf8'))
		const binary = join(home, 'runtime', 'versions', String(state.activeVersion), 't3')
		if (state.activeVersion && existsSync(binary)) return binary
	} catch {
		// No service state: fall back to PATH.
	}
	return 't3'
}

async function run(args: string[], stdin?: string) {
	const proc = Bun.spawn([t3Binary(), ...args], {
		stdin: stdin === undefined ? 'ignore' : new Blob([stdin]),
		env: { ...process.env },
		stdout: 'pipe',
		stderr: 'pipe'
	})
	const [out, err, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited
	])
	return { ok: code === 0, out: out.trim(), err: err.trim() }
}

/** Gives the thread a message as its next turn. A busy thread is not interrupted. */
export async function threadSend(threadId: string, message: string) {
	const result = await run(['thread', 'send', threadId, '-'], message)
	if (!result.ok) throw new Error(result.err || result.out || `t3 thread send ${threadId} failed`)
}

export type ThreadState = { status: string; link?: string; pendingRequests: number }

export async function threadShow(threadId: string): Promise<ThreadState | null> {
	const result = await run(['thread', 'show', threadId, '--json', '--messages', '0'])
	if (!result.ok) return null
	try {
		const thread = JSON.parse(result.out).thread
		return { status: String(thread.status), link: thread.link, pendingRequests: Number(thread.pendingRequestCount ?? 0) }
	} catch {
		return null
	}
}

export const isWorking = (state: ThreadState) => !ENDED.has(state.status)

export type StartArgs = {
	root: string
	title: string
	message: string
	provider?: string
	model?: string
	worktree: string
	branch: string
}

/** Starts a thread in a new worktree and returns its id and link. */
export async function threadStart(args: StartArgs) {
	const flags = ['--title', args.title, '--worktree', args.worktree, '--branch', args.branch, '--json']
	if (args.provider && args.model) flags.push('--provider', args.provider, '--model', args.model)
	const result = await run(['thread', 'start', args.root, '-', ...flags], args.message)
	if (!result.ok) throw new Error(result.err || result.out || 't3 thread start failed')
	return parseStarted(result.out)
}

/** `t3 thread start --json` output is not documented; accept the shapes `thread show` uses, or a bare id. */
export function parseStarted(out: string): { threadId: string; link?: string } {
	try {
		const parsed = JSON.parse(out)
		const thread = parsed.thread ?? parsed
		const threadId = thread.threadId ?? thread.id
		if (typeof threadId === 'string') return { threadId, link: thread.link }
	} catch {
		// Not JSON: a bare id.
	}
	const id = out.split(/\s+/).find((word) => /^[0-9a-f-]{8,}$/i.test(word))
	if (!id) throw new Error(`t3 thread start printed no thread id: ${out.slice(0, 200)}`)
	return { threadId: id }
}
