// What a reviewer looks at: captures kept by the service and shown in the PR's body, the push to a ref
// outside refs/heads, and the dev environment the page asks the issue's thread for.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { commitRef, evidenceMarkdown, measuredMarkdown, onHost, parseRun, parseUrlFlags, parseUrlLines, primaryFirst, repoWebBase, type PublicEvidence } from './evidence.ts'
import { git, scratchRepo, setup, type Harness } from './fixtures/harness.ts'
import { prepare, pushEvidence } from './media.ts'

// The smallest PNG there is: one transparent pixel.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')
const hasFfmpeg = Bun.spawnSync(['sh', '-c', 'command -v ffmpeg'], { stdout: 'ignore', stderr: 'ignore' }).exitCode === 0

let h: Harness
let repo: ReturnType<typeof scratchRepo>
const as = (path: string, body: Record<string, unknown> = {}) => h.as('t1')('POST', path, body)
const evidence = (body: Record<string, unknown>) => as('/api/issue/evidence', body)

function shot(name: string) {
	const path = join(h.dir, name)
	writeFileSync(path, PNG)
	return path
}

beforeEach(async () => {
	h = setup()
	repo = scratchRepo(h.dir)
	h.replies({ show: { code: 0, out: JSON.stringify({ thread: { status: 'completed', pendingRequestCount: 0 } }) } })
	await as('/api/issue/start', { cwd: repo.work, title: 'Bulk actions on orders' })
})
afterEach(() => h.close())

describe('captures', () => {
	test('a capture is kept, served with its type, and shown in status and on the board', async () => {
		const added = await evidence({ action: 'add', path: shot('orders.png'), title: 'Orders page', label: 'after', note: 'With three rows selected', head: 'abc1234' })
		expect(added.status).toBe(200)
		const item = added.body.evidence
		expect(item).toMatchObject({ kind: 'image', title: 'Orders page', label: 'after', head: 'abc1234', pushed: false, github: null })
		const file = await fetch(`http://127.0.0.1:${h.port}${item.url}`)
		expect(file.status).toBe(200)
		expect(file.headers.get('content-type')).toBe('image/png')
		expect(Buffer.from(await file.arrayBuffer()).equals(PNG)).toBe(true)
		expect((await as('/api/issue/status')).body.evidence).toHaveLength(1)
		expect((await h.call('GET', '/api/board')).body.issues[0].captures).toBe(1)
	})

	test('the same title and label again replaces the capture and its file; another label sits beside it', async () => {
		const first = (await evidence({ action: 'add', path: shot('a.png'), title: 'Orders page', label: 'after' })).body.evidence
		await evidence({ action: 'add', path: shot('b.png'), title: 'Orders page', label: 'before' })
		const again = (await evidence({ action: 'add', path: shot('c.png'), title: 'Orders page', label: 'after' })).body.evidence
		const listed = (await evidence({ action: 'list' })).body.evidence as { id: string; label: string }[]
		expect(listed.map((e) => e.label).sort()).toEqual(['after', 'before'])
		expect(listed.some((e) => e.id === first.id)).toBe(false)
		expect((await fetch(`http://127.0.0.1:${h.port}${first.url}`)).status).toBe(404)
		expect((await fetch(`http://127.0.0.1:${h.port}${again.url}`)).status).toBe(200)
		expect(readdirSync(join(h.home, 'evidence', 't1'))).toHaveLength(2)
	})

	test('what is not a capture is refused, and a file outside the evidence folder is never served', async () => {
		const text = join(h.dir, 'notes.txt')
		writeFileSync(text, 'x')
		expect((await evidence({ action: 'add', path: text, title: 'Notes' })).body.error).toContain('not an image or a video')
		expect((await evidence({ action: 'add', path: 'relative.png', title: 'x' })).body.error).toContain('is not a file')
		expect((await evidence({ action: 'add', path: shot('a.png') })).body.error).toContain('title is required')
		expect((await evidence({ action: 'add', path: shot('a.png'), title: 'x', label: 'during' })).body.error).toContain('label')
		for (const path of ['/evidence/t1/factory.db', '/evidence/..%2F/factory.db', '/evidence/t1/..%2F..%2Ffactory.db', '/evidence/t1/%E0%A4%A']) {
			expect((await fetch(`http://127.0.0.1:${h.port}${path}`)).status).toBe(404)
		}
		expect(existsSync(join(h.home, 'factory.db'))).toBe(true)
	})

	test('removing a capture removes its file, and a restart sweeps a folder with no rows', async () => {
		const item = (await evidence({ action: 'add', path: shot('a.png'), title: 'Orders page' })).body.evidence
		expect((await evidence({ action: 'remove', id: 'e_nope' })).status).toBe(404)
		expect((await evidence({ action: 'remove', id: item.id })).status).toBe(200)
		expect(readdirSync(join(h.home, 'evidence', 't1'))).toHaveLength(0)
		h.restart()
		expect(existsSync(join(h.home, 'evidence', 't1'))).toBe(false)
	})
})

