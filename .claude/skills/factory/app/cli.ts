#!/usr/bin/env bun
// The only thing agents run. Every command talks to the machine's factory service over loopback
// HTTP, starting it first when it is not answering, and prints JSON. Usage: `bun cli.ts help`.
import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs, type ParseArgsOptionsConfig } from 'node:util'
import { APP_DIR, DEFAULT_PORT, appVersion, factoryHome, factoryPort, sh } from './env.ts'
import { parseUrlFlags, repoWebBase } from './evidence.ts'
import * as gh from './gh.ts'
import { buncargoDown, buncargoUp, prepare, pushEvidence, usesBuncargo } from './media.ts'
import { withSections } from './pr.ts'
import { detectTailnet, startServer } from './server.ts'
import { UNIT, install, uninstall, unitInstalled } from './service.ts'

const HELP = `factory: report to the machine's factory service. Every command prints JSON.

Issue commands (inside a T3 Code thread; the thread is the issue):
  start --title <t> [--body-file <path>] [--source <id>]
  status
  run --stage research|plan|implement|review|land [--on plan|pr] [--context-file <path>] [--head <sha>] [--fallback]
      Prints the run, its target, and the task to hand the child, which names the file the brief is in.
      The service adds what the stage needs from stored results; a review takes no --context-file.
      --fallback runs the stage on the fallback target its settings name, after its own provider refused.
  report [--run <id>] [--done [--result-file <path>] | --failed] <text | ->
      - reads the text from stdin. A stage's --done needs its result, checked against the brief's shape.
  finding <id> --fixed <commit> | --declined - | --filed <url>
  update [--kind bug|feature] [--title <t>] [--pr <url>] [--merge ask|never]
  ask --kind plan|question|blocked|merge --question <q> --recommend <text>
      [--provisional] [--body-file <path>] [--option <label>]... [--head <sha>] [--round]
      A merge decision needs --head and has the options Merge and Do not merge. --round asks about
      going on past the review round budget.
  answer <decision> <text | ->
  close --outcome shipped|not-a-bug|duplicate|already-fixed|dropped [--deploy verified|unverified|none]
        [--report-file <path>] <summary | ->

The review on GitHub (gh runs here, as this thread's login):
  pr sync                        read the PR, store it, print what needs action and the gate
  pr ready [--request]           mark it ready with the reviewer notes; --request asks settings.reviewers
  pr reply <item> --fixed <commit> [-] | --declined - | --answered -
  pr ignore <item> [<reason | ->]
  pr round -                     post the round's summary, ask again who requested changes, close the round
  gate                           sync, then print the merge gate
  risk --head <sha> --none | --rule <text>
  wait --on checks|bots|review|merge|deploy [--note <text>] | wait --clear

What the reviewer looks at (git, ffmpeg and buncargo run here, in this checkout):
  evidence add <file> --title <t> [--label before|after] [<note> | -]
      A screenshot (png, jpg, webp, gif) or a video (mp4, webm, mov) of the change, shown on the issue's
      page. Two captures under one title, labelled before and after, show side by side. The same title
      and label again replaces the capture.
  evidence list | evidence remove <id>
  evidence publish [--to <issue or PR url>]
      Push the captures to a ref on GitHub and show them in the PR's body; --to also posts them as one
      comment there. pr ready publishes too.
  preview up [--apps <a,b>] [--url <name>=<url>]...
      Start this checkout's dev environment (buncargo's detached run) and put its URLs on the page.
      With --url nothing is started: the URLs of an app you started yourself are registered.
  preview down                   stop it
  preview failed <reason | ->    say on the page why it did not start

Anywhere:
  settings                       the settings an issue started here would get
  new --title <t> [--body-file <path>] [--source <id>] [--merge ask|never] [--again]
  drop <issue> [<reason | ->]   close an open issue as dropped, from outside its thread
  board
  history [--days <n>]
  serve                          run the server in the foreground
  service install|uninstall      keep the server up across reboots`

