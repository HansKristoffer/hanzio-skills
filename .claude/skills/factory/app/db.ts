// The service's SQLite database. Only the server opens it. Migrations run in order at start, and
// `PRAGMA user_version` records how many have run.
import { Database } from 'bun:sqlite'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Resolved, Stage } from './settings.ts'

export const MIGRATIONS = [
	`create table issues (
		id text primary key,
		title text not null,
		body text,
		kind text check (kind in ('bug', 'feature')),
		repo text not null,
		root text not null,
		source text,
		thread_link text,
		settings text not null,
		config_error text,
		state text not null default 'open' check (state in ('open', 'shipped', 'closed')),
		outcome text,
		deploy text check (deploy in ('verified', 'unverified', 'none')),
		summary text,
		report text,
		pr_url text,
		nudges integer not null default 0,
		nudged_at integer,
		created_at integer not null,
		updated_at integer not null,
		closed_at integer
	);
	create index issues_source on issues (repo, source);
	create table runs (
		id text primary key,
		issue_id text not null references issues(id) on delete cascade,
		stage text not null check (stage in ('research', 'plan', 'implement', 'review', 'land')),
		subject text check (subject in ('plan', 'pr')),
		thread_id text,
		provider text,
		model text,
		options text,
		state text not null default 'running' check (state in ('running', 'done', 'failed')),
		summary text,
		started_at integer not null,
		ended_at integer
	);
	create index runs_issue on runs (issue_id);
	create table events (
		id integer primary key autoincrement,
		issue_id text not null references issues(id) on delete cascade,
		run_id text references runs(id) on delete cascade,
		at integer not null,
		kind text not null,
		text text not null
	);
	create index events_issue on events (issue_id, id);
	create table decisions (
		id text primary key,
		issue_id text not null references issues(id) on delete cascade,
		kind text not null check (kind in ('plan', 'question', 'blocked', 'merge')),
		provisional integer not null default 0,
		question text not null,
		body text,
		recommendation text not null,
		options text,
		answer text,
		answered_via text check (answered_via in ('page', 'thread')),
		delivery text check (delivery in ('held', 'sending', 'sent', 'failed')),
		asked_at integer not null,
		answered_at integer
	);
	create index decisions_issue on decisions (issue_id);
	create table settings (
		scope text primary key,
		value text not null
	);`
]

export const MAX_EVENT = 2000
const RETENTION_DAYS = 90

export type IssueRow = {
	id: string
	title: string
	body: string | null
	kind: 'bug' | 'feature' | null
	repo: string
	root: string
	source: string | null
	thread_link: string | null
	settings: string
	config_error: string | null
	state: 'open' | 'shipped' | 'closed'
	outcome: string | null
	deploy: string | null
	summary: string | null
	report: string | null
	pr_url: string | null
	nudges: number
	nudged_at: number | null
	created_at: number
	updated_at: number
	closed_at: number | null
}

export type RunRow = {
	id: string
	issue_id: string
	stage: Stage
	subject: 'plan' | 'pr' | null
	thread_id: string | null
	provider: string | null
	model: string | null
	options: string | null
	state: 'running' | 'done' | 'failed'
	summary: string | null
	started_at: number
	ended_at: number | null
}

export type DecisionRow = {
	id: string
	issue_id: string
	kind: 'plan' | 'question' | 'blocked' | 'merge'
	provisional: number
	question: string
	body: string | null
	recommendation: string
	options: string | null
	answer: string | null
	answered_via: 'page' | 'thread' | null
	delivery: 'held' | 'sending' | 'sent' | 'failed' | null
	asked_at: number
	answered_at: number | null
}

export type EventRow = { id: number; issue_id: string; run_id: string | null; at: number; kind: string; text: string }

export const randomId = (prefix: string) => `${prefix}_${crypto.randomUUID().replaceAll('-', '').slice(0, 8)}`

export function openDatabase(home: string, migrations = MIGRATIONS) {
	mkdirSync(home, { recursive: true })
	const db = new Database(join(home, 'factory.db'), { create: true, strict: true })
	db.run('pragma journal_mode = wal')
	db.run('pragma foreign_keys = on')
	db.run('pragma busy_timeout = 5000')
	const current = (db.query('pragma user_version').get() as { user_version: number }).user_version
	for (let i = current; i < migrations.length; i++) {
		db.transaction(() => {
			db.run(migrations[i] as string)
			db.run(`pragma user_version = ${i + 1}`)
		})()
	}
	return db
}

/** Answers that were being sent when the server stopped may or may not have arrived: offer them again. */
export function settleDeliveries(db: Database) {
	db.run(`update decisions set delivery = 'failed' where delivery = 'sending'`)
}

/** Drops the timeline of issues closed long ago. The issue row stays, so its source is still known. */
export function pruneOld(db: Database, now = Date.now()) {
	const before = now - RETENTION_DAYS * 24 * 60 * 60 * 1000
	const old = `select id from issues where state != 'open' and closed_at < $before`
	db.query(`delete from events where issue_id in (${old})`).run({ before })
	db.query(`delete from decisions where issue_id in (${old})`).run({ before })
	db.query(`delete from runs where issue_id in (${old})`).run({ before })
}

export const parseResolved = (issue: IssueRow) => JSON.parse(issue.settings) as Resolved
