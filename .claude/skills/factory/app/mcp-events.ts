// The MCP Events extension (SEP-3415, `io.modelcontextprotocol/events`) on the factory's MCP server: an agent's
// MCP client lists the factory's event types, then polls them or holds a stream open, instead of calling
// wait_for_update in a loop. The server has no sign-in, and the spec allows webhook delivery only to an
// authenticated principal, so it offers poll and push only; the factory's own signed webhook (set_webhook)
// covers receivers that want posts.
//
// The protocol lives here; the server hands it an EventFeed that reads the factory's database. Cursors are row
// ids as strings, so a client that was away picks up where it left off, across restarts too.

type Json = Record<string, unknown>

export const EVENTS_EXTENSION = 'io.modelcontextprotocol/events'
const SUBSCRIPTION_ID = 'io.modelcontextprotocol/subscriptionId'

/** The error codes SEP-3415 names, plus the transport's header check. */
export const EVENT_ERRORS = { invalidParams: -32602, headerMismatch: -32020, notFound: -32023, unsupported: -32026 } as const

export class EventError extends Error {
	constructor(
		readonly code: number,
		message: string,
		readonly data?: Json
	) {
		super(message)
	}
}

export type Occurrence = { id: number; at: number; data: Json }

export type EventType = { name: string; description: string; payloadSchema: Json; idPrefix: string }

/** What the server provides: its event types, and reads of what happened after a position. The protocol only
 * hands the filter back to `read`, so it never needs the filter's type. */
export type EventFeed<F = any> = {
	types: EventType[]
	/** The subscription arguments every type takes. */
	inputSchema: Json
	/** Checks the arguments once per subscription; throws an EventError for ones it cannot serve. */
	filter: (args: Json) => F
	/** Rows of this type after `after`, oldest first. `notBefore` leaves out older rows, and `aged` says some were. */
	read: (name: string, filter: F, after: number, limit: number, notBefore: number | null) => { rows: Occurrence[]; more: boolean; aged: boolean }
	/** The newest row id this type reads from, matched or not: the position a quiet subscription has checked up to. */
	head: (name: string) => number
	/** Rows at or below this id may have been deleted, so a cursor below it may have missed some. */
	prunedThrough: (name: string) => number
	/** Calls `wake` when something may have been added; returns the call that stops it. */
	onChange: (wake: () => void) => () => void
}

const NEXT_POLL_MS = 30_000
const HEARTBEAT = { default: 30_000, min: 5_000, max: 60_000 }
const POLL_MAX = { default: 50, max: 100 }

const clamp = (value: unknown, fallback: number, min: number, max: number) =>
	typeof value === 'number' && Number.isFinite(value) ? Math.min(Math.max(Math.round(value), min), max) : fallback

export function listEvents(feed: EventFeed) {
	return {
		events: feed.types.map((t) => ({
			name: t.name,
			description: t.description,
			delivery: ['poll', 'push'],
			inputSchema: feed.inputSchema,
			payloadSchema: t.payloadSchema
		}))
	}
}

/** The event type a request names, and its checked arguments. */
function subscription(feed: EventFeed, params: Json | undefined) {
	const name = params?.name
	if (typeof name !== 'string' || !name) throw new EventError(EVENT_ERRORS.invalidParams, 'name: give the event type, as events/list names it')
	const type = feed.types.find((t) => t.name === name)
	if (!type) throw new EventError(EVENT_ERRORS.notFound, `no event type ${name}: events/list names ${feed.types.map((t) => t.name).join(', ')}`, { kind: 'event' })
	const args = params?.arguments ?? {}
	if (typeof args !== 'object' || args === null || Array.isArray(args)) throw new EventError(EVENT_ERRORS.invalidParams, 'arguments: give an object')
	return { type, filter: feed.filter(args as Json) }
}

