#!/usr/bin/env bun
// The only thing agents run. Every command talks to the machine's factory service over loopback
// HTTP, starting it first when it is not answering, and prints JSON. Usage: `bun cli.ts help`.
import { existsSync, mkdirSync, openSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs, type ParseArgsOptionsConfig } from 'node:util'
import { APP_DIR, DEFAULT_PORT, appVersion, factoryHome, factoryPort, sh } from './env.ts'
import { detectTailnet, startServer } from './server.ts'
import { UNIT, install, uninstall, unitInstalled } from './service.ts'

const HELP = `factory: report to the machine's factory service. Every command prints JSON.

Issue commands (inside a T3 Code thread; the thread is the issue):
  start --title <t> [--body-file <path>] [--source <id>]
  status
  run --stage research|plan|implement|review|land [--on plan|pr] [--context-file <path>]
  report [--run <id>] [--done | --failed] <text | ->      - reads the text from stdin
  update [--kind bug|feature] [--title <t>] [--pr <url>]
  ask --kind plan|question|blocked|merge --question <q> --recommend <text>
      [--provisional] [--body-file <path>] [--option <label>]...
  answer <decision> <text>
  close --outcome shipped|not-a-bug|duplicate|already-fixed|dropped [--deploy verified|unverified|none]
        [--report-file <path>] <summary>

Anywhere:
  settings                       the settings an issue started here would get
  new --title <t> [--body-file <path>] [--source <id>] [--again]
  drop <issue> [<reason | ->]   close an open issue as dropped, from outside its thread
  board
  history [--days <n>]
  serve                          run the server in the foreground
  service install|uninstall      keep the server up across reboots`

const ISSUE_COMMANDS = new Set(['start', 'status', 'run', 'update', 'ask', 'answer', 'close'])

class UsageError extends Error {}

const port = factoryPort()
const base = `http://127.0.0.1:${port}`
const threadId = process.env.T3CODE_THREAD_ID

async function call(method: string, path: string, body?: unknown) {
	const res = await fetch(base + path, {
		method,
		headers: { 'content-type': 'application/json', ...(threadId && { 'x-factory-thread': threadId }) },
		...(body !== undefined && { body: JSON.stringify(body) })
	})
	const json = (await res.json().catch(() => ({ error: `HTTP ${res.status}` }))) as Record<string, unknown>
	if (!res.ok) throw new Error(String(json.error ?? `HTTP ${res.status}`))
	return json
}

async function health() {
	try {
		const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(1000) })
		return res.ok ? ((await res.json()) as { version: string; appDir?: string }) : null
	} catch {
		return null
	}
}

async function waitFor(check: () => Promise<boolean>, ms: number) {
	const until = Date.now() + ms
	while (Date.now() < until) {
		if (await check()) return true
		await Bun.sleep(100)
	}
	return false
}

const usesUnit = () => port === DEFAULT_PORT && !process.env.FACTORY_HOME && unitInstalled()
const hasSystemd = () =>
	process.platform === 'linux' &&
	sh(['systemctl', '--user', 'show-environment']).ok
const transientUnit = () => `factory-${port}`

function serverEnv() {
	const env: Record<string, string> = { FACTORY_HOME: factoryHome(), FACTORY_PORT: String(port) }
	for (const key of ['FACTORY_VERSION', 'FACTORY_T3', 'T3CODE_HOME', 'PATH', 'HOME']) {
		const value = process.env[key]
		if (value) env[key] = value
	}
	return env
}

const serveCommand = () => [process.execPath, join(APP_DIR, 'cli.ts'), 'serve']

const logPath = () => join(factoryHome(), 'server.log')

/** A process spawned from a thread dies with the thread's systemd scope, so on Linux the server is a unit of its own. */
function startUnit() {
	const log = logPath()
	if (usesUnit()) {
		sh(['systemctl', '--user', 'start', UNIT])
		return UNIT
	}
	if (hasSystemd()) {
		const setenv = Object.entries(serverEnv()).map(([key, value]) => `--setenv=${key}=${value}`)
		const started = sh(
			[
				'systemd-run',
				'--user',
				'--quiet',
				'--collect',
				`--unit=${transientUnit()}`,
				`--property=StandardOutput=append:${log}`,
				`--property=StandardError=append:${log}`,
				...setenv,
				...serveCommand()
			]
		)
		if (!started.ok) throw new Error(`systemd-run failed: ${started.err}`)
		return transientUnit()
	}
	return null
}

function spawnDetached() {
	const out = openSync(logPath(), 'a')
	const child = Bun.spawn(serveCommand(), {
		env: { ...process.env, ...serverEnv() },
		stdio: ['ignore', out, out],
		detached: true
	})
	child.unref()
}

