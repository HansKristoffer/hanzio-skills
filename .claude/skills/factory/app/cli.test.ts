// Runs the real CLI: it must start a server that outlives it, outside the caller's systemd scope,
// and replace a server that runs other code. Uses a free port and a temp home, never 4400.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { cpSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { SKILL_DIR } from './env.ts'
import { FAKE_BUNCARGO, FAKE_T3, freePort, git, scratchRepo, tempDir } from './fixtures/harness.ts'

const CLI = join(import.meta.dir, 'cli.ts')
const dir = tempDir()
const port = freePort()
const { work, bare } = scratchRepo(dir)
const linuxSystemd =
	process.platform === 'linux' &&
	Bun.spawnSync(['systemctl', '--user', 'show-environment'], { stdout: 'ignore', stderr: 'ignore' }).exitCode === 0

function cli(args: string[], env: Record<string, string> = {}, { stdin, path = CLI }: { stdin?: string; path?: string } = {}) {
	const started = Date.now()
	const result = Bun.spawnSync(['bun', path, ...args], {
		cwd: work,
		...(stdin !== undefined && { stdin: new Blob([stdin]) }),
		stdout: 'pipe',
		stderr: 'pipe',
		env: {
			...process.env,
			FACTORY_HOME: join(dir, 'home'),
			FACTORY_PORT: String(port),
			FACTORY_T3: FAKE_T3,
			FAKE_T3_LOG: join(dir, 't3.log'),
			T3CODE_THREAD_ID: 'cli-thread',
			...env
		}
	})
	return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString(), ms: Date.now() - started }
}

const health = async () => {
	try {
		return (await (await fetch(`http://127.0.0.1:${port}/health`)).json()) as { version: string }
	} catch {
		return null
	}
}

beforeAll(() => {
	expect(port).not.toBe(4400)
})

afterAll(async () => {
	await fetch(`http://127.0.0.1:${port}/api/shutdown`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).catch(() => {})
	if (linuxSystemd) Bun.spawnSync(['systemctl', '--user', 'stop', `factory-${port}`, `factory-${port}-preview-cli-thread`], { stderr: 'ignore' })
	rmSync(dir, { recursive: true, force: true })
})

test('the first command starts the server, which outlives it', async () => {
	const res = cli(['start', '--title', 'From the CLI'], { FACTORY_VERSION: 'v1' })
	expect(res.err).toBe('')
	expect(res.code).toBe(0)
	expect(res.ms).toBeLessThan(6000)
	expect(JSON.parse(res.out).issue).toBe('cli-thread')
	expect((await health())?.version).toBe('v1')
	if (linuxSystemd) {
		const group = Bun.spawnSync(['systemctl', '--user', 'show', `factory-${port}`, '-p', 'ControlGroup'], { stdout: 'pipe' })
		expect(group.stdout.toString()).toContain('/app.slice/')
		expect(group.stdout.toString()).not.toContain('.scope')
	}
}, 15_000)

test('a CLI of another version replaces the server', async () => {
	const res = cli(['status'], { FACTORY_VERSION: 'v2' })
	expect(res.code).toBe(0)
	expect(JSON.parse(res.out).issue.title).toBe('From the CLI')
	expect((await health())?.version).toBe('v2')
}, 20_000)

test('issue commands outside a T3 thread are refused, and usage errors name the flag', () => {
	const outside = cli(['status'], { FACTORY_VERSION: 'v2', T3CODE_THREAD_ID: '' })
	expect(outside.code).toBe(1)
	expect(outside.err).toContain('T3 Code thread')
	const done = cli(['report', '--done', 'x'], { FACTORY_VERSION: 'v2' })
	expect(done.err).toContain('--done and --failed need --run')
	const missing = cli(['start', '--body-file', '/nope'], { FACTORY_VERSION: 'v2' })
	expect(missing.err).toContain('--body-file: /nope does not exist')
})

test('report - takes its text from stdin, so the shell runs nothing in it', async () => {
	const text = 'ran `bun test` and $(echo nope) "quoted"'
	const res = cli(['report', '-'], { FACTORY_VERSION: 'v2' }, { stdin: `${text}\n` })
	expect(res.code).toBe(0)
	const issue = (await (await fetch(`http://127.0.0.1:${port}/api/issues/cli-thread`)).json()) as { events: { text: string }[] }
	expect(issue.events.at(-1)?.text).toBe(text)
})

