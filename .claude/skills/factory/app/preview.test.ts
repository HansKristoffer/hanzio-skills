import { afterAll, describe, expect, test } from 'bun:test'
import { devSelection, reach } from './preview.ts'
import { freePort } from './fixtures/harness.ts'

describe('devSelection', () => {
	test('apps win over the settings profile, a profile asked for wins over it, and both at once is refused', () => {
		expect(devSelection({}, '')).toEqual([])
		expect(devSelection({}, 'lite')).toEqual(['--profile=lite'])
		expect(devSelection({ apps: 'admin' }, 'lite')).toEqual(['--apps=admin'])
		expect(devSelection({ profile: 'full' }, 'lite')).toEqual(['--profile=full'])
		expect(() => devSelection({ apps: 'admin', profile: 'full' })).toThrow('--apps or --profile, not both')
	})
})

// 127.0.0.2 stands in for the machine's tailnet address: a loopback address the page treats as another
// host, which a server bound to 127.0.0.1 does not answer and one bound to 0.0.0.0 does. Linux routes all of
// 127/8 to loopback; macOS does not without an alias.
describe.skipIf(process.platform !== 'linux')('reach', () => {
	const PAGE = '127.0.0.2'
	const serve = (hostname: string) => Bun.serve({ port: 0, hostname, fetch: () => new Response('app') })
	const local = serve('127.0.0.1')
	const open = serve('0.0.0.0')
	const dead = freePort()
	afterAll(() => {
		local.stop(true)
		open.stop(true)
	})

	test('an app listening everywhere moves to the page host, with no note', async () => {
		const { urls, notes } = await reach([{ name: 'web', url: `http://localhost:${open.port}/app` }], PAGE)
		expect(urls).toEqual([{ name: 'web', url: `http://${PAGE}:${open.port}/app` }])
		expect(notes).toEqual([])
	})

	test('an app bound to loopback keeps its address, and the note forwards each such port once', async () => {
		const { urls, notes } = await reach(
			[
				{ name: 'admin', url: `http://127.0.0.1:${local.port}` },
				{ name: 'admin again', url: `http://localhost:${local.port}/t` }
			],
			PAGE
		)
		expect(urls).toEqual([
			{ name: 'admin', url: `http://127.0.0.1:${local.port}` },
			{ name: 'admin again', url: `http://localhost:${local.port}/t` }
		])
		expect(notes[0]).toContain('on this machine only')
		expect(notes.at(-1)).toBe(`From another machine, forward first and open the address above: ssh -N -L ${local.port}:127.0.0.1:${local.port} ${PAGE}`)
	})

	test("an address on the page host that only loopback answers is swapped for loopback's", async () => {
		const { urls, notes } = await reach([{ name: 'admin', url: `http://${PAGE}:${local.port}/t` }], PAGE)
		expect(urls).toEqual([{ name: 'admin', url: `http://127.0.0.1:${local.port}/t` }])
		expect(notes.at(-1)).toContain(`-L ${local.port}:127.0.0.1:${local.port}`)
	})

	test('an address nothing answers at stays, with a note; other hosts and a page read here are left alone', async () => {
		const silent = await reach([{ name: 'api', url: `http://localhost:${dead}` }], PAGE)
		expect(silent.urls).toEqual([{ name: 'api', url: `http://localhost:${dead}` }])
		expect(silent.notes).toEqual([`api does not answer at http://localhost:${dead}.`])
		const elsewhere = [{ name: 'shop', url: 'https://admin.example.test/store' }]
		expect(await reach(elsewhere, PAGE)).toEqual({ urls: elsewhere, notes: [] })
		const here = [{ name: 'admin', url: `http://127.0.0.1:${local.port}` }]
		expect(await reach(here, 'localhost')).toEqual({ urls: here, notes: [] })
	})
})