/** Where delivery starts: now for a null cursor, else after the cursor, with `truncated` when some may be lost. */
function startAt(feed: EventFeed, name: string, cursor: unknown, maxAgeMs: unknown) {
	const head = feed.head(name)
	if (cursor === null || cursor === undefined) return { after: head, truncated: false, notBefore: null }
	const after = typeof cursor === 'string' && /^\d+$/.test(cursor) ? Number(cursor) : NaN
	if (!Number.isSafeInteger(after)) throw new EventError(EVENT_ERRORS.invalidParams, 'cursor: give null, or a cursor this server returned')
	// A cursor past the newest row came from another database: start from now and say so.
	if (after > head) return { after: head, truncated: true, notBefore: null }
	const notBefore = typeof maxAgeMs === 'number' && maxAgeMs > 0 ? Date.now() - maxAgeMs : null
	return { after, truncated: after < feed.prunedThrough(name), notBefore }
}

const occurrence = (type: EventType, row: Occurrence) => ({
	eventId: `${type.idPrefix}${row.id}`,
	name: type.name,
	timestamp: new Date(row.at).toISOString(),
	data: row.data
})

export function pollEvents(feed: EventFeed, params: Json | undefined) {
	const { type, filter } = subscription(feed, params)
	const start = startAt(feed, type.name, params?.cursor, params?.maxAgeMs)
	const limit = clamp(params?.maxEvents, POLL_MAX.default, 1, POLL_MAX.max)
	const head = feed.head(type.name)
	const { rows, more, aged } = feed.read(type.name, filter, start.after, limit, start.notBefore)
	const last = rows.at(-1)?.id ?? start.after
	return {
		events: rows.map((row) => occurrence(type, row)),
		// With nothing more to send, everything up to the head has been checked, matched or not.
		cursor: String(more ? last : Math.max(last, head)),
		truncated: start.truncated || aged,
		hasMore: more,
		nextPollMs: NEXT_POLL_MS
	}
}

/**
 * An `events/stream` subscription as Server-Sent Events: `active` first, each event as it happens, and a
 * heartbeat carrying the cursor whenever a heartbeat interval passes in silence. It ends when the client closes
 * the request. Throws an EventError before any stream exists, which the caller answers as a JSON-RPC error.
 */
export function streamEvents(feed: EventFeed, requestId: unknown, params: Json | undefined) {
	const { type, filter } = subscription(feed, params)
	const start = startAt(feed, type.name, params?.cursor, params?.maxAgeMs)
	const heartbeatMs = clamp(params?.heartbeatMs, HEARTBEAT.default, HEARTBEAT.min, HEARTBEAT.max)
	const meta = { [SUBSCRIPTION_ID]: requestId }
	const encoder = new TextEncoder()
	let after = start.after
	let notBefore = start.notBefore
	let sent = 0
	let stopListening = () => {}
	let timer: Timer | undefined

	const close = () => {
		clearTimeout(timer)
		stopListening()
	}

	return new ReadableStream<Uint8Array>({
		start(controller) {
			// The heartbeat fires once an interval passes with nothing sent, so every message sets it again.
			const beat = () => {
				const before = sent
				// Rows the change signal missed go out now; the heartbeat only when there were none.
				flush()
				if (sent === before) send('notifications/events/heartbeat', { cursor: String(after) })
			}
			const send = (method: string, body: Json) => {
				try {
					controller.enqueue(encoder.encode(`data: ${JSON.stringify({ jsonrpc: '2.0', method, params: { ...body, _meta: meta } })}\n\n`))
				} catch {
					// The client went away.
					close()
					return
				}
				sent++
				clearTimeout(timer)
				timer = setTimeout(beat, heartbeatMs)
			}
			const flush = () => {
				for (;;) {
					const head = feed.head(type.name)
					const { rows, more } = feed.read(type.name, filter, after, 100, notBefore)
					for (const row of rows) send('notifications/events/event', { ...occurrence(type, row), cursor: String(row.id) })
					after = rows.at(-1)?.id ?? after
					if (!more) {
						after = Math.max(after, head)
						break
					}
				}
				notBefore = null
			}

			send('notifications/events/active', { cursor: String(after), truncated: start.truncated, heartbeatMs })
			flush()
			stopListening = feed.onChange(flush)
		},
		cancel() {
			close()
		}
	})
}
