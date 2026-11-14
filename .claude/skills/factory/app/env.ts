// Where the service keeps its data, which port it uses, and which version of the app is running.
// The CLI and the server read these the same way, so a CLI can tell when the server runs older code.
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const APP_DIR = import.meta.dir
export const SKILL_DIR = join(APP_DIR, '..')
export const DEFAULT_PORT = 4400

export function factoryHome() {
	if (process.env.FACTORY_HOME) return process.env.FACTORY_HOME
	const data = process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share')
	return join(data, 'factory')
}

export function factoryPort() {
	const raw = process.env.FACTORY_PORT
	if (!raw) return DEFAULT_PORT
	const port = Number(raw)
	if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`FACTORY_PORT: ${raw} is not a port`)
	return port
}

/** Runs a command and never throws: Bun throws when the program is not installed, and Tailscale, systemd or
 * git can be missing on a machine. */
export function sh(args: string[], options: { cwd?: string } = {}) {
	try {
		const result = Bun.spawnSync(args, { cwd: options.cwd, env: { ...process.env }, stdout: 'pipe', stderr: 'pipe' })
		return { ok: result.exitCode === 0, out: result.stdout.toString().trim(), err: result.stderr.toString().trim() }
	} catch (error) {
		return { ok: false, out: '', err: `${args[0]} is not installed: ${(error as Error).message}` }
	}
}

/** Whether this user has a systemd manager to run a unit that outlives the caller's session. */
export const hasSystemd = () => process.platform === 'linux' && sh(['systemctl', '--user', 'show-environment']).ok

/** The SHA-256 of the app's source, so a synced skill update is noticed. FACTORY_VERSION overrides it, for tests. */
export function appVersion() {
	if (process.env.FACTORY_VERSION) return process.env.FACTORY_VERSION
	const hash = createHash('sha256')
	const files = readdirSync(APP_DIR)
		.filter((name) => (name.endsWith('.ts') || name.endsWith('.html')) && !name.endsWith('.test.ts'))
		.sort()
	for (const name of files) {
		hash.update(name)
		hash.update(readFileSync(join(APP_DIR, name)))
	}
	return hash.digest('hex').slice(0, 16)
}
