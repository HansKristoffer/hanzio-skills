import { afterEach, beforeEach, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { SKILL_DIR } from './env.ts'
import { git, pushFile, scratchRepo, setup, type Harness } from './fixtures/harness.ts'
import { parseConfig } from './git.ts'

let h: Harness
let repo: ReturnType<typeof scratchRepo>

beforeEach(() => {
	h = setup()
	repo = scratchRepo(h.dir)
})
afterEach(() => h.close())

const start = (thread: string) => h.as(thread)('POST', '/api/issue/start', { cwd: repo.work, title: 'x' })

test('the file on the default branch beats global, and this machine beats the file', async () => {
	pushFile(repo.other, 'factory.config.yaml', 'reviewRounds: 3\nstages:\n  review:\n    note: Check the migrations.\n')
	await h.call('PUT', '/api/settings/global', { reviewRounds: 1 })
	let resolved = await h.call('POST', '/api/settings/resolve', { cwd: repo.work })
	expect(resolved.body.settings.reviewRounds).toBe(3)
	expect(resolved.body.sources.reviewRounds).toBe('file')
	expect(resolved.body.settings.stages.review.note).toBe('Check the migrations.')

	await h.call('PUT', '/api/settings/repo:acme/api', { reviewRounds: 0 })
	resolved = await h.call('POST', '/api/settings/resolve', { cwd: repo.work })
	expect(resolved.body.settings.reviewRounds).toBe(0)
	expect(resolved.body.sources.reviewRounds).toBe('repo')

	await h.call('PUT', '/api/settings/repo:acme/api', {})
	resolved = await h.call('POST', '/api/settings/resolve', { cwd: repo.work })
	expect(resolved.body.settings.reviewRounds).toBe(3)
})

test("a file only on the thread's own branch is not read", async () => {
	git(repo.work, 'checkout', '-q', '-b', 'factory/x')
	await Bun.write(join(repo.work, 'factory.config.yaml'), 'reviewRounds: 5\n')
	git(repo.work, 'add', '.')
	git(repo.work, 'commit', '-q', '-m', 'local config')
	const resolved = await h.call('POST', '/api/settings/resolve', { cwd: repo.work })
	expect(resolved.body.settings.reviewRounds).toBe(2)
	expect(resolved.body.sources.reviewRounds).toBe('default')
})

test('an issue keeps the file it started with until it starts again', async () => {
	pushFile(repo.other, 'factory.config.yaml', 'reviewRounds: 3\n')
	await start('t1')
	pushFile(repo.other, 'factory.config.yaml', 'reviewRounds: 4\n')
	await start('t2')
	expect((await h.as('t1')('POST', '/api/issue/status', {})).body.settings.reviewRounds).toBe(3)
	expect((await h.as('t2')('POST', '/api/issue/status', {})).body.settings.reviewRounds).toBe(4)
	await start('t1')
	expect((await h.as('t1')('POST', '/api/issue/status', {})).body.settings.reviewRounds).toBe(4)
})

test('a broken file is never half-applied', async () => {
	const cases = [
		['stages:\n  reviw:\n    note: x\nreviewRounds: 4\n', 'stages.reviw: unknown key'],
		['foo: [\n', 'factory.config.yaml:'],
		['Just some prose about the project.\n', 'must be a mapping']
	]
	for (const [index, [text, message]] of cases.entries()) {
		pushFile(repo.other, 'factory.config.yaml', text!)
		const res = await start(`broken-${index}`)
		expect(res.body.configError).toContain('factory.config.yaml')
		expect(res.body.configError).toContain(message!)
		expect(res.body.settings.reviewRounds).toBe(2)
		const issue = await h.call('GET', `/api/issues/broken-${index}`)
		expect(issue.body.issue.configError).toContain(message!)
	}
})

test('an empty file is no file and no error', () => {
	expect(parseConfig('')).toEqual({ file: null })
	expect(parseConfig('# only a comment\n')).toEqual({ file: null })
})

test('the page sees the file read-only beside this machine\'s settings', async () => {
	pushFile(repo.other, 'factory.config.yaml', 'planApproval: always\n')
	await start('t1')
	await h.call('PUT', '/api/settings/repo:acme/api', { reviewRounds: 1 })
	const view = await h.call('GET', '/api/settings')
	const api = view.body.repos['acme/api']
	expect(api.file).toEqual({ planApproval: 'always' })
	expect(api.page).toEqual({ reviewRounds: 1 })
	expect(api.resolved.sources.planApproval).toBe('file')
	expect(api.resolved.sources.reviewRounds).toBe('repo')
})

test('the example in references/config.md is valid', () => {
	const doc = readFileSync(join(SKILL_DIR, 'references', 'config.md'), 'utf8')
	const yaml = doc.match(/```yaml\n([\s\S]*?)```/)?.[1]
	expect(yaml).toBeTruthy()
	const read = parseConfig(yaml!)
	expect(read.error).toBeUndefined()
	expect(read.file?.stages?.review?.model).toBe('gpt-6-astra')
})