describe('on GitHub', () => {
	const implement = { prUrl: 'https://github.com/acme/api/pull/7', commit: 'abc1234', claims: [], notChecked: ['Safari'], leftOut: [], decisions: [] }
	async function built(extra: Record<string, unknown> = {}) {
		const run = (await as('/api/issue/run', { stage: 'implement' })).body.run
		const res = await h.as('child')('POST', `/api/runs/${run}/report`, { text: 'done', done: true, result: { outcome: 'done', result: { ...implement, ...extra } } })
		expect(res.status).toBe(200)
		await as('/api/issue/update', { pr: implement.prUrl })
	}
	const sections = async () => (await as('/api/issue/pr/plan', { action: 'notes' })).body.sections as string

	test('a pushed pair shows side by side in the PR body, by the commit it was pushed in', async () => {
		await built({ tryIt: 'Sign in as demo@acme.test and open /orders.' })
		await evidence({ action: 'add', path: shot('b.png'), title: 'Orders | page', label: 'before' })
		await evidence({ action: 'add', path: shot('a.png'), title: 'Orders | page', label: 'after' })
		const plan = (await evidence({ action: 'plan' })).body
		expect(plan.ref).toBe('refs/factory/evidence/t1')
		expect(plan.unpublished).toBe(2)
		expect(plan.files).toHaveLength(2)
		expect(await sections()).toContain('kept on the factory page, not pushed to GitHub')
		const names = (plan.files as { name: string }[]).map((f) => f.name)
		const pushed = await evidence({ action: 'published', commit: 'c0ffee1234', files: names, base: 'git@github.com:acme/other.git' })
		expect(pushed.status).toBe(200)
		expect((await evidence({ action: 'plan' })).body.unpublished).toBe(0)
		const body = await sections()
		expect(body).toContain('### What it looks like')
		expect(body).toContain('**Orders \\| page**')
		expect(body).toContain('| Before | After |')
		// The PR's own repository wins over the remote the push went to.
		expect(body).toContain(`](https://github.com/acme/api/raw/c0ffee1234/${names[0]})`)
		expect(body).toContain('### Try it\n\nSign in as demo@acme.test and open /orders.')
		expect(body.indexOf('### What it looks like')).toBeLessThan(body.indexOf('### Decisions'))
	})

	test('each side of a pair names the commit it shows, as a link into the PR\'s repository', async () => {
		await built()
		await evidence({ action: 'add', path: shot('b.png'), title: 'Orders page', label: 'before', head: 'ba5e1234567890' })
		await evidence({ action: 'add', path: shot('a.png'), title: 'Orders page', label: 'after', head: 'abc1234' })
		const names = ((await evidence({ action: 'plan' })).body.files as { name: string }[]).map((f) => f.name)
		await evidence({ action: 'published', commit: 'c0ffee1234', files: names })
		expect(await sections()).toContain(
			'| Before | After |\n| --- | --- |\n| [`ba5e123456`](https://github.com/acme/api/commit/ba5e1234567890) | [`abc1234`](https://github.com/acme/api/commit/abc1234) |\n| ![Before: Orders page]('
		)
	})

	test('the body shows how the problem was reproduced, what was measured, what was left out and which model did each stage', async () => {
		const research = (await as('/api/issue/run', { stage: 'research' })).body.run
		const reproduction = { command: 'bun test src/export.test.ts', base: 'ba5e1234567890', observed: '1 fail: the export times out after 30 s.' }
		const researched = { kind: 'bug', size: 'S', route: 'implement', reproduction, checks: [] }
		expect((await h.as('child')('POST', `/api/runs/${research}/report`, { text: 'x', done: true, result: { outcome: 'done', result: researched } })).status).toBe(200)
		const measured = {
			how: 'A copy of the demo database, 5 runs each, the median.',
			base: 'ba5e1234567890',
			head: 'abc1234',
			rows: [{ what: 'Export of 10,000 orders', before: '31 s', after: '2.4 s' }],
			same: 'Both sides wrote the same 10,000 rows.'
		}
		await built({ measured, leftOut: ['The PDF export has the same loop; left for its own issue.'] })
		const body = await sections()
		expect(body).toContain(
			'### Reproduced on [`ba5e123456`](https://github.com/acme/api/commit/ba5e1234567890)\n\n```bash\nbun test src/export.test.ts\n```\n\n1 fail: the export times out after 30 s.'
		)
		expect(body).toContain(
			'### Measured\n\nA copy of the demo database, 5 runs each, the median.\n\n| | Before, at [`ba5e123456`](https://github.com/acme/api/commit/ba5e1234567890) | After, at [`abc1234`](https://github.com/acme/api/commit/abc1234) |\n| --- | ---: | ---: |\n| Export of 10,000 orders | 31 s | 2.4 s |\n\nBoth sides wrote the same 10,000 rows.'
		)
		expect(body).toContain('### Not in this change\n\n- The PDF export has the same loop; left for its own issue.')
		expect(body).toContain('### Who did the work\n\n- Researched by `')
		expect(body).toContain('- Written by `')
		expect(body).toContain('- No internal review ran\n- Run by the factory skill in T3 Code')
		expect(body.indexOf('### Reproduced on')).toBeLessThan(body.indexOf('### Measured'))
		expect(body.indexOf('### Not checked')).toBeLessThan(body.indexOf('### Not in this change'))
	})

	test('a feature shows no reproduction, and no measurements when nothing was measured', async () => {
		await built()
		const body = await sections()
		expect(body).not.toContain('### Reproduced on')
		expect(body).not.toContain('### Measured')
		expect(body).toContain('### Not in this change\n\n- Nothing')
	})

	test('the body links the factory page in a private repository, and nowhere the public reads', async () => {
		await built()
		const notes = async (repoPrivate: boolean) => (await as('/api/issue/pr/plan', { action: 'notes', repoPrivate })).body.sections as string
		expect(await notes(true)).toContain(
			`## For the reviewer\n\n[The factory page for this issue](http://127.0.0.1:${h.port}/#/issue/t1) shows the whole run`
		)
		expect(await notes(true)).toContain('It opens on the machine the factory runs on.')
		expect(await notes(false)).not.toContain('/#/issue/')
		expect(await sections()).not.toContain('/#/issue/')
	})

	test('on a tailnet the link is the address the reviewer can open from another machine', async () => {
		h.close()
		h = setup({ tailnet: { ip: '127.0.0.2', name: 'worker.tail1234.ts.net' } })
		repo = scratchRepo(h.dir)
		await as('/api/issue/start', { cwd: repo.work, title: 'Bulk actions on orders' })
		await built()
		const body = (await as('/api/issue/pr/plan', { action: 'notes', repoPrivate: true })).body.sections as string
		expect(body).toContain(`(http://worker.tail1234.ts.net:${h.port}/#/issue/t1)`)
		expect(body).toContain("It opens on the factory's tailnet.")
	})

	test('with nothing captured, the body gives the reason the implementer gave, or leaves the part out', async () => {
		await built()
		expect(await sections()).not.toContain('### What it looks like')
		await built({ media: 'None: the fix has no visible effect.' })
		expect(await sections()).toContain('### What it looks like\n\nNone: the fix has no visible effect.')
	})

	test('a comment needs a capture that is on GitHub, and goes to an issue or a PR only', async () => {
		await built()
		await evidence({ action: 'add', path: shot('a.png'), title: 'Orders page' })
		const to = 'https://github.com/acme/api/issues/42'
		expect((await evidence({ action: 'comment', to })).body.error).toContain('no capture is on GitHub yet')
		expect((await evidence({ action: 'comment', to: 'https://example.com/x' })).body.error).toContain('not an issue or pull request URL')
		const names = ((await evidence({ action: 'plan' })).body.files as { name: string }[]).map((f) => f.name)
		await evidence({ action: 'published', commit: 'c0ffee1234', files: names })
		const plan = (await evidence({ action: 'comment', to, login: 'anna' })).body
		expect(plan.body).toContain('responding on behalf of anna')
		expect(plan.body).toContain('in https://github.com/acme/api/pull/7')
		expect(plan.body).toContain(`![Orders page](https://github.com/acme/api/raw/c0ffee1234/${names[0]})`)
	})

	test('markdown: a video shows its GIF linked to the mp4, and a capture that was not pushed says where it is', () => {
		const item = (over: Partial<PublicEvidence>): PublicEvidence => ({
			id: 'e_1', kind: 'image', title: 'Checkout', label: null, note: null, url: '/evidence/t1/e_1.png', poster: null,
			bytes: 1, head: null, createdAt: 1, pushed: true, github: null, ...over
		})
		const md = evidenceMarkdown([
			item({ kind: 'video', title: 'Checkout flow', note: 'Card declined, then accepted', github: { url: 'https://g/raw/c/e_1.mp4', poster: 'https://g/raw/c/e_1-poster.jpg', clip: 'https://g/raw/c/e_1-clip.gif' } }),
			item({ title: 'Too large', kind: 'video', github: { url: null, poster: null, clip: null } })
		])
		expect(md).toContain('[![Checkout flow](https://g/raw/c/e_1-clip.gif)](https://g/raw/c/e_1.mp4)')
		expect(md).toContain('[the whole clip](https://g/raw/c/e_1.mp4) downloads as an mp4')
		expect(md).toContain('Card declined, then accepted')
		expect(md).toContain('_Too large: a video kept on the factory page, not pushed to GitHub._')
		expect(evidenceMarkdown([])).toBe('')
	})

	test('the web address of a repository is read from a PR URL and from each kind of remote', () => {
		expect(repoWebBase('https://github.com/acme/api/pull/7')).toBe('https://github.com/acme/api')
		expect(repoWebBase('https://github.com/acme/api.git')).toBe('https://github.com/acme/api')
		expect(repoWebBase('git@github.com:acme/api.git')).toBe('https://github.com/acme/api')
		expect(repoWebBase('ssh://git@ghe.example.com/acme/api')).toBe('https://ghe.example.com/acme/api')
		expect(repoWebBase('/srv/git/api.git')).toBeNull()
		expect(repoWebBase(null)).toBeNull()
	})
})

