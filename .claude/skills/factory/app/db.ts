// The service's SQLite database. Only the server opens it. Migrations run in order at start, and
// `PRAGMA user_version` records how many have run.
import { Database } from 'bun:sqlite'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { defaults, type Resolved, type Settings, type Stage } from './settings.ts'

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
	);`,
	// One item is one open issue: close the duplicates an earlier race let in, keeping the oldest, so the
	// unique index can be built. Then the review on GitHub, waiting, checked results and the findings ledger.
	`update issues set state = 'closed', outcome = 'duplicate', closed_at = updated_at,
		summary = coalesce(summary, 'Closed as a duplicate of an older open issue for the same item')
		where state = 'open' and source is not null and exists (
			select 1 from issues o where o.repo = issues.repo and o.source = issues.source and o.state = 'open'
			and (o.created_at < issues.created_at or (o.created_at = issues.created_at and o.rowid < issues.rowid)));
	create unique index issues_open_source on issues (repo, source) where state = 'open' and source is not null;
	alter table issues add column pr_state text;
	alter table issues add column pr_read_error text;
	alter table issues add column pr_synced_by_thread integer;
	alter table issues add column pr_pokes integer not null default 0;
	alter table issues add column pr_poked_at integer;
	alter table issues add column waiting_on text check (waiting_on in ('checks', 'bots', 'review', 'merge', 'deploy'));
	alter table issues add column waiting_note text;
	alter table issues add column waiting_since integer;
	alter table issues add column thread_missing integer not null default 0;
	alter table issues add column risk_head text;
	alter table issues add column risk_rule text;
	alter table issues add column merge_cap text check (merge_cap in ('ask', 'never'));
	alter table runs add column result text;
	alter table runs add column head text;
	alter table decisions add column head text;
	alter table decisions add column round integer;
	create table pr_items (
		id text primary key,
		issue_id text not null references issues(id) on delete cascade,
		kind text not null check (kind in ('thread', 'review', 'comment')),
		path text,
		line integer,
		url text not null,
		state text not null,
		commit_sha text,
		truncated integer not null default 0,
		created_at integer not null,
		handled text check (handled in ('fixed', 'declined', 'answered', 'ignored')),
		handled_commit text,
		handled_note text,
		handled_at integer,
		seen_at integer
	);
	create index pr_items_issue on pr_items (issue_id);
	create table pr_comments (
		id text primary key,
		item_id text not null references pr_items(id) on delete cascade,
		author text not null,
		author_kind text not null check (author_kind in ('person', 'bot')),
		association text not null,
		trusted integer not null,
		by_factory integer not null default 0,
		body text not null,
		created_at integer not null,
		edited_at integer
	);
	create index pr_comments_item on pr_comments (item_id);
	create table pr_written (
		id text primary key,
		issue_id text not null references issues(id) on delete cascade
	);
	create table pr_rounds (
		issue_id text not null references issues(id) on delete cascade,
		n integer not null,
		started_at integer not null,
		start_head text not null,
		last_head text not null,
		pushes integer not null default 0,
		ended_at integer,
		primary key (issue_id, n)
	);
	create table findings (
		id text primary key,
		issue_id text not null references issues(id) on delete cascade,
		run_id text not null references runs(id) on delete cascade,
		subject text not null check (subject in ('plan', 'pr')),
		severity text not null check (severity in ('important', 'nit', 'pre-existing')),
		file text,
		line integer,
		title text,
		text text not null,
		outcome text check (outcome in ('fixed', 'declined', 'upheld', 'filed')),
		outcome_note text,
		outcome_run text references runs(id)
	);
	create index findings_issue on findings (issue_id);`,
	// What a reviewer looks at: the screenshots and videos of the change, and the dev environment to try it in.
	`alter table issues add column preview text;
	create table evidence (
		id text primary key,
		issue_id text not null references issues(id) on delete cascade,
		kind text not null check (kind in ('image', 'video')),
		title text not null,
		label text check (label in ('before', 'after')),
		note text,
		file text not null,
		poster text,
		clip text,
		bytes integer not null,
		head text,
		published text,
		created_at integer not null
	);
	create index evidence_issue on evidence (issue_id);`,
	// An issue can start from a PR that already exists, which it reviews or builds on.
	`alter table issues add column pr_taken text;`
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
	pr_state: string | null
	pr_read_error: string | null
	pr_synced_by_thread: number | null
	pr_pokes: number
	pr_poked_at: number | null
	waiting_on: 'checks' | 'bots' | 'review' | 'merge' | 'deploy' | null
	waiting_note: string | null
	waiting_since: number | null
	thread_missing: number
	risk_head: string | null
	risk_rule: string | null
	merge_cap: 'ask' | 'never' | null
	/** The dev environment a reviewer tries the change in, as JSON (`Preview` in evidence.ts). */
	preview: string | null
	/** The PR the issue started from, as JSON (`TakenPr` in takein.ts); null when the factory opens the PR. */
	pr_taken: string | null
}

/** One screenshot or video of the change. `file`, `poster` and `clip` are names in the issue's evidence folder. */
export type EvidenceRow = {
	id: string
	issue_id: string
	kind: 'image' | 'video'
	title: string
	label: 'before' | 'after' | null
	note: string | null
	file: string
	/** A still frame of a video. */
	poster: string | null
	/** A short GIF of a video, which GitHub shows inline where it cannot play an mp4. */
	clip: string | null
	bytes: number
	/** The commit the capture shows. */
	head: string | null
	/** Where it is on GitHub once pushed, as JSON `{ base, commit, files }`. */
	published: string | null
	created_at: number
}

export type ItemRow = {
	id: string
	issue_id: string
	kind: 'thread' | 'review' | 'comment'
	path: string | null
	line: number | null
	url: string
	state: string
	commit_sha: string | null
	truncated: number
	created_at: number
	handled: 'fixed' | 'declined' | 'answered' | 'ignored' | null
	handled_commit: string | null
	handled_note: string | null
	handled_at: number | null
	seen_at: number | null
}

export type CommentRow = {
	id: string
	item_id: string
	author: string
	author_kind: 'person' | 'bot'
	association: string
	trusted: number
	by_factory: number
	body: string
	created_at: number
	edited_at: number | null
}

export type RoundRow = {
	issue_id: string
	n: number
	started_at: number
	start_head: string
	last_head: string
	pushes: number
	ended_at: number | null
}

export type FindingRow = {
	id: string
	issue_id: string
	run_id: string
	subject: 'plan' | 'pr'
	severity: 'important' | 'nit' | 'pre-existing'
	file: string | null
	line: number | null
	title: string | null
	text: string
	outcome: 'fixed' | 'declined' | 'upheld' | 'filed' | null
	outcome_note: string | null
	outcome_run: string | null
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
	result: string | null
	head: string | null
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
	head: string | null
	round: number | null
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
	for (const table of ['pr_items', 'pr_written', 'pr_rounds', 'findings', 'evidence']) {
		db.query(`delete from ${table} where issue_id in (${old})`).run({ before })
	}
	db.query(`delete from runs where issue_id in (${old})`).run({ before })
}

/** An issue's settings as stored at start, with the default of every key added since, so a new key never
 * breaks an issue that started before it existed. */
export function parseResolved(issue: IssueRow): Resolved {
	const stored = JSON.parse(issue.settings) as Partial<Resolved>
	const settings = { ...defaults, ...stored.settings } as Settings
	settings.stages = { ...defaults.stages, ...stored.settings?.stages }
	return { settings, sources: stored.sources ?? {} }
}
