// The webhook the service posts to when something changes, above all when a person has to act. Each post is
// kept in an outbox table until the receiver answers 2xx, so a receiver that is down, or a restart of the
// service, loses nothing; a post is given up after MAX_ATTEMPTS.
import type { Database } from 'bun:sqlite'
import { createHmac, randomBytes } from 'node:crypto'

/** What the webhook can be told. `decision` and `stuck` are the ones a person has to act on. */
export const WEBHOOK_EVENTS = ['decision', 'question', 'stuck', 'started', 'pr', 'closed', 'test'] as const
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number]
export const DEFAULT_EVENTS: WebhookEvent[] = ['decision', 'stuck']

/** `events` is `['*']` for every event, including any added later. */
export type WebhookConfig = { url: string; events: (WebhookEvent | '*')[]; secret: string; createdAt: number }

export type DeliveryRow = {
	id: string
	event: string
	issue_id: string | null
	payload: string
	attempts: number
	next_at: number
	state: 'pending' | 'sent' | 'failed'
	last_status: number | null
	last_error: string | null
	created_at: number
	sent_at: number | null
}

export const SIGNATURE_HEADER = 'x-factory-signature-256'
/** Waits between tries: the first try is at once, the last about four hours after the event. */
const BACKOFF_MS = [30_000, 2 * 60_000, 10 * 60_000, 30 * 60_000, 3 * 60 * 60_000]
export const MAX_ATTEMPTS = BACKOFF_MS.length + 1
const TIMEOUT_MS = 10_000
const KEEP_MS = 7 * 24 * 60 * 60 * 1000
const SCOPE = 'webhook'