describe('the push', () => {
	const refs = () => git(repo.bare, 'for-each-ref', '--format=%(refname)')
	const REF = 'refs/factory/evidence/t1'

	test('files go to a ref outside refs/heads as one commit, and the checkout is left as it was', () => {
		const before = { head: git(repo.work, 'rev-parse', 'HEAD'), status: git(repo.work, 'status', '--porcelain'), main: git(repo.work, 'rev-parse', 'origin/main') }
		const first = pushEvidence(repo.work, REF, [{ name: 'e_1.png', path: shot('a.png') }], 'Evidence for an issue')
		expect(first.pushed).toBe(true)
		expect(refs().split('\n').sort()).toEqual(['refs/factory/evidence/t1', 'refs/heads/main'])
		expect(git(repo.bare, 'ls-tree', '--name-only', REF)).toBe('e_1.png')
		expect(git(repo.bare, 'rev-parse', REF)).toBe(first.commit)
		// The scratch checkout has a deleted file, a renamed file and a main behind its remote: none of it moves.
		expect(git(repo.work, 'rev-parse', 'HEAD')).toBe(before.head)
		expect(git(repo.work, 'status', '--porcelain')).toBe(before.status)
		expect(git(repo.work, 'rev-parse', 'origin/main')).toBe(before.main)
		expect(git(repo.work, 'branch', '--list', '--all').includes('evidence')).toBe(false)
	})

	test('a second push holds the whole set with the first as its parent; the same set pushes nothing', () => {
		const a = { name: 'e_1.png', path: shot('a.png') }
		const first = pushEvidence(repo.work, REF, [a], 'one')
		const jpg = join(h.dir, 'b.jpg')
		writeFileSync(jpg, 'not really a jpeg')
		const second = pushEvidence(repo.work, REF, [a, { name: 'e_2.jpg', path: jpg }], 'two')
		expect(second.pushed).toBe(true)
		expect(git(repo.bare, 'rev-parse', `${second.commit}^`)).toBe(first.commit)
		expect(git(repo.bare, 'ls-tree', '--name-only', REF).split('\n')).toEqual(['e_1.png', 'e_2.jpg'])
		// A URL of the first push still resolves: its commit is an ancestor of the ref.
		expect(git(repo.bare, 'cat-file', '-t', `${first.commit}:e_1.png`)).toBe('blob')
		const third = pushEvidence(repo.work, REF, [a, { name: 'e_2.jpg', path: jpg }], 'three')
		expect(third).toEqual({ commit: second.commit, pushed: false })
		// Another clone of the repository, as a colleague has it, pushes onto the same ref.
		const fourth = pushEvidence(repo.other, REF, [a], 'four')
		expect(git(repo.bare, 'rev-parse', `${fourth.commit}^`)).toBe(second.commit)
	})

	test('a branch is refused as the ref', () => {
		expect(() => pushEvidence(repo.work, 'refs/heads/evidence', [], 'x')).toThrow('not a ref outside refs/heads')
	})
})

