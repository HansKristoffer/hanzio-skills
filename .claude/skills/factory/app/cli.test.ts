// Runs the real CLI: it must start a server that outlives it, outside the caller's systemd scope,
// and replace a server that runs other code. Uses a free port and a temp home, never 4400.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { cpSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { SKILL_DIR } from './env.ts'
import { FAKE_T3, freePort, scratchRepo, tempDir } from './fixtures/harness.ts'

const CLI = join(import.meta.dir, 'cli.ts')
const dir = tempDir()
const port = freePort()
const { work } = scratchRepo(dir)
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
	if (linuxSystemd) Bun.spawnSync(['systemctl', '--user', 'stop', `factory-${port}`])
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

test('a CLI from another folder uses the running server and warns, never replacing it', async () => {
	const copy = join(dir, 'copy')
	cpSync(SKILL_DIR, copy, { recursive: true })
	const res = cli(['status'], { FACTORY_VERSION: 'v3' }, { path: join(copy, 'app', 'cli.ts') })
	expect(res.code).toBe(0)
	expect(res.err).toContain('runs version v2')
	expect(res.err).toContain('this CLI is version v3')
	expect((await health())?.version).toBe('v2')
}, 15_000)