export const sign = (secret: string, body: string) => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`
export const newSecret = () => randomBytes(32).toString('hex')

/** Checks what the MCP or the API gives as the webhook. Throws with every field that is wrong. */
export function parseWebhook(input: Record<string, unknown>, before: WebhookConfig | null, now = Date.now()): WebhookConfig {
	const problems: string[] = []
	const url = input.url ?? before?.url
	if (typeof url !== 'string' || !url) problems.push('url is required')
	else {
		let parsed: URL | null = null
		try {
			parsed = new URL(url)
		} catch {
			problems.push(`url: ${url} is not a URL`)
		}
		if (parsed && parsed.protocol !== 'https:' && parsed.protocol !== 'http:') problems.push(`url: ${url} is not http or https`)
		if (url.length > 2000) problems.push('url is longer than 2000 characters')
	}
	let events: WebhookConfig['events'] = before?.events ?? DEFAULT_EVENTS
	if (input.events !== undefined) {
		if (!Array.isArray(input.events) || !input.events.length) problems.push('events: give a list of at least one event')
		else {
			const unknown = input.events.filter((e) => e !== '*' && !WEBHOOK_EVENTS.includes(e as WebhookEvent))
			if (unknown.length) problems.push(`events: ${unknown.map(String).join(', ')} is not one of ${WEBHOOK_EVENTS.filter((e) => e !== 'test').join(', ')} or *`)
			events = input.events.includes('*') ? ['*'] : [...new Set(input.events as WebhookEvent[])].filter((e) => e !== 'test')
		}
	}
	let secret = before?.secret
	if (input.secret !== undefined) {
		if (typeof input.secret !== 'string' || input.secret.length < 16) problems.push('secret: give at least 16 characters, or leave it out for a new one')
		else secret = input.secret
	} else if (!secret || input.rotateSecret === true) {
		secret = newSecret()
	}
	if (problems.length) throw new Error(problems.join('; '))
	return { url: url as string, events, secret: secret!, createdAt: before?.createdAt ?? now }
}

export function createWebhook(db: Database, fetcher: typeof fetch = globalThis.fetch) {
	let flushing: Promise<void> | null = null

	const config = () => {
		const row = db.query('select value from settings where scope = $scope').get({ scope: SCOPE }) as { value: string } | null
		return row ? (JSON.parse(row.value) as WebhookConfig) : null
	}

	function set(next: WebhookConfig | null) {
		if (!next) {
			db.query('delete from settings where scope = $scope').run({ scope: SCOPE })
			// Nothing is left to send them to.
			db.run(`update webhook_deliveries set state = 'failed', last_error = 'the webhook was removed' where state = 'pending'`)
			return
		}
		db.query('insert into settings (scope, value) values ($scope, $value) on conflict (scope) do update set value = $value').run({
			scope: SCOPE,
			value: JSON.stringify(next)
		})
	}

	/** Queues a post when the webhook takes this event, and starts sending. */
	function enqueue(event: WebhookEvent, issueId: string | null, payload: Record<string, unknown>, now = Date.now()) {
		const hook = config()
		if (!hook || (event !== 'test' && !hook.events.includes('*') && !hook.events.includes(event))) return null
		const id = `wh_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`
		const body = { id, event, at: now, ...payload }
		db.query(
			`insert into webhook_deliveries (id, event, issue_id, payload, next_at, created_at)
			values ($id, $event, $issue, $payload, $now, $now)`
		).run({ id, event, issue: issueId, payload: JSON.stringify(body), now })
		void flush().catch(() => {})
		return id
	}

	async function attempt(row: DeliveryRow, hook: WebhookConfig, now: number) {
		let status: number | null = null
		let error: string | null = null
		try {
			const res = await fetcher(hook.url, {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					'user-agent': 'factory-webhook',
					'x-factory-event': row.event,
					'x-factory-delivery': row.id,
					[SIGNATURE_HEADER]: sign(hook.secret, row.payload)
				},
				body: row.payload,
				redirect: 'manual',
				signal: AbortSignal.timeout(TIMEOUT_MS)
			})
			status = res.status
			if (!res.ok) error = `answered ${res.status}: ${(await res.text().catch(() => '')).slice(0, 300)}`
		} catch (e) {
			error = (e as Error).message.slice(0, 300)
		}
		const attempts = row.attempts + 1
		if (!error) {
			db.query(`update webhook_deliveries set state = 'sent', attempts = $attempts, last_status = $status, last_error = null, sent_at = $now where id = $id`).run({
				attempts,
				status,
				now,
				id: row.id
			})
			return
		}
		const done = attempts >= MAX_ATTEMPTS
		db.query(
			`update webhook_deliveries set state = $state, attempts = $attempts, last_status = $status, last_error = $error, next_at = $next where id = $id`
		).run({
			state: done ? 'failed' : 'pending',
			attempts,
			status,
			error,
			next: done ? row.next_at : now + BACKOFF_MS[attempts - 1]!,
			id: row.id
		})
	}

	/** Sends every post that is due, oldest first, one at a time. A refused post waits for its next try
	 * without holding back the posts behind it. */
	async function sendDue(now: () => number) {
		db.query(`delete from webhook_deliveries where created_at < $before and state != 'pending'`).run({ before: now() - KEEP_MS })
		for (;;) {
			const hook = config()
			if (!hook) return
			const due = db
				.query(`select * from webhook_deliveries where state = 'pending' and next_at <= $now order by created_at, rowid limit 1`)
				.get({ now: now() }) as DeliveryRow | null
			if (!due) return
			await attempt(due, hook, now())
		}
	}

	/** One send at a time: a call while one runs waits for it. `.finally` runs after the assignment, so
	 * `flushing` is cleared even when there was nothing to send. */
	function flush(now = () => Date.now()): Promise<void> {
		if (flushing) return flushing
		flushing = sendDue(now).finally(() => {
			flushing = null
		})
		return flushing
	}

	/** Sends a post that was given up again, from its first try. */
	function retry(id: string) {
		const row = db.query('select state from webhook_deliveries where id = $id').get({ id }) as { state: string } | null
		if (!row) throw new Error(`no webhook post ${id}`)
		if (row.state !== 'failed') throw new Error(`webhook post ${id} is ${row.state}, not failed: only a post that was given up is sent again`)
		db.query(`update webhook_deliveries set state = 'pending', attempts = 0, next_at = $now where id = $id`).run({ now: Date.now(), id })
		void flush().catch(() => {})
		return true
	}

	/** One post as it was sent, for debugging a receiver. */
	function delivery(id: string) {
		const row = db.query('select * from webhook_deliveries where id = $id').get({ id }) as DeliveryRow | null
		if (!row) throw new Error(`no webhook post ${id}`)
		return { id: row.id, event: row.event, state: row.state, attempts: row.attempts, lastStatus: row.last_status, lastError: row.last_error, body: JSON.parse(row.payload) }
	}

	/** The webhook as the MCP shows it: never the secret, which is shown only when it is set or rotated. */
	function view(limit = 20, issue?: string) {
		const hook = config()
		const recent = db
			.query('select * from webhook_deliveries where $issue is null or issue_id = $issue order by created_at desc, rowid desc limit $limit')
			.all({ limit, issue: issue ?? null }) as DeliveryRow[]
		return {
			webhook: hook ? { url: hook.url, events: hook.events, signatureHeader: SIGNATURE_HEADER, createdAt: hook.createdAt } : null,
			available: WEBHOOK_EVENTS.filter((e) => e !== 'test'),
			pending: (db.query(`select count(*) as n from webhook_deliveries where state = 'pending'`).get() as { n: number }).n,
			recent: recent.map((r) => ({
				id: r.id,
				event: r.event,
				issue: r.issue_id,
				state: r.state,
				attempts: r.attempts,
				lastStatus: r.last_status,
				lastError: r.last_error,
				createdAt: r.created_at,
				sentAt: r.sent_at,
				...(r.state === 'pending' && { nextAt: r.next_at })
			}))
		}
	}

	return { config, set, enqueue, flush, retry, delivery, view }
}

export type Webhook = ReturnType<typeof createWebhook>