test('run puts the brief in a file and prints the one-line task that names it', () => {
	const res = cli(['run', '--stage', 'research'], { FACTORY_VERSION: 'v2' })
	expect(res.code).toBe(0)
	const started = JSON.parse(res.out) as { run: string; briefFile: string; task: string; brief?: string }
	expect(started.brief).toBeUndefined()
	expect(started.briefFile).toBe(`/tmp/factory-brief-${started.run}.md`)
	expect(started.task).toContain(started.briefFile)
	const brief = readFileSync(started.briefFile, 'utf8')
	rmSync(started.briefFile)
	expect(brief.startsWith('# Research')).toBe(true)
	expect(brief).toContain(`report --run ${started.run} --done`)
})

test('a CLI from another folder uses the running server and warns, never replacing it', async () => {
	const copy = join(dir, 'copy')
	cpSync(SKILL_DIR, copy, { recursive: true })
	const res = cli(['status'], { FACTORY_VERSION: 'v3' }, { path: join(copy, 'app', 'cli.ts') })
	expect(res.code).toBe(0)
	expect(res.err).toContain('runs version v2')
	expect(res.err).toContain('this CLI is version v3')
	expect((await health())?.version).toBe('v2')
}, 15_000)

test('evidence add keeps a capture with its note and commit, and publish pushes it to a ref no branch lists', async () => {
	const png = join(dir, 'orders.png')
	writeFileSync(png, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'))
	const note = 'Three rows `selected` and $(echo nope)'
	const added = cli(['evidence', 'add', png, '--title', 'Orders page', '--label', 'after', '-'], { FACTORY_VERSION: 'v2' }, { stdin: `${note}\n` })
	expect(added.err).toBe('')
	const item = JSON.parse(added.out).evidence
	expect(item).toMatchObject({ kind: 'image', title: 'Orders page', label: 'after', note, head: git(work, 'rev-parse', 'HEAD') })
	expect((await fetch(`http://127.0.0.1:${port}${item.url}`)).status).toBe(200)
	expect(cli(['evidence', 'add', join(dir, 'missing.png'), '--title', 'x'], { FACTORY_VERSION: 'v2' }).err).toContain('does not exist')

	const published = cli(['evidence', 'publish'], { FACTORY_VERSION: 'v2' })
	expect(published.err).toBe('')
	const result = JSON.parse(published.out)
	expect(result).toMatchObject({ pushed: 1, ref: 'refs/factory/evidence/cli-thread', prBody: 'no PR yet' })
	expect(git(bare, 'rev-parse', 'refs/factory/evidence/cli-thread')).toBe(result.commit)
	expect(git(bare, 'branch', '--list')).not.toContain('evidence')
	expect(JSON.parse(cli(['evidence', 'publish'], { FACTORY_VERSION: 'v2' }).out).pushed).toBe(0)
	const listed = JSON.parse(cli(['evidence', 'list'], { FACTORY_VERSION: 'v2' }).out).evidence
	expect(listed[0].pushed).toBe(true)
	// A before taken in a checkout of the base names that commit, not this checkout's HEAD.
	const before = cli(['evidence', 'add', png, '--title', 'Orders page', '--label', 'before', '--commit', 'ba5e1234'], { FACTORY_VERSION: 'v2' })
	expect(before.err).toBe('')
	expect(JSON.parse(before.out).evidence).toMatchObject({ label: 'before', head: 'ba5e1234' })
}, 20_000)

test('preview up starts the detached buncargo run in the checkout and puts its addresses on the page', async () => {
	const log = join(dir, 'buncargo.log')
	writeFileSync(log, '')
	const env = { FACTORY_VERSION: 'v2', FACTORY_BUNCARGO: FAKE_BUNCARGO, FAKE_BUNCARGO_LOG: log }
	const status = () => JSON.parse(cli(['status'], env).out).preview
	const calls = () => readFileSync(log, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as { args: string[]; cwd: string })

	const without = cli(['preview', 'up'], env)
	expect(without.code).toBe(1)
	expect(without.err).toContain('has no dev.config.ts')
	expect(without.err).toContain('--url <name>=http://localhost:<port> -- <command>')
	expect(calls()).toEqual([])

	writeFileSync(join(work, 'dev.config.ts'), 'export default {}\n')
	const before = Date.now()
	const up = cli(['preview', 'up', '--apps', 'web'], env)
	expect(up.err).toBe('')
	// The primary app leads, since the page makes the first address its main button.
	expect(JSON.parse(up.out).urls).toEqual([
		{ name: 'shopify admin', url: 'https://admin.example.test/store' },
		{ name: 'web', url: 'http://localhost:5173' }
	])
	expect(calls().map((c) => c.args)).toEqual([['dev', '--detach', '--apps=web'], ['url'], ['status', '--json']])
	expect(calls()[0]!.cwd).toBe(work)
	expect(status()).toMatchObject({ state: 'up', head: git(work, 'rev-parse', 'HEAD') })
	expect(status().stopsAt).toBeGreaterThanOrEqual(before + 7_200_000)

	const failed = cli(['preview', 'up'], { ...env, FAKE_BUNCARGO_FAIL: '1' })
	expect(failed.code).toBe(1)
	expect(failed.err).toContain('did not start')
	expect(status()).toMatchObject({ state: 'failed', stopsAt: null })
	expect(status().error).toContain('port 3000 is held by another checkout')

	expect(cli(['preview', 'down'], env).code).toBe(0)
	expect(calls().at(-1)!.args).toEqual(['stop', '--all'])
	expect(status().state).toBe('down')
	rmSync(join(work, 'dev.config.ts'))
}, 30_000)

test('preview up runs a project\'s own start command outside the session, and preview down stops it', async () => {
	const env = { FACTORY_VERSION: 'v2' }
	const status = () => JSON.parse(cli(['status'], env).out).preview
	const appPort = freePort()
	const url = `http://127.0.0.1:${appPort}`
	const listening = async () => !!(await fetch(url).catch(() => null))
	writeFileSync(join(dir, 'app.ts'), 'Bun.serve({ port: Number(process.env.APP_PORT), hostname: "127.0.0.1", fetch: () => new Response("app") })\nconsole.log("app is listening")\n')

	const bare = cli(['preview', 'up', '--', 'bun', join(dir, 'app.ts')], env)
	expect(bare.code).toBe(1)
	expect(bare.err).toContain('--url <name>=http://localhost:<port> -- <command>')

	// An address nothing answers at is refused, so the page never gets a link that was dead from the start.
	const nothing = cli(['preview', 'up', '--timeout', '0', '--url', `web=${url}`], env)
	expect(nothing.code).toBe(1)
	expect(nothing.err).toContain(`nothing answers at web (${url})`)

	const up = cli(['preview', 'up', '--url', `web=${url}`, '--', 'bun', join(dir, 'app.ts')], { ...env, APP_PORT: String(appPort) })
	expect(up.err).toBe('')
	const started = JSON.parse(up.out) as { urls: unknown; log: string }
	expect(started.urls).toEqual([{ name: 'web', url }])
	expect(readFileSync(started.log, 'utf8')).toContain('app is listening')
	expect(status()).toMatchObject({ state: 'up', urls: [{ name: 'web', url }], head: git(work, 'rev-parse', 'HEAD') })
	// The CLI that started it has exited, and the app still answers.
	expect(await listening()).toBe(true)
	if (linuxSystemd) {
		const cgroup = Bun.spawnSync(['systemctl', '--user', 'show', `factory-${port}-preview-cli-thread`, '-p', 'ControlGroup'], { stdout: 'pipe' })
		expect(cgroup.stdout.toString()).toContain(`factory-${port}-preview-cli-thread.service`)
		// The environment reached the command through a private file, not the unit's command line.
		const exec = Bun.spawnSync(['systemctl', '--user', 'show', `factory-${port}-preview-cli-thread`, '-p', 'ExecStart'], { stdout: 'pipe' })
		expect(exec.stdout.toString()).toContain('app.ts')
		expect(exec.stdout.toString()).not.toContain(String(appPort))
	}

	const down = cli(['preview', 'down'], env)
	expect(down.code).toBe(0)
	expect(JSON.parse(down.out).warning).toBeUndefined()
	expect(await listening()).toBe(false)
	expect(status().state).toBe('down')

	// A command that exits, or never serves the address, fails with what it printed.
	const crashed = cli(['preview', 'up', '--url', `web=${url}`, '--', 'sh', '-c', 'echo "DATABASE_URL is not set"; exit 1'], env)
	expect(crashed.code).toBe(1)
	expect(crashed.err).toContain('The command exited before web')
	expect(crashed.err).toContain('DATABASE_URL is not set')
	expect(status()).toMatchObject({ state: 'failed' })
	expect(status().error).toContain('DATABASE_URL is not set')
	const slow = cli(['preview', 'up', '--timeout', '1', '--url', `web=${url}`, '--', 'sleep', '30'], env)
	expect(slow.code).toBe(1)
	expect(slow.err).toContain('After 1 seconds the command was stopped')

	// An app the thread started itself is registered as it is, and `preview down` says it still runs.
	const mine = Bun.spawn(['bun', join(dir, 'app.ts')], { env: { ...process.env, APP_PORT: String(appPort) }, stdout: 'ignore', stderr: 'ignore' })
	try {
		while (!(await listening())) await Bun.sleep(50)
		expect(JSON.parse(cli(['preview', 'up', '--url', `web=${url}`], env).out).urls).toEqual([{ name: 'web', url }])
		expect(JSON.parse(cli(['preview', 'down'], env).out).warning).toContain('factory did not start this app')
		expect(await listening()).toBe(true)
	} finally {
		mine.kill()
	}
}, 60_000)
