// Shared test setup: a temp FACTORY_HOME, a free port, a scratch repository with a bare origin,
// and the fake `t3`. Tests never touch port 4400 or the machine's real T3 Code.
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startServer, type ServerOptions } from '../server.ts'

export const FAKE_T3 = join(import.meta.dir, 'fake-t3.ts')
chmodSync(FAKE_T3, 0o755)

export function freePort() {
	const probe = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response() })
	const port = probe.port as number
	probe.stop(true)
	return port
}

export function tempDir(name = 'factory-test-') {
	return mkdtempSync(join(tmpdir(), name))
}

export function git(cwd: string, ...args: string[]) {
	const result = Bun.spawnSync(['git', ...args], {
		cwd,
		stdout: 'pipe',
		stderr: 'pipe',
		env: {
			...process.env,
			GIT_AUTHOR_NAME: 'test',
			GIT_AUTHOR_EMAIL: 'test@example.com',
			GIT_COMMITTER_NAME: 'test',
			GIT_COMMITTER_EMAIL: 'test@example.com',
			GIT_TERMINAL_PROMPT: '0'
		}
	})
	if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr.toString()}`)
	return result.stdout.toString().trim()
}

/**
 * A checkout of `acme/api` with a bare origin, a deleted file, a renamed file, and a local default
 * branch behind its remote, as the repository's AGENTS.md asks of every command a skill runs.
 */
export function scratchRepo(dir: string, name = 'acme/api') {
	const bare = join(dir, 'remote', `${name}.git`)
	mkdirSync(bare, { recursive: true })
	git(bare, 'init', '--bare', '-q', '-b', 'main')
	const work = join(dir, 'work', name.split('/')[1]!)
	mkdirSync(work, { recursive: true })
	git(work, 'init', '-q', '-b', 'main')
	writeFileSync(join(work, 'a.txt'), 'a\n')
	writeFileSync(join(work, 'gone.txt'), 'gone\n')
	writeFileSync(join(work, 'old-name.txt'), 'moved\n')
	git(work, 'add', '.')
	git(work, 'commit', '-q', '-m', 'first')
	git(work, 'rm', '-q', 'gone.txt')
	git(work, 'mv', 'old-name.txt', 'new-name.txt')
	git(work, 'commit', '-q', '-m', 'delete and rename')
	git(work, 'remote', 'add', 'origin', bare)
	git(work, 'push', '-q', '-u', 'origin', 'main')
	git(work, 'remote', 'set-head', 'origin', 'main')
	// Move origin ahead of the local main.
	const other = join(dir, 'other')
	git(dir, 'clone', '-q', bare, other)
	writeFileSync(join(other, 'b.txt'), 'b\n')
	git(other, 'add', '.')
	git(other, 'commit', '-q', '-m', 'ahead')
	git(other, 'push', '-q', 'origin', 'main')
	return { bare, work, other }
}

/** Commits a file to origin's default branch through the `other` clone. */
export function pushFile(other: string, path: string, content: string | null) {
	git(other, 'pull', '-q', '--rebase', 'origin', 'main')
	if (content === null) git(other, 'rm', '-q', path)
	else {
		writeFileSync(join(other, path), content)
		git(other, 'add', path)
	}
	git(other, 'commit', '-q', '-m', `change ${path}`)
	git(other, 'push', '-q', 'origin', 'main')
}

export type Harness = ReturnType<typeof setup>

export function setup(options: Partial<ServerOptions> = {}) {
	const dir = tempDir()
	const home = join(dir, 'home')
	const port = freePort()
	const log = join(dir, 't3.log')
	const reply = join(dir, 't3-reply.json')
	writeFileSync(log, '')
	process.env.FACTORY_T3 = FAKE_T3
	process.env.FAKE_T3_LOG = log
	process.env.FAKE_T3_REPLY = reply
	let server = startServer({ home, port, nudgeEveryMs: 0, onShutdown: () => {}, ...options })

	const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
		const res = await fetch(`http://127.0.0.1:${port}${path}`, {
			method,
			headers: { 'content-type': 'application/json', ...headers },
			...(body !== undefined && { body: JSON.stringify(body) })
		})
		return { status: res.status, body: (await res.json()) as Record<string, any> }
	}
	const as = (thread: string) => (method: string, path: string, body?: unknown) =>
		call(method, path, body, { 'x-factory-thread': thread })

	return {
		dir,
		home,
		port,
		get server() {
			return server
		},
		call,
		as,
		replies(value: Record<string, unknown>) {
			writeFileSync(reply, JSON.stringify(value))
		},
		calls(): { args: string[]; stdin: string | null }[] {
			return readFileSync(log, 'utf8')
				.split('\n')
				.filter(Boolean)
				.map((line) => JSON.parse(line))
		},
		restart() {
			server.stop()
			server = startServer({ home, port, nudgeEveryMs: 0, onShutdown: () => {}, ...options })
		},
		close() {
			server.stop()
			rmSync(dir, { recursive: true, force: true })
		}
	}
}
