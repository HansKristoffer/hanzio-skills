// Listens to T3 Code's MCP events (SEP-3415) for `thread.run_settled`, so the service hears the moment a thread's
// turn ends instead of finding out on its next sweep. The sweep stays as the safety net: when the stream is down,
// nothing is lost but speed.
//
// T3 Code serves events only to an MCP client signed in with OAuth. The service signs itself in with no browser:
// it registers a client, mints a one-time read-only code with `t3 auth pairing create` (which only the host can
// do), approves its own request with it, and exchanges the code for a token. T3 Code gives no refresh token and
// the session lasts 30 days, so the service signs in again before it runs out, or when T3 Code says the token is
// no longer good. Observed on 0.1.12-nightly.20261123: the endpoints below, and events only on the stateless
// protocol revision (2026-07-28), with `Mcp-Name` required.
import type { Database } from 'bun:sqlite'
import { createHash, randomBytes } from 'node:crypto'
import { pairingCode, t3Origin } from './t3.ts'

const SCOPE = 't3-events'
const VERSION = '2026-07-28'
const EVENT = 'thread.run_settled'
const LABEL = 'Factory service'
/** Sign in again when the session has less than this left. */
const RENEW_MS = 3 * 24 * 60 * 60 * 1000
const HEARTBEAT_MS = 30_000
/** Waits between tries after a failure, doubling up to the cap. */
const RETRY_MS = { first: 1_000, max: 60_000 }
/** A T3 Code that serves no events is asked again this often, since an update can add them. */
const UNSUPPORTED_RETRY_MS = 10 * 60 * 1000

type Stored = {
	origin: string
	clientId: string
	redirectUri: string
	token: string | null
	expiresAt: number | null
	cursor: string | null
}

/** What the stream tells the service: a turn ended in this thread, a child of `parentThreadId` when it has one. */
export type Settled = { threadId: string | null; parentThreadId: string | null; outcome: string; occurredAt: string }

export type T3EventsState = 'off' | 'starting' | 'live' | 'retrying' | 'unsupported'
export type T3EventsStatus = { state: T3EventsState; since: number; error: string | null; signedInUntil: number | null; lastEventAt: number | null }

class Unauthorized extends Error {}
class Unsupported extends Error {}

export type T3EventsOptions = {
	db: Database
	/** The service's own address, named as the sign-in's redirect; T3 Code never calls it. */
	redirectUri: string
	onSettled: (event: Settled) => void
	/** Events may have been missed: T3 Code restarted, or the stream was down longer than its buffer holds. */
	onGap: () => void
	fetcher?: typeof fetch
	now?: () => number
}