const ISSUE_COMMANDS = new Set(['start', 'status', 'run', 'update', 'ask', 'answer', 'close', 'finding', 'pr', 'gate', 'risk', 'wait', 'evidence', 'preview'])

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
	for (const key of ['FACTORY_VERSION', 'FACTORY_T3', 'FACTORY_GH', 'T3CODE_HOME', 'PATH', 'HOME']) {
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
		const { values, positionals } = args(rest, {
			run: { type: 'string' },
			done: { type: 'boolean' },
			failed: { type: 'boolean' },
			'result-file': { type: 'string' }
		})
		const message = await textOf(positionals)
		if (!message) throw new UsageError('report: give the text to report, or - to read it from stdin')
		if ((values.done || values.failed) && !values.run) throw new UsageError('--done and --failed need --run')
		if (values['result-file'] && !values.done) throw new UsageError('--result-file goes with --done')
		if (!threadId) throw new UsageError('run this inside a T3 Code thread: T3CODE_THREAD_ID is not set')
		const raw = readFile(str(values['result-file']), '--result-file')
		let result: unknown
		if (raw !== undefined) {
			try {
				result = JSON.parse(raw)
			} catch (error) {
				throw new UsageError(`--result-file: ${values['result-file']} is not JSON: ${(error as Error).message}`)
			}
		}
		await ensureServer()
		const body = { text: message, done: values.done, failed: values.failed, result }
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
			const { values } = args(rest, {
				stage: { type: 'string' },
				on: { type: 'string' },
				'context-file': { type: 'string' },
				head: { type: 'string' },
				fallback: { type: 'boolean' }
			})
			if (!values.stage) throw new UsageError('run: --stage is required')
			const context = readFile(str(values['context-file']), '--context-file')
			// A review of the PR reviews the commit this worktree is on, unless told another.
			const reviewed = values.head ?? (values.stage === 'review' && values.on !== 'plan' ? head() : undefined)
			await ensureServer()
			return print(withBriefFile(await call('POST', '/api/issue/run', { stage: values.stage, on: values.on, context, head: reviewed, fallback: values.fallback })))
		}
		case 'update': {
			const { values } = args(rest, { kind: { type: 'string' }, title: { type: 'string' }, pr: { type: 'string' }, merge: { type: 'string' } })
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
				option: { type: 'string', multiple: true },
				head: { type: 'string' },
				round: { type: 'boolean' }
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
					options: values.option ?? [],
					head: values.head,
					round: values.round
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
				merge: { type: 'string' },
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
					merge: values.merge,
					again: values.again
				})
			)
		}
		case 'pr':
			await ensureServer()
			return print(await prCommand(rest))
		case 'evidence':
			await ensureServer()
			return print(await evidenceCommand(rest))
		case 'preview':
			await ensureServer()
			return print(await previewCommand(rest))
		case 'gate': {
			await ensureServer()
			return print((await sync()).gate)
		}
		case 'risk': {
			const { values } = args(rest, { head: { type: 'string' }, none: { type: 'boolean' }, rule: { type: 'string' } })
			await ensureServer()
			return print(await call('POST', '/api/issue/risk', values))
		}
		case 'wait': {
			const { values } = args(rest, { on: { type: 'string' }, note: { type: 'string' }, clear: { type: 'boolean' } })
			await ensureServer()
			return print(await call('POST', '/api/issue/wait', values))
		}
		case 'finding': {
			const { values, positionals } = args(rest, { fixed: { type: 'string' }, declined: { type: 'boolean' }, filed: { type: 'string' } })
			const [id, ...words] = positionals
			const outcome = values.fixed ? 'fixed' : values.declined ? 'declined' : values.filed ? 'filed' : undefined
			if (!id || !outcome) throw new UsageError('finding: give the id and one of --fixed <commit>, --declined - (reason on stdin), --filed <url>')
			const note = values.fixed ?? values.filed ?? (await textOf(words))
			await ensureServer()
			return print(await call('POST', '/api/issue/finding', { id, outcome, note }))
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

/** Reads the PR as this thread's login and hands it to the service, which answers with the sync result. */
async function sync() {
	const status = await call('POST', '/api/issue/status', {})
	const url = (status.issue as { prUrl?: string }).prUrl
	if (!url) throw new UsageError('this issue has no PR yet: run factory update --pr <url>')
	return call('POST', '/api/issue/pr/snapshot', { raw: await gh.readPr(url) })
}

async function prCommand(argv: string[]) {
	const [action, ...rest] = argv
	if (action === 'sync') return sync()
	if (action === 'ready') {
		const { values } = args(rest, { request: { type: 'boolean' } })
		if (values.request) {
			await sync()
			const plan = await call('POST', '/api/issue/pr/plan', { action: 'request' })
			const reviewers = plan.reviewers as string[]
			if (reviewers.length) await gh.addReviewers(String(plan.url), reviewers)
			return call('POST', '/api/issue/pr/written', { action: 'requested', reviewers })
		}
		// The captures go up first, so the body that goes ready already shows them.
		const evidence = await publishEvidence()
		const plan = await call('POST', '/api/issue/pr/plan', { action: 'ready' })
		const url = String(plan.url)
		await gh.markReady(url)
		await gh.setBody(url, withSections(await gh.prBody(url), String(plan.sections)))
		await call('POST', '/api/issue/pr/written', { action: 'ready' })
		return { ...(await sync()), evidence }
	}
	if (action === 'reply') {
		const { values, positionals } = args(rest, { fixed: { type: 'string' }, declined: { type: 'boolean' }, answered: { type: 'boolean' } })
		const [item, ...words] = positionals
		const outcome = values.fixed ? 'fixed' : values.declined ? 'declined' : values.answered ? 'answered' : undefined
		if (!item || !outcome) throw new UsageError('pr reply: give the item and one of --fixed <commit>, --declined -, --answered -')
		const text = words.length ? await textOf(words) : undefined
		if (outcome !== 'fixed' && !text) throw new UsageError(`pr reply --${outcome}: give the reply on stdin with -`)
		const plan = await call('POST', '/api/issue/pr/plan', { action: 'reply', item, outcome, commit: values.fixed, text, login: await gh.login() })
		const url = String(plan.url)
		if (plan.commit && !(await gh.contains(gh.parsePrUrl(url), String(plan.head), String(plan.commit)))) {
			throw new UsageError(`pr reply --fixed: ${plan.commit} is not in the PR's head ${String(plan.head).slice(0, 7)}; push it first`)
		}
		const ids: string[] = []
		if (plan.thread) ids.push(await gh.replyInThread(String(plan.thread), String(plan.body)))
		else await gh.comment(url, String(plan.body))
		if (plan.resolve) await gh.resolveThread(String(plan.thread))
		return call('POST', '/api/issue/pr/written', {
			action: 'reply',
			item,
			outcome,
			commit: plan.commit ?? undefined,
			note: text?.slice(0, 2000),
			resolved: plan.resolve,
			ids
		})
	}
	if (action === 'ignore') {
		const { positionals } = args(rest, {})
		const [item, ...words] = positionals
		if (!item) throw new UsageError('pr ignore: give the item id')
		return call('POST', '/api/issue/pr/written', { action: 'ignore', item, note: (await textOf(words)) || undefined })
	}
	if (action === 'round') {
		const { positionals } = args(rest, {})
		const text = await textOf(positionals)
		if (!text) throw new UsageError("pr round: give the round's summary on stdin with -")
		const plan = await call('POST', '/api/issue/pr/plan', { action: 'round', text, login: await gh.login() })
		const url = String(plan.url)
		await gh.comment(url, String(plan.body))
		const again = plan.rerequest as string[]
		for (const reviewer of again) await gh.requestAgain(gh.parsePrUrl(url), reviewer)
		return call('POST', '/api/issue/pr/written', { action: 'round', reviewers: again })
	}
	throw new UsageError('pr: sync, ready, reply, ignore or round')
}

const head = () => sh(['git', 'rev-parse', 'HEAD']).out || undefined
const checkoutTop = () => sh(['git', 'rev-parse', '--show-toplevel']).out || process.cwd()

/** Pushes the captures GitHub does not have yet. A push that fails is reported, never thrown: the captures
 * stay on the page, and the PR's body says so. */
async function publishEvidence() {
	const plan = await call('POST', '/api/issue/evidence', { action: 'plan' })
	const files = plan.files as { name: string; path: string }[]
	if (!plan.unpublished) return { pushed: 0 }
	try {
		const { commit } = pushEvidence(process.cwd(), String(plan.ref), files, String(plan.message))
		const base = repoWebBase(sh(['git', 'remote', 'get-url', 'origin']).out)
		await call('POST', '/api/issue/evidence', { action: 'published', commit, files: files.map((f) => f.name), base: base ?? undefined })
		return { pushed: Number(plan.unpublished), commit, ref: plan.ref }
	} catch (error) {
		const message = (error as Error).message
		await call('POST', '/api/issue/report', { text: `Captures could not be pushed to GitHub, so they show on the page only: ${message}`.slice(0, 1900) })
		return { pushed: 0, error: message }
	}
}

async function evidenceCommand(argv: string[]) {
	const [action, ...rest] = argv
	if (action === 'list') return call('POST', '/api/issue/evidence', { action: 'list' })
	if (action === 'add') {
		const { values, positionals } = args(rest, { title: { type: 'string' }, label: { type: 'string' } })
		const [file, ...words] = positionals
		if (!file || !values.title) throw new UsageError('evidence add: give the file and --title <what it shows>')
		const path = resolve(file)
		if (!existsSync(path)) throw new UsageError(`evidence add: ${path} does not exist`)
		const note = words.length ? await textOf(words) : undefined
		let prepared: ReturnType<typeof prepare>
		try {
			prepared = prepare(path)
		} catch (error) {
			throw new UsageError(`evidence add: ${(error as Error).message}`)
		}
		try {
			const added = await call('POST', '/api/issue/evidence', {
				action: 'add',
				path: prepared.file,
				poster: prepared.poster,
				clip: prepared.clip,
				title: values.title,
				label: values.label,
				note: note || undefined,
				head: head()
			})
			return { ...added, ...(prepared.warning && { warning: prepared.warning }) }
		} finally {
			prepared.cleanup()
		}
	}
	if (action === 'remove') {
		const { positionals } = args(rest, {})
		if (!positionals[0]) throw new UsageError('evidence remove: give the id, as factory evidence list prints it')
		return call('POST', '/api/issue/evidence', { action: 'remove', id: positionals[0] })
	}
	if (action === 'publish') {
		const { values } = args(rest, { to: { type: 'string' } })
		const pushed = await publishEvidence()
		const status = await call('POST', '/api/issue/status', {})
		const pr = (status.issue as { prUrl?: string }).prUrl
		// The body holds what the reviewer reads first, so it is brought up to date even when nothing new was pushed.
		if (pr) {
			const plan = await call('POST', '/api/issue/pr/plan', { action: 'notes' })
			await gh.setBody(pr, withSections(await gh.prBody(pr), String(plan.sections)))
		}
		let commented: string | undefined
		if (values.to) {
			const plan = await call('POST', '/api/issue/evidence', { action: 'comment', to: values.to, login: await gh.login() })
			await gh.comment(String(plan.to), String(plan.body))
			await call('POST', '/api/issue/evidence', { action: 'commented', to: values.to })
			commented = String(plan.to)
		}
		return { ...pushed, prBody: pr ? 'updated' : 'no PR yet', ...(commented && { commented }) }
	}
	throw new UsageError('evidence: add, list, remove or publish')
}

async function previewCommand(argv: string[]) {
	const [action, ...rest] = argv
	const top = checkoutTop()
	if (action === 'up') {
		const { values } = args(rest, { apps: { type: 'string' }, url: { type: 'string', multiple: true } })
		let urls: { name: string; url: string }[]
		try {
			urls = parseUrlFlags(values.url ?? [])
		} catch (error) {
			throw new UsageError((error as Error).message)
		}
		let warning = ''
		if (!urls.length) {
			if (!usesBuncargo(top)) {
				throw new UsageError(
					`preview up: ${top} has no dev.config.ts, so there is no buncargo run to start. Start the app as the repository's AGENTS.md says, then give each address: --url <name>=<url>`
				)
			}
			const started = buncargoUp(top, str(values.apps))
			urls = started.urls
			warning = started.output
			if (!urls.length) {
				await call('POST', '/api/issue/preview', { state: 'failed', error: (warning || 'buncargo printed no URL').slice(0, 1900) })
				throw new Error(`the dev environment did not start, and the page says so.\n${warning}`)
			}
		}
		const result = await call('POST', '/api/issue/preview', { state: 'up', urls, head: head(), error: warning ? warning.slice(0, 1900) : undefined })
		return { ...result, urls, ...(warning && { warning }) }
	}
	if (action === 'down') {
		const stopped = usesBuncargo(top) ? buncargoDown(top) : { ok: true, output: '' }
		const result = await call('POST', '/api/issue/preview', { state: 'down' })
		return { ...result, ...(!stopped.ok && { warning: stopped.output }) }
	}
	if (action === 'failed') {
		const reason = await textOf(rest)
		if (!reason) throw new UsageError('preview failed: give the reason, or - to read it from stdin')
		return call('POST', '/api/issue/preview', { state: 'failed', error: reason })
	}
	throw new UsageError('preview: up, down or failed')
}

/** A brief runs to a thousand words, and an orchestrator that retypes it into `delegate_task` can change it.
 * So the brief goes to a file, and the child's task is one line that names the file. */
function withBriefFile(started: Record<string, unknown>) {
	const { brief, ...rest } = started
	if (typeof brief !== 'string') return started
	const briefFile = `/tmp/factory-brief-${rest.run}.md`
	writeFileSync(briefFile, `${brief}\n`)
	return {
		...rest,
		briefFile,
		task: `You run one stage of a factory issue. Your task is the brief in \`${briefFile}\`: read the whole file before anything else, then do what it says. It ends with how to report your result.`
	}
}

function print(value: unknown) {
	console.log(JSON.stringify(value, null, 2))
}

main(process.argv.slice(2)).catch((error) => {
	console.error(`factory: ${(error as Error).message}`)
	process.exit(1)
})
