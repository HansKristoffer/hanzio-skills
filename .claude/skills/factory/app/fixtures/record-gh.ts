#!/usr/bin/env bun
// Records what `readPr` reads from a real PR as a fixture, with logins, bodies, URLs and ids replaced,
// so the tests run on GitHub's real shapes. Usage: bun fixtures/record-gh.ts <pr-url> <name>
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { readPr } from '../gh.ts'

const [url, name] = process.argv.slice(2)
if (!url || !name) throw new Error('usage: bun fixtures/record-gh.ts <pr-url> <name>')
const raw = await readPr(url)

const people = new Map<string, string>()
const person = (login: string) => {
	if (!people.has(login)) people.set(login, `person-${people.size + 1}`)
	return people.get(login)!
}
let n = 0
const ids = new Map<string, string>()
const id = (value: string) => {
	if (!ids.has(value)) ids.set(value, `ID_${++n}`)
	return ids.get(value)!
}

function scrub(value: unknown, key = ''): unknown {
	if (Array.isArray(value)) return value.map((v) => scrub(v, key))
	if (value && typeof value === 'object') {
		const record = value as Record<string, unknown>
		const bot = record.__typename === 'Bot' || record.is_bot === true
		return Object.fromEntries(
			Object.entries(record).map(([k, v]) => {
				if (k === 'login' && typeof v === 'string') return [k, bot ? v : person(v)]
				if (k === 'name' && 'login' in record) return [k, 'A Person']
				return [k, scrub(v, k)]
			})
		)
	}
	if (typeof value !== 'string') return value
	if (key === 'body') return value ? `body ${id(value)}${value.includes('<!-- factory:') ? ' <!-- factory:x -->' : ''}` : ''
	if (key === 'id') return id(value)
	if (key === 'url' || key === 'detailsUrl') return `https://github.com/acme/api/pull/1#${id(value)}`
	if (key === 'path') return `src/file-${id(value)}.ts`
	return value
}

// The repository's own name shows up in rule sources and check names.
const [, owner, repo] = url.match(/github\.com\/([^/]+)\/([^/]+)/)!
const text = JSON.stringify(scrub(raw), null, '\t')
	.replace(new RegExp(`${owner}/${repo}`, 'gi'), 'acme/api')
	.replace(new RegExp(owner!, 'gi'), 'acme')
	.replace(new RegExp(repo!.replace(/-v\d+$/, ''), 'gi'), 'api')
const file = join(import.meta.dir, 'gh', `${name}.json`)
writeFileSync(file, `${text}\n`)
console.log(`wrote ${file}: ${raw.threads.length} threads, ${raw.reviews.length} reviews, ${raw.comments.length} comments`)