/** Starts the server when it is not answering, and replaces one that runs other code. */
async function ensureServer() {
	const version = appVersion()
	const running = await health()
	if (running?.version === version) return
	if (running?.appDir && running.appDir !== APP_DIR) {
		// Another checkout of the skill (a development copy, a thread's worktree of hanzio-skills) never
		// replaces the machine's server: it uses it, and says so.
		console.error(
			`factory: the server on port ${port} runs version ${running.version} from ${running.appDir}; this CLI is version ${version} from ${APP_DIR}. Using the running server.`
		)
		return
	}
	if (running) {
		await call('POST', '/api/shutdown', {}).catch(() => {})
		await waitFor(async () => (await health())?.version !== running.version, 5000)
		if (usesUnit()) {
			// Restart=always brings it back on the code now on disk.
			if (await waitFor(async () => (await health())?.version === version, 15_000)) return
			throw new Error(`the factory unit restarted on another version; run: systemctl --user restart ${UNIT}`)
		}
	}
	if (!(await health())) {
		// systemd opens the log before the server runs, so its folder must exist on the first start.
		mkdirSync(factoryHome(), { recursive: true })
		const unit = startUnit()
		const up = async () => (await health())?.version === version
		if (unit && !(await waitFor(up, 5000))) {
			// A user manager that cannot run the unit (some containers and CI runners): run it as a plain
			// background process, which lasts until this thread's session ends, and say why.
			const status = sh(['systemctl', '--user', 'status', unit, '--no-pager', '-n', '5'])
			console.error(
				`factory: systemd could not start ${unit}, so the server runs as a background process of this session.\n${status.out}\n${logTail()}`
			)
			spawnDetached()
		} else if (!unit) spawnDetached()
	}
	const ok = await waitFor(async () => (await health())?.version === version, 8000)
	if (!ok) {
		const now = await health()
		throw new Error(
			now
				? `the server on port ${port} runs version ${now.version}, not ${version}`
				: `the factory server did not start.\n${logTail()}`
		)
	}
}

function logTail() {
	if (!existsSync(logPath())) return `${logPath()} does not exist`
	const lines = readFileSync(logPath(), 'utf8').trimEnd().split('\n').slice(-10)
	return `Last lines of ${logPath()}:\n${lines.join('\n')}`
}

function readFile(path: string | undefined, flag: string) {
	if (!path) return undefined
	if (!existsSync(path)) throw new UsageError(`${flag}: ${path} does not exist`)
	return readFileSync(path, 'utf8')
}

function args<const T extends ParseArgsOptionsConfig>(argv: string[], options: T) {
	try {
		return parseArgs({ args: argv, options, allowPositionals: true, strict: true })
	} catch (error) {
		throw new UsageError((error as Error).message)
	}
}

const str = (value: unknown) => (typeof value === 'string' ? value : undefined)

/** The text an agent passes: `-` reads it from stdin, so backticks and `$(...)` reach the service unchanged
 * instead of being run by the shell. People can still type it as words. */
async function textOf(positionals: string[]) {
	if (positionals.length === 1 && positionals[0] === '-') return (await Bun.stdin.text()).trimEnd()
	return positionals.join(' ')
}

