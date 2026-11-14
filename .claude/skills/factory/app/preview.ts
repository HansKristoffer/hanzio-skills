// The dev environment a reviewer tries the change in. It runs in the thread's checkout and has to outlive
// the thread's session. buncargo's detached run does that by itself. Any other project's start command
// runs here as a unit of its own, so it lasts as long, and `preview down` can stop it.
import { chmodSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { factoryHome, factoryPort, hasSystemd, sh } from './env.ts'
import { parseRun, parseUrlLines, primaryFirst } from './evidence.ts'

/** buncargo puts the cause and the next command at the end of its output, in a block of up to 40 lines. */
const tail = (text: string, lines = 40) => text.trim().split('\n').slice(-lines).join('\n')

/** Whether anything listens at the address. Any answer counts, a 404 or a self-signed certificate included. */
export async function answers(url: string, ms = 2500) {
	try {
		await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(ms), tls: { rejectUnauthorized: false } })
		return true
	} catch {
		return false
	}
}

// ---- buncargo ----

/** FACTORY_BUNCARGO points at another binary, which is what the tests use. */
const buncargo = () => (process.env.FACTORY_BUNCARGO ? [process.env.FACTORY_BUNCARGO] : ['bunx', 'buncargo'])

export const usesBuncargo = (top: string) => existsSync(join(top, 'dev.config.ts'))

/** Starts this checkout's buncargo run in the background and returns its URLs, as the reader's machine
 * reaches them, the primary app first, and when buncargo stops the run for idling. */
export function buncargoUp(top: string, apps?: string) {
	const started = sh([...buncargo(), 'dev', '--detach', ...(apps ? [`--apps=${apps}`] : [])], { cwd: top })
	const listed = sh([...buncargo(), 'url'], { cwd: top })
	const run = listed.ok ? parseRun(sh([...buncargo(), 'status', '--json'], { cwd: top }).out) : {}
	const urls = listed.ok ? primaryFirst(parseUrlLines(listed.out), run.primary) : []
	const output = tail(`${started.out}\n${started.err}`)
	return {
		urls,
		ok: started.ok,
		output: started.ok ? '' : output || tail(listed.err),
		stopsAt: run.idleMs ? Date.now() + run.idleMs : null
	}
}

export function buncargoDown(top: string) {
	const stopped = sh([...buncargo(), 'stop', '--all'], { cwd: top })
	return { ok: stopped.ok, output: stopped.ok ? '' : tail(`${stopped.out}\n${stopped.err}`) }
}

// ---- a project's own start command ----

/** What `preview up -- <command>` started for an issue: a systemd unit, or a process group where there is no
 * user systemd (macOS, some containers). */
export type Own = { unit?: string; pid?: number; log: string; command: string[] }

/** Variables a shell keeps read-only: assigning one would end the shell that starts the command. */
const SHELL_OWNED = new Set(['UID', 'EUID', 'PPID', 'BASHOPTS', 'SHELLOPTS'])

const slug = (issue: string) => issue.replace(/[^a-zA-Z0-9]+/g, '-').slice(0, 60)
const ownDir = () => join(factoryHome(), 'preview')
const ownFile = (issue: string) => join(ownDir(), `${slug(issue)}.json`)
const ownEnvFile = (issue: string) => join(ownDir(), `${slug(issue)}.env`)

export function ownRead(issue: string): Own | null {
	try {
		return JSON.parse(readFileSync(ownFile(issue), 'utf8')) as Own
	} catch {
		return null
	}
}

export function ownAlive(own: Own) {
	if (own.unit) return sh(['systemctl', '--user', 'is-active', '--quiet', own.unit]).ok
	try {
		process.kill(own.pid!, 0)
		return true
	} catch {
		return false
	}
}

export const ownLog = (own: Own) => (existsSync(own.log) ? tail(readFileSync(own.log, 'utf8')) : '')

/**
 * Runs the command in the checkout with this process's environment, outside the thread's session: a process
 * started from a thread dies with the thread's systemd scope. An earlier start for the issue is stopped first.
 */
export function ownStart(issue: string, top: string, command: string[]): Own {
	ownStop(issue)
	mkdirSync(ownDir(), { recursive: true })
	const log = join(ownDir(), `${slug(issue)}.log`)
	writeFileSync(log, '')
	let own: Own
	if (hasSystemd()) {
		const unit = `factory-${factoryPort()}-preview-${slug(issue)}`
		// The environment goes through a file only this user reads, never the unit's command line, which
		// every user of the machine can list.
		const envFile = ownEnvFile(issue)
		const exports = Object.entries(process.env)
			.filter(([key, value]) => value !== undefined && /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && !SHELL_OWNED.has(key))
			.map(([key, value]) => `export ${key}='${value!.replaceAll("'", "'\\''")}'`)
		writeFileSync(envFile, `${exports.join('\n')}\n`, { mode: 0o600 })
		chmodSync(envFile, 0o600)
		const started = sh([
			'systemd-run',
			'--user',
			'--quiet',
			'--collect',
			`--unit=${unit}`,
			`--working-directory=${top}`,
			`--property=StandardOutput=append:${log}`,
			`--property=StandardError=append:${log}`,
			'--',
			'/bin/sh',
			'-c',
			'. "$0"; exec "$@"',
			envFile,
			...command
		])
		if (!started.ok) throw new Error(`systemd-run could not start the command: ${started.err}`)
		own = { unit, log, command }
	} else {
		const out = openSync(log, 'a')
		const child = Bun.spawn(command, { cwd: top, env: { ...process.env }, stdio: ['ignore', out, out], detached: true })
		child.unref()
		own = { pid: child.pid, log, command }
	}
	writeFileSync(ownFile(issue), JSON.stringify(own))
	return own
}

/** Stops what `ownStart` started for the issue. Null when it started nothing. */
export function ownStop(issue: string) {
	const own = ownRead(issue)
	if (!own) return null
	let output = ''
	if (own.unit) {
		const stopped = sh(['systemctl', '--user', 'stop', own.unit])
		if (!stopped.ok && ownAlive(own)) output = stopped.err
	} else if (ownAlive(own)) {
		const signal = (name: NodeJS.Signals) => {
			try {
				// The process leads a group of its own, so its children go with it.
				process.kill(-own.pid!, name)
			} catch {
				// Already gone.
			}
		}
		signal('SIGTERM')
		const until = Date.now() + 5000
		while (ownAlive(own) && Date.now() < until) Bun.sleepSync(100)
		if (ownAlive(own)) signal('SIGKILL')
	}
	rmSync(ownFile(issue), { force: true })
	rmSync(ownEnvFile(issue), { force: true })
	return { ok: !output, output }
}
