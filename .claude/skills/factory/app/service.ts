// Keeps the service up across reboots: a systemd user unit on Linux, a launchd agent on macOS.
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { sh } from './env.ts'

export const UNIT = 'factory'
const LABEL = 'dev.factory.service'

export const unitPath = () =>
	join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'systemd', 'user', `${UNIT}.service`)
const plistPath = () => join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`)

export const unitInstalled = () => existsSync(process.platform === 'darwin' ? plistPath() : unitPath())

const quote = (value: string) => `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
const xml = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')

export function renderUnit(command: string[], env: Record<string, string>, log: string) {
	return [
		'[Unit]',
		'Description=Factory service: the live board for T3 Code factory threads',
		'',
		'[Service]',
		`ExecStart=${command.map(quote).join(' ')}`,
		...Object.entries(env).map(([key, value]) => `Environment=${quote(`${key}=${value}`)}`),
		`StandardOutput=append:${log}`,
		`StandardError=append:${log}`,
		'Restart=always',
		'RestartSec=1',
		'',
		'[Install]',
		'WantedBy=default.target',
		''
	].join('\n')
}

export function renderPlist(command: string[], env: Record<string, string>, log: string) {
	const strings = (values: string[]) => values.map((value) => `\t\t<string>${xml(value)}</string>`).join('\n')
	const vars = Object.entries(env)
		.map(([key, value]) => `\t\t<key>${xml(key)}</key>\n\t\t<string>${xml(value)}</string>`)
		.join('\n')
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>${LABEL}</string>
	<key>ProgramArguments</key>
	<array>
${strings(command)}
	</array>
	<key>EnvironmentVariables</key>
	<dict>
${vars}
	</dict>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<true/>
	<key>StandardOutPath</key>
	<string>${xml(log)}</string>
	<key>StandardErrorPath</key>
	<string>${xml(log)}</string>
</dict>
</plist>
`
}

function must(args: string[]) {
	const result = sh(args)
	if (!result.ok) throw new Error(`${args.join(' ')}: ${result.err || result.out}`)
	return result
}

export function install(command: string[], env: Record<string, string>, log: string, transientUnit: string) {
	const warnings: string[] = []
	if (process.platform === 'darwin') {
		mkdirSync(join(homedir(), 'Library', 'LaunchAgents'), { recursive: true })
		writeFileSync(plistPath(), renderPlist(command, env, log))
		sh(['launchctl', 'unload', plistPath()])
		must(['launchctl', 'load', '-w', plistPath()])
		return { installed: plistPath(), warnings }
	}
	mkdirSync(join(unitPath(), '..'), { recursive: true })
	writeFileSync(unitPath(), renderUnit(command, env, log))
	must(['systemctl', '--user', 'daemon-reload'])
	sh(['systemctl', '--user', 'stop', transientUnit])
	must(['systemctl', '--user', 'enable', '--now', UNIT])
	const user = process.env.USER ?? ''
	const linger = sh(['loginctl', 'show-user', user, '-p', 'Linger'])
	if (linger.out !== 'Linger=yes') {
		warnings.push(`Linger is off, so the unit starts only when you log in. Turn it on with: loginctl enable-linger ${user}`)
	}
	return { installed: unitPath(), warnings }
}

export function uninstall() {
	if (process.platform === 'darwin') {
		sh(['launchctl', 'unload', '-w', plistPath()])
		rmSync(plistPath(), { force: true })
		return { removed: plistPath() }
	}
	sh(['systemctl', '--user', 'disable', '--now', UNIT])
	rmSync(unitPath(), { force: true })
	sh(['systemctl', '--user', 'daemon-reload'])
	return { removed: unitPath() }
}