export function createT3Events(options: T3EventsOptions) {
	const fetcher = options.fetcher ?? globalThis.fetch
	const now = options.now ?? Date.now
	const { db } = options
	let status: T3EventsStatus = { state: 'off', since: now(), error: null, signedInUntil: null, lastEventAt: null }
	let stopped = true
	let abort: AbortController | null = null
	let wake: (() => void) | null = null

	const setState = (state: T3EventsState, error: string | null = null) => {
		if (status.state !== state || status.error !== error) status = { ...status, state, since: now(), error }
	}

	const load = () => {
		const row = db.query('select value from settings where scope = $scope').get({ scope: SCOPE }) as { value: string } | null
		return row ? (JSON.parse(row.value) as Stored) : null
	}
	const save = (stored: Stored) => {
		db.query('insert into settings (scope, value) values ($scope, $value) on conflict (scope) do update set value = $value').run({
			scope: SCOPE,
			value: JSON.stringify(stored)
		})
		status = { ...status, signedInUntil: stored.token ? stored.expiresAt : null }
	}

	/** A signed-in session with time left, signing in again when it has too little. */
	async function session(): Promise<Stored> {
		const origin = t3Origin()
		if (!origin) throw new Unsupported('T3 Code is not running on this machine')
		const stored = load()
		if (stored?.origin === origin && stored.token && stored.expiresAt && stored.expiresAt - now() > RENEW_MS) return stored
		return signIn(origin, stored?.origin === origin ? stored : null)
	}

	async function signIn(origin: string, before: Stored | null): Promise<Stored> {
		const json = async (res: Response, what: string) => {
			const text = await res.text()
			if (res.status === 404) throw new Unsupported(`T3 Code at ${origin} has no ${what}`)
			if (!res.ok) throw new Error(`${what} answered ${res.status}: ${text.slice(0, 200)}`)
			return JSON.parse(text) as Record<string, unknown>
		}
		const post = (path: string, body: unknown, form = false) =>
			fetcher(`${origin}${path}`, {
				method: 'POST',
				headers: { 'content-type': form ? 'application/x-www-form-urlencoded' : 'application/json' },
				body: form ? new URLSearchParams(body as Record<string, string>) : JSON.stringify(body),
				signal: AbortSignal.timeout(15_000)
			})

		// A client the same T3 Code registered before is used again, so sign-ins do not pile up clients.
		let clientId = before?.redirectUri === options.redirectUri ? before.clientId : null
		if (!clientId) {
			const client = await json(
				await post('/oauth/mcp/register', { client_name: LABEL, redirect_uris: [options.redirectUri], token_endpoint_auth_method: 'none' }),
				'MCP sign-in'
			)
			clientId = String(client.client_id)
		}
		const verifier = randomBytes(32).toString('base64url')
		const authorization = {
			response_type: 'code',
			client_id: clientId,
			redirect_uri: options.redirectUri,
			code_challenge: createHash('sha256').update(verifier).digest('base64url'),
			code_challenge_method: 'S256',
			state: randomBytes(16).toString('base64url'),
			resource: `${origin}/mcp`
		}
		const code = await pairingCode(LABEL)
		const decided = await json(await post('/oauth/mcp/decision', { authorization, decision: { _tag: 'pairing-code', access: 'read-only', code } }), 'MCP approval')
		const redirect = new URL(String(decided.redirectTo))
		const granted = redirect.searchParams.get('code')
		if (!granted || redirect.searchParams.get('state') !== authorization.state) {
			throw new Error(`T3 Code did not approve the sign-in: ${redirect.searchParams.get('error') ?? 'no code came back'}`)
		}
		const token = await json(
			await post(
				'/oauth/mcp/token',
				{ grant_type: 'authorization_code', code: granted, redirect_uri: options.redirectUri, client_id: clientId, code_verifier: verifier, resource: authorization.resource },
				true
			),
			'MCP token'
		)
		const stored: Stored = {
			origin,
			clientId,
			redirectUri: options.redirectUri,
			token: String(token.access_token),
			expiresAt: now() + Number(token.expires_in) * 1000,
			// A cursor from another T3 Code means nothing to this one.
			cursor: before?.origin === origin ? before.cursor : null
		}
		save(stored)
		// The session it replaces is ended, so T3 Code's list of sessions shows one for the service.
		if (before?.token) void post('/oauth/mcp/revoke', { token: before.token }, true).catch(() => {})
		return stored
	}

	/** Holds one stream open until it ends, fails, or goes silent for three heartbeats. */
	async function listen(stored: Stored) {
		abort = new AbortController()
		const controller = abort
		const meta = {
			'io.modelcontextprotocol/protocolVersion': VERSION,
			'io.modelcontextprotocol/clientCapabilities': { extensions: { 'io.modelcontextprotocol/events': {} } },
			'io.modelcontextprotocol/clientInfo': { name: 'factory', version: '1' }
		}
		const res = await fetcher(`${stored.origin}/mcp`, {
			method: 'POST',
			signal: controller.signal,
			headers: {
				authorization: `Bearer ${stored.token}`,
				'content-type': 'application/json',
				accept: 'application/json, text/event-stream',
				'mcp-protocol-version': VERSION,
				'mcp-method': 'events/stream',
				'mcp-name': EVENT
			},
			body: JSON.stringify({
				jsonrpc: '2.0',
				id: 1,
				method: 'events/stream',
				// Subagent threads too: a stage's child is one, and its turn ending is what wakes the issue's thread.
				params: { name: EVENT, arguments: { includeSubagentChildren: true }, cursor: stored.cursor, heartbeatMs: HEARTBEAT_MS, _meta: meta }
			})
		})
		if (res.status === 401 || res.status === 403) throw new Unauthorized(`T3 Code answered ${res.status} to the token`)
		if (!(res.headers.get('content-type') ?? '').toLowerCase().startsWith('text/event-stream')) {
			const body = (await res.json().catch(() => ({}))) as { error?: { code?: number; message?: string } }
			const code = body.error?.code
			const message = body.error?.message ?? `answered ${res.status}`
			// No such method or event type, or not this protocol revision: this T3 Code serves no events.
			if (code === -32601 || code === -32023 || code === -32022 || res.status === 404) throw new Unsupported(`T3 Code serves no ${EVENT} events: ${message}`)
			if (code === -32024) throw new Unauthorized(message)
			throw new Error(`events/stream: ${message}`)
		}

		let heartbeat = HEARTBEAT_MS
		let watchdog: Timer | undefined
		const alive = () => {
			clearTimeout(watchdog)
			watchdog = setTimeout(() => controller.abort(), heartbeat * 3)
		}
		const keep = (cursor: unknown) => {
			if (typeof cursor !== 'string' && cursor !== null) return
			stored.cursor = cursor
			save(stored)
		}
		alive()
		const reader = res.body!.getReader()
		const decoder = new TextDecoder()
		let buffer = ''
		try {
			for (;;) {
				const { value, done } = await reader.read()
				if (done) return
				buffer += decoder.decode(value, { stream: true })
				for (let end = buffer.indexOf('\n\n'); end >= 0; end = buffer.indexOf('\n\n')) {
					const frame = buffer.slice(0, end)
					buffer = buffer.slice(end + 2)
					const data = frame
						.split('\n')
						.filter((line) => line.startsWith('data:'))
						.map((line) => line.slice(5).trimStart())
						.join('\n')
					if (!data) continue
					alive()
					const message = JSON.parse(data) as { method?: string; result?: unknown; params?: Record<string, any> }
					const params = message.params ?? {}
					switch (message.method) {
						case 'notifications/events/active':
							if (typeof params.heartbeatMs === 'number' && params.heartbeatMs > 0) heartbeat = params.heartbeatMs
							alive()
							keep(params.cursor)
							setState('live')
							if (params.truncated) options.onGap()
							break
						case 'notifications/events/event': {
							keep(params.cursor)
							status = { ...status, lastEventAt: now() }
							const event = (params.data ?? {}) as Record<string, unknown>
							const text = (key: string) => (typeof event[key] === 'string' ? (event[key] as string) : null)
							options.onSettled({ threadId: text('threadId'), parentThreadId: text('parentThreadId'), outcome: text('outcome') ?? '', occurredAt: text('occurredAt') ?? '' })
							break
						}
						case 'notifications/events/heartbeat':
							keep(params.cursor)
							break
						case 'notifications/events/terminated': {
							const error = params.error as { code?: number; message?: string } | undefined
							if (error?.code === -32024) throw new Unauthorized(error.message ?? 'Forbidden')
							throw new Error(`T3 Code ended the stream: ${error?.message ?? 'no reason given'}`)
						}
						default:
							// notifications/events/error is a single failure T3 Code retries itself; the final result
							// frame comes right before the stream ends.
							break
					}
				}
			}
		} finally {
			clearTimeout(watchdog)
			void reader.cancel().catch(() => {})
		}
	}

	/** Waits `ms`, or less when stop() is called. */
	const pause = (ms: number) =>
		new Promise<void>((done) => {
			const timer = setTimeout(done, ms)
			wake = () => {
				clearTimeout(timer)
				done()
			}
		})

	async function loop() {
		let retry = RETRY_MS.first
		while (!stopped) {
			try {
				if (status.state !== 'live') setState(status.state === 'off' ? 'starting' : status.state, status.error)
				await listen(await session())
				// The stream ended cleanly, as when T3 Code restarts: connect again after a moment.
				retry = RETRY_MS.first
				if (stopped) break
				setState('retrying', 'the stream ended')
				await pause(RETRY_MS.first)
			} catch (error) {
				if (stopped) break
				const message = (error as Error).message
				if (error instanceof Unauthorized) {
					// The next try signs in again.
					const stored = load()
					if (stored) save({ ...stored, token: null, expiresAt: null })
					setState('retrying', message)
					await pause(Math.min(retry, RETRY_MS.max))
					retry = Math.min(retry * 2, RETRY_MS.max)
					continue
				}
				if (error instanceof Unsupported) {
					setState('unsupported', message)
					await pause(UNSUPPORTED_RETRY_MS)
					continue
				}
				setState('retrying', (error as Error).name === 'AbortError' ? 'the stream went silent' : message)
				// Jitter, so a T3 Code restart does not bring every client back at the same moment.
				await pause(retry + Math.floor(Math.random() * retry * 0.5))
				retry = Math.min(retry * 2, RETRY_MS.max)
			}
		}
	}

	return {
		start() {
			if (!stopped) return
			stopped = false
			void loop()
		},
		stop() {
			stopped = true
			abort?.abort()
			wake?.()
			setState('off')
		},
		status: () => status
	}
}

export type T3Events = ReturnType<typeof createT3Events>
