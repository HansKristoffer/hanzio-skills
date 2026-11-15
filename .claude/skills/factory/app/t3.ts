// Runs T3 Code's own `t3` command. The running server's binary is preferred over a `t3` on PATH,
// which can be an older launcher. FACTORY_T3 points at another binary, which is what the tests use.
//
// Observed on 0.1.9-nightly: `t3 thread show --json` prints { thread, messages }; `thread.status` is
// `running` while a turn works and `completed` or `interrupted` once it ended, and
// `thread.pendingRequestCount` counts questions waiting for a person. 0.1.10-nightly adds
// `pendingBackgroundTasks` (a list), `blockedOnThreadWait` and `snoozed`, and each message is
// { role, runId, text }.
import { Database } from 'bun:sqlite'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const ENDED = new Set(['completed', 'interrupted', 'failed', 'error', 'stopped'])

const t3Home = () => process.env.T3CODE_HOME || join(homedir(), '.t3')

export function t3Binary() {
	if (process.env.FACTORY_T3) return process.env.FACTORY_T3
	const home = t3Home()
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
	let proc: ReturnType<typeof Bun.spawn>
	try {
		proc = Bun.spawn([t3Binary(), ...args], {
			stdin: stdin === undefined ? 'ignore' : new Blob([stdin]),
			env: { ...process.env },
			stdout: 'pipe',
			stderr: 'pipe'
		})
	} catch (error) {
		return { ok: false, out: '', err: `T3 Code's t3 command could not run: ${(error as Error).message}` }
	}
	const [out, err, code] = await Promise.all([
		new Response(proc.stdout as ReadableStream).text(),
		new Response(proc.stderr as ReadableStream).text(),
		proc.exited
	])
	return { ok: code === 0, out: out.trim(), err: err.trim() }
}

/** Gives the thread a message as its next turn. A busy thread is not interrupted. */
export async function threadSend(threadId: string, message: string) {
	const result = await run(['thread', 'send', threadId, '-'], message)
	if (!result.ok) throw new Error(result.err || result.out || `t3 thread send ${threadId} failed`)
}

export type ThreadMessage = { role: string; text: string }

export type ThreadState = {
	status: string
	link?: string
	pendingRequests: number
	/** Background tasks the thread waits on, such as a build it started. */
	backgroundTasks: number
	/** The thread waits on another thread, such as a child it delegated to. */
	waitsOnThread: boolean
	/** Someone snoozed it in T3 Code. */
	snoozed: boolean
	/** The latest messages, oldest first, when `threadShow` was asked for them. */
	messages: ThreadMessage[]
}

export async function threadShow(threadId: string, messages = 0): Promise<ThreadState | null> {
	const result = await run(['thread', 'show', threadId, '--json', '--messages', String(messages)])
	if (!result.ok) return null
	try {
		const parsed = JSON.parse(result.out)
		const thread = parsed.thread
		const background = thread.pendingBackgroundTasks
		return {
			status: String(thread.status),
			link: thread.link,
			pendingRequests: Number(thread.pendingRequestCount ?? 0),
			backgroundTasks: Array.isArray(background) ? background.length : Number(background ?? 0) || 0,
			waitsOnThread: thread.blockedOnThreadWait === true,
			snoozed: thread.snoozed === true,
			messages: (Array.isArray(parsed.messages) ? parsed.messages : []).map((m: Record<string, unknown>) => ({
				role: String(m.role ?? ''),
				text: String(m.text ?? '')
			}))
		}
	} catch {
		return null
	}
}

export const isWorking = (state: ThreadState) => !ENDED.has(state.status)

/** The turn ended, but the thread still waits on something that will wake it: a nudge would only interrupt. */
export const isWaiting = (state: ThreadState) =>
	state.pendingRequests > 0 || state.backgroundTasks > 0 || state.waitsOnThread || state.snoozed

const squash = (text: string) => text.replace(/\s+/g, ' ').trim()

/** Whether a message the service sent shows among the thread's messages, matched on its start. */
export const showsMessage = (state: ThreadState, head: string) => {
	const start = squash(head).slice(0, 80)
	return state.messages.some((m) => m.role === 'user' && squash(m.text).startsWith(start))
}

export type T3Project = {
	id: string
	title: string
	root: string
	archived: boolean
	/** The project's own default model in T3 Code, as provider and model, when it has one. */
	defaultModel: { provider: string; model: string } | null
}

/**
 * The projects T3 Code has on this machine. The `t3` command has no `project list`, so this reads T3 Code's
 * own database, read-only. Observed on 0.1.10-nightly: `userdata/statev2.sqlite` (older versions:
 * `state.sqlite`) has `projection_projects` with `project_id`, `title`, `workspace_root`, `deleted_at`,
 * `archived_at` and `default_model_selection_json` ({ instanceId or provider, model }).
 */
export function projectList(): T3Project[] {
	const userdata = join(t3Home(), 'userdata')
	const file = ['statev2.sqlite', 'state.sqlite'].map((name) => join(userdata, name)).find((path) => existsSync(path))
	if (!file) throw new Error(`T3 Code keeps no projects here: no state database in ${userdata}`)
	let db: Database | undefined
	try {
		db = new Database(file, { readonly: true })
		const columns = new Set((db.query('pragma table_info(projection_projects)').all() as { name: string }[]).map((c) => c.name))
		if (!columns.has('project_id') || !columns.has('workspace_root')) throw new Error('it has no projection_projects table')
		const archived = columns.has('archived_at') ? 'archived_at' : 'null'
		const model = columns.has('default_model_selection_json') ? 'default_model_selection_json' : 'null'
		const rows = db
			.query(`select project_id, title, workspace_root, ${archived} as archived_at, ${model} as model from projection_projects where deleted_at is null order by lower(title)`)
			.all() as { project_id: string; title: string; workspace_root: string; archived_at: string | null; model: string | null }[]
		return rows.map((row) => ({
			id: row.project_id,
			title: row.title,
			root: row.workspace_root,
			archived: row.archived_at !== null,
			defaultModel: parseModel(row.model)
		}))
	} catch (error) {
		throw new Error(`cannot read T3 Code's projects from ${file}: ${(error as Error).message}`)
	} finally {
		db?.close()
	}
}

function parseModel(json: string | null) {
	if (!json) return null
	try {
		const parsed = JSON.parse(json) as Record<string, unknown>
		const provider = parsed.instanceId ?? parsed.providerInstanceId ?? parsed.provider
		return typeof provider === 'string' && typeof parsed.model === 'string' ? { provider, model: parsed.model } : null
	} catch {
		return null
	}
}

export type StartArgs = {
	/** A project id, or a path inside the project. */
	root: string
	title?: string
	message: string
	provider?: string
	model?: string
	/** The ref a new worktree starts from; without it the thread works in the project's folder. */
	worktree?: string
	branch?: string
}

/** Starts a thread, in a new worktree when given one, and returns its id and link. */
export async function threadStart(args: StartArgs) {
	const flags: string[] = []
	if (args.title) flags.push('--title', args.title)
	if (args.worktree) flags.push('--worktree', args.worktree, ...(args.branch ? ['--branch', args.branch] : []))
	flags.push('--json')
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