async function main(argv: string[]) {
	const [command, ...rest] = argv
	if (!command || command === 'help' || command === '--help') {
		console.log(HELP)
		return
	}
	if (command === 'serve') {
		const server = startServer({
			home: factoryHome(),
			port,
			tailnet: detectTailnet(),
			retryTailnet: true,
			onShutdown: () => process.exit(0)
		})
		const stop = () => {
			server.stop()
			process.exit(0)
		}
		process.on('SIGTERM', stop)
		process.on('SIGINT', stop)
		console.log(`factory ${server.version} listening on 127.0.0.1:${port}`)
		return
	}
	if (command === 'service') {
		const action = rest[0]
		if (action === 'install') {
			const log = join(factoryHome(), 'server.log')
			mkdirSync(factoryHome(), { recursive: true })
			const result = install(serveCommand(), serverEnv(), log, transientUnit())
			await waitFor(async () => !!(await health()), 8000)
			print({ ...result, health: await health() })
			return
		}
		if (action === 'uninstall') return print(uninstall())
		throw new UsageError('service: install or uninstall')
	}

	if (ISSUE_COMMANDS.has(command) && !threadId) {
		throw new UsageError('run this inside a T3 Code thread: T3CODE_THREAD_ID is not set')
	}
	if (command === 'report') {
		const { values, positionals } = args(rest, { run: { type: 'string' }, done: { type: 'boolean' }, failed: { type: 'boolean' } })
		const message = await textOf(positionals)
		if (!message) throw new UsageError('report: give the text to report, or - to read it from stdin')
		if ((values.done || values.failed) && !values.run) throw new UsageError('--done and --failed need --run')
		if (!threadId) throw new UsageError('run this inside a T3 Code thread: T3CODE_THREAD_ID is not set')
		await ensureServer()
		const body = { text: message, done: values.done, failed: values.failed }
		return print(
			values.run
				? await call('POST', `/api/runs/${encodeURIComponent(str(values.run)!)}/report`, body)
				: await call('POST', '/api/issue/report', body)
		)
	}

	switch (command) {
		case 'start': {
			const { values } = args(rest, { title: { type: 'string' }, 'body-file': { type: 'string' }, source: { type: 'string' } })
			const body = readFile(str(values['body-file']), '--body-file')
			await ensureServer()
			return print(await call('POST', '/api/issue/start', { cwd: process.cwd(), title: values.title, body, source: values.source }))
		}
		case 'status':
			await ensureServer()
			return print(await call('POST', '/api/issue/status', {}))
		case 'settings':
			await ensureServer()
			return print(await call('POST', '/api/settings/resolve', { cwd: process.cwd() }))
		case 'run': {
			const { values } = args(rest, { stage: { type: 'string' }, on: { type: 'string' }, 'context-file': { type: 'string' } })
			if (!values.stage) throw new UsageError('run: --stage is required')
			const context = readFile(str(values['context-file']), '--context-file')
			await ensureServer()
			return print(await call('POST', '/api/issue/run', { stage: values.stage, on: values.on, context }))
		}
		case 'update': {
			const { values } = args(rest, { kind: { type: 'string' }, title: { type: 'string' }, pr: { type: 'string' } })
			await ensureServer()
			return print(await call('POST', '/api/issue/update', values))
		}
		case 'ask': {
			const { values } = args(rest, {
				kind: { type: 'string' },
				question: { type: 'string' },
				recommend: { type: 'string' },
				provisional: { type: 'boolean' },
				'body-file': { type: 'string' },
				option: { type: 'string', multiple: true }
			})
			const body = readFile(str(values['body-file']), '--body-file')
			await ensureServer()
			return print(
				await call('POST', '/api/issue/ask', {
					kind: values.kind,
					question: values.question,
					recommend: values.recommend,
					provisional: values.provisional,
					body,
					options: values.option ?? []
				})
			)
		}
		case 'answer': {
			const { positionals } = args(rest, {})
			const [decision, ...words] = positionals
			const answer = await textOf(words)
			if (!decision || !answer) throw new UsageError('answer: give the decision id and the answer')
			await ensureServer()
			return print(await call('POST', '/api/issue/answer', { decision, text: answer }))
		}
		case 'close': {
			const { values, positionals } = args(rest, {
				outcome: { type: 'string' },
				deploy: { type: 'string' },
				'report-file': { type: 'string' }
			})
			const report = readFile(str(values['report-file']), '--report-file')
			await ensureServer()
			return print(
				await call('POST', '/api/issue/close', {
					outcome: values.outcome,
					deploy: values.deploy,
					report,
					summary: await textOf(positionals)
				})
			)
		}
		case 'new': {
			const { values } = args(rest, {
				title: { type: 'string' },
				'body-file': { type: 'string' },
				source: { type: 'string' },
				again: { type: 'boolean' }
			})
			const body = readFile(str(values['body-file']), '--body-file')
			await ensureServer()
			return print(
				await call('POST', '/api/threads', {
					cwd: process.cwd(),
					title: values.title,
					body,
					source: values.source,
					again: values.again
				})
			)
		}
		case 'drop': {
			const { positionals } = args(rest, {})
			const [issue, ...words] = positionals
			if (!issue) throw new UsageError('drop: give the issue id, as factory board lists it')
			const reason = await textOf(words)
			await ensureServer()
			return print(await call('POST', `/api/issues/${encodeURIComponent(issue)}/drop`, { reason: reason || undefined }))
		}
		case 'board': {
			await ensureServer()
			const board = await call('GET', '/api/board')
			const issues = (board.issues as Record<string, unknown>[]).map(({ id, title, repo, stage, source, needsYou, threadLink }) => ({
				id,
				title,
				repo,
				stage,
				source,
				needsYou,
				threadLink
			}))
			return print({ open: board.open, needsYou: board.needsYou, issues })
		}
		case 'history': {
			const { values } = args(rest, { days: { type: 'string' } })
			await ensureServer()
			return print(await call('GET', `/api/history?days=${encodeURIComponent(str(values.days) ?? '7')}`))
		}
		default:
			throw new UsageError(`unknown command ${command}; run: bun ${join(APP_DIR, 'cli.ts')} help`)
	}
}

function print(value: unknown) {
	console.log(JSON.stringify(value, null, 2))
}

main(process.argv.slice(2)).catch((error) => {
	console.error(`factory: ${(error as Error).message}`)
	process.exit(1)
})