describe('preparing a capture', () => {
	test('an image goes in as it is, and another kind of file is refused', () => {
		const path = shot('a.png')
		expect(prepare(path)).toMatchObject({ kind: 'image', file: path })
		expect(() => prepare(join(h.dir, 'notes.txt'))).toThrow('not an image')
	})

	test.skipIf(!hasFfmpeg)('a video becomes an mp4 with a still frame and a GIF', () => {
		const source = join(h.dir, 'take.webm')
		const made = Bun.spawnSync(['ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=duration=2:size=641x361:rate=10', source])
		expect(made.exitCode).toBe(0)
		const prepared = prepare(source)
		try {
			expect(prepared.kind).toBe('video')
			expect(prepared.file.endsWith('.mp4')).toBe(true)
			for (const path of [prepared.file, prepared.poster, prepared.clip]) expect(path && Bun.file(path).size > 0).toBe(true)
			// An odd-sized source still encodes: libx264 needs even sides.
			const size = Bun.spawnSync(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', prepared.file])
			expect(size.stdout.toString().trim()).toBe('640,360')
		} finally {
			prepared.cleanup()
		}
		expect(existsSync(prepared.file)).toBe(false)
	}, 30_000)
})

describe('the dev environment', () => {
	const preview = async () => (await as('/api/issue/status')).body.preview
	const sent = () => h.calls().filter((c) => c.args[1] === 'send')

	test('the page asks the thread once, and the thread reports the addresses', async () => {
		const asked = await h.call('POST', '/api/issues/t1/preview', { action: 'start' })
		expect(asked.status).toBe(200)
		expect(asked.body.preview.state).toBe('requested')
		expect(sent()).toHaveLength(1)
		expect(sent()[0]!.stdin).toContain('factory preview up')
		expect(sent()[0]!.args[2]).toBe('t1')
		await h.call('POST', '/api/issues/t1/preview', { action: 'start' })
		expect(sent()).toHaveLength(1)
		const up = await as('/api/issue/preview', { state: 'up', urls: [{ name: 'web', url: 'http://localhost:5173' }], head: 'abc1234' })
		expect(up.status).toBe(200)
		expect(await preview()).toMatchObject({ state: 'up', head: 'abc1234', urls: [{ name: 'web', url: 'http://localhost:5173' }] })
		expect((await h.call('GET', '/api/board')).body.issues[0].preview).toBe('up')
		const stop = await h.call('POST', '/api/issues/t1/preview', { action: 'stop' })
		expect(stop.body.preview).toMatchObject({ state: 'stopping', urls: [{ name: 'web' }] })
		expect(sent()[1]!.stdin).toContain('factory preview down')
		await as('/api/issue/preview', { state: 'down' })
		expect(await preview()).toMatchObject({ state: 'down', urls: [] })
	})

	test('an ask the thread cannot get is refused and leaves the state as it was', async () => {
		h.replies({ show: { code: 0, out: JSON.stringify({ thread: { status: 'completed' } }) }, send: { code: 1, out: 'thread is archived' } })
		const failed = await h.call('POST', '/api/issues/t1/preview', { action: 'start' })
		expect(failed.status).toBe(502)
		expect(await preview()).toBeNull()
		h.replies({ show: { code: 1 } })
		const gone = await h.call('POST', '/api/issues/t1/preview', { action: 'start' })
		expect(gone.status).toBe(409)
		expect(gone.body.error).toContain('cannot find')
		await as('/api/issue/close', { outcome: 'dropped', summary: 'x' })
		expect((await h.call('POST', '/api/issues/t1/preview', { action: 'start' })).status).toBe(409)
	})

	test('stopping is heard after the issue closed, and says nothing when nothing ran', async () => {
		const events = async () => ((await h.call('GET', '/api/issues/t1')).body.events as { kind: string }[]).filter((e) => e.kind === 'preview').length
		await as('/api/issue/preview', { state: 'down' })
		expect(await events()).toBe(0)
		await as('/api/issue/preview', { state: 'up', urls: [{ name: 'web', url: 'http://localhost:5173' }] })
		await as('/api/issue/close', { outcome: 'dropped', summary: 'x' })
		expect((await as('/api/issue/preview', { state: 'up', urls: [{ name: 'web', url: 'http://localhost:5173' }] })).status).toBe(409)
		expect((await as('/api/issue/preview', { state: 'down' })).status).toBe(200)
		expect((await as('/api/issue/status')).body.preview.state).toBe('down')
		expect(await events()).toBe(2)
	})

	test('a report must say what is up or why it failed', async () => {
		expect((await as('/api/issue/preview', { state: 'up', urls: [] })).body.error).toContain('at least one')
		expect((await as('/api/issue/preview', { state: 'up', urls: [{ name: 'web', url: 'javascript:alert(1)' }] })).body.error).toContain('not an http URL')
		expect((await as('/api/issue/preview', { state: 'failed' })).body.error).toContain('say why')
		await as('/api/issue/preview', { state: 'failed', error: 'Docker is not running' })
		expect(await preview()).toMatchObject({ state: 'failed', error: 'Docker is not running' })
	})

	test('the probe tells an address that answers from one that does not', async () => {
		const live = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('nope', { status: 404 }) })
		const dead = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response() })
		const deadUrl = `http://127.0.0.1:${dead.port}`
		dead.stop(true)
		try {
			expect((await h.call('GET', '/api/issues/t1/preview')).body.urls).toEqual([])
			await as('/api/issue/preview', { state: 'up', urls: [{ name: 'web', url: `http://127.0.0.1:${live.port}` }, { name: 'api', url: deadUrl }] })
			const probed = (await h.call('GET', '/api/issues/t1/preview')).body.urls as { name: string; ok: boolean }[]
			expect(probed.map((u) => [u.name, u.ok])).toEqual([['web', true], ['api', false]])
		} finally {
			live.stop(true)
		}
	})

	test("buncargo's url lines and --url flags are read into names and addresses", () => {
		expect(parseUrlLines('web            http://localhost:5173\nshopify admin  https://admin.example.test/store\n\nwarning: slow\n')).toEqual([
			{ name: 'web', url: 'http://localhost:5173' },
			{ name: 'shopify admin', url: 'https://admin.example.test/store' }
		])
		expect(parseUrlFlags(['web=http://localhost:3000/?a=b'])).toEqual([{ name: 'web', url: 'http://localhost:3000/?a=b' }])
		expect(() => parseUrlFlags(['http://localhost:3000'])).toThrow('<name>=<http url>')
		expect(() => parseUrlFlags(['web=localhost:3000'])).toThrow('<name>=<http url>')
	})

	test("buncargo's status names the primary app and the idle limit of a detached run", () => {
		const run = { detached: true, idleLimitMs: 7_200_000, primaryApp: 'web' }
		expect(parseRun(JSON.stringify({ runs: [run] }))).toEqual({ primary: 'web', idleMs: 7_200_000 })
		// A run in someone's terminal, and one started with --keep, have no idle limit.
		expect(parseRun(JSON.stringify({ runs: [{ ...run, detached: false }] }))).toEqual({ primary: 'web' })
		expect(parseRun(JSON.stringify({ runs: [{ detached: true, primaryApp: 'web' }] }))).toEqual({ primary: 'web' })
		expect(parseRun(JSON.stringify({ runs: [] }))).toEqual({})
		expect(parseRun('error: unknown option --json')).toEqual({})
		const urls = [{ name: 'api', url: 'http://localhost:3000' }, { name: 'web', url: 'http://localhost:5173' }]
		expect(primaryFirst(urls, 'web').map((u) => u.name)).toEqual(['web', 'api'])
		expect(primaryFirst(urls, 'expoApp')).toEqual(urls)
		expect(primaryFirst(urls)).toEqual(urls)
	})

	test('a loopback address moves to the host the page is read at, and no other address does', () => {
		const host = 'worker.tail1234.ts.net'
		expect(onHost('http://localhost:3000', host)).toBe('http://worker.tail1234.ts.net:3000')
		expect(onHost('http://127.0.0.1:5173/orders?tab=open', host)).toBe('http://worker.tail1234.ts.net:5173/orders?tab=open')
		expect(onHost('https://[::1]:8443/', host)).toBe('https://worker.tail1234.ts.net:8443/')
		expect(onHost('https://admin.example.test/store', host)).toBeNull()
		expect(onHost('http://localhost.example.test:3000', host)).toBeNull()
		// A page read on this machine keeps the address as given.
		expect(onHost('http://localhost:3000', '127.0.0.1')).toBeNull()
		expect(onHost('http://localhost:3000', null)).toBeNull()
	})
})

describe('commits and measurements in Markdown', () => {
	test('a commit links only when it is a commit and the repository is known', () => {
		expect(commitRef('abc1234def5678', 'https://github.com/acme/api')).toBe('[`abc1234def`](https://github.com/acme/api/commit/abc1234def5678)')
		expect(commitRef('abc1234')).toBe('`abc1234`')
		expect(commitRef('origin/main`](x)', 'https://github.com/acme/api')).toBe('`origin/mainx`')
	})

	test('a cell cannot open a column, and no rows means no table', () => {
		const measured = { how: 'Three runs.', base: 'ba5e123', head: 'abc1234', rows: [{ what: 'Cold | warm', before: '3 s', after: '1 s' }] }
		expect(measuredMarkdown(measured)).toContain('| Cold \\| warm | 3 s | 1 s |')
		expect(measuredMarkdown({ ...measured, rows: [] })).toBe('')
		expect(measuredMarkdown(undefined)).toBe('')
	})
})
