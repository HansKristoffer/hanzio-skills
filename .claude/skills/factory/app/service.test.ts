import { expect, test } from 'bun:test'
import { renderPlist, renderUnit } from './service.ts'

const command = ['/home/me/.bun/bin/bun', '/home/me/.claude/skills/factory/app/cli.ts', 'serve']
const env = { FACTORY_HOME: '/home/me/.local/share/factory', PATH: '/home/me/.bun/bin:/usr/bin' }

test('the systemd unit runs serve with the absolute bun path and restarts it', () => {
	const unit = renderUnit(command, env, '/home/me/.local/share/factory/server.log')
	expect(unit).toContain('ExecStart="/home/me/.bun/bin/bun" "/home/me/.claude/skills/factory/app/cli.ts" "serve"')
	expect(unit).toContain('Environment="PATH=/home/me/.bun/bin:/usr/bin"')
	expect(unit).toContain('Restart=always')
	expect(unit).toContain('WantedBy=default.target')
	expect(unit).toContain('StandardOutput=append:/home/me/.local/share/factory/server.log')
})

test('the launchd agent keeps it alive with the same command', () => {
	const plist = renderPlist(command, env, '/tmp/server.log')
	expect(plist).toContain('<string>/home/me/.bun/bin/bun</string>')
	expect(plist).toContain('<key>KeepAlive</key>\n\t<true/>')
	expect(plist).toContain('<key>FACTORY_HOME</key>')
})
