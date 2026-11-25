// A stand-in for the running T3 Code server in tests: its MCP sign-in endpoints and the `events/stream` of
// `thread.run_settled`, shaped as 0.1.12-nightly.20261123 answers them. A test pushes turns that end, ends or
// terminates the stream, and reads what the service sent.
import { createHash } from 'node:crypto'

type Stream = { body: Record<string, any>; send: (message: unknown) => void; close: () => void }

export function fakeT3Server(options: { pairingCode?: string; tokenSeconds?: number; noEvents?: boolean } = {}) {
	const code = options.pairingCode ?? 'PAIRCODE2345'
	const tokens = new Set<string>()
	const pending = new Map<string, { challenge: string; clientId: string }>()
	const state = { registered: 0, approved: 0, tokens: [] as string[], revoked: [] as string[], streams: [] as Stream[], seq: 0 }
	let n = 0

	const json = (body: unknown, status = 200) => Response.json(body, { status })
	const server = Bun.serve({
		port: 0,
		hostname: '127.0.0.1',
		idleTimeout: 0,
		async fetch(req) {
			const url = new URL(req.url)
			if (url.pathname === '/oauth/mcp/register') {
				state.registered++
				const body = (await req.json()) as { redirect_uris: string[] }
				return json({ client_id: `client-${state.registered}`, redirect_uris: body.redirect_uris }, 201)
			}
			if (url.pathname === '/oauth/mcp/decision') {
				const { authorization, decision } = (await req.json()) as Record<string, any>
				if (decision._tag !== 'pairing-code' || decision.code !== code) return json({ _tag: 'AuthMcpApprovalError', message: 'That code is not valid.' }, 400)
				state.approved++
				const grant = `grant-${++n}`
				pending.set(grant, { challenge: authorization.code_challenge, clientId: authorization.client_id })
				const back = new URL(authorization.redirect_uri)
				back.searchParams.set('code', grant)
				back.searchParams.set('state', authorization.state)
				return json({ redirectTo: back.toString() })
			}
			if (url.pathname === '/oauth/mcp/token') {
				const form = new URLSearchParams(await req.text())
				const grant = pending.get(form.get('code') ?? '')
				const challenge = createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64url')
				if (!grant || grant.challenge !== challenge || grant.clientId !== form.get('client_id')) return json({ error: 'invalid_grant' }, 400)
				pending.delete(form.get('code')!)
				const token = `token-${++n}`
				tokens.add(token)
				state.tokens.push(token)
				return json({ access_token: token, token_type: 'Bearer', expires_in: options.tokenSeconds ?? 2592000, scope: 'orchestration:read' })
			}
			if (url.pathname === '/oauth/mcp/revoke') {
				const token = new URLSearchParams(await req.text()).get('token') ?? ''
				tokens.delete(token)
				state.revoked.push(token)
				return new Response(null, { status: 200 })
			}
			if (url.pathname === '/mcp') {
				const token = (req.headers.get('authorization') ?? '').replace(/^Bearer /, '')
				if (!tokens.has(token)) return json({ error: 'invalid_mcp_credential' }, 401)
				const body = (await req.json()) as Record<string, any>
				if (options.noEvents) return json({ jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'Method not found' } })
				if (req.headers.get('mcp-name') !== body.params?.name) return json({ jsonrpc: '2.0', id: body.id, error: { code: -32020, message: 'Mcp-Name header does not match request parameters' } }, 400)
				const encoder = new TextEncoder()
				let controller!: ReadableStreamDefaultController<Uint8Array>
				const stream: Stream = {
					body,
					send: (message) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(message)}\n\n`)),
					close: () => controller.close()
				}
				return new Response(
					new ReadableStream<Uint8Array>({
						start(c) {
							controller = c
							state.streams.push(stream)
							stream.send({
								jsonrpc: '2.0',
								method: 'notifications/events/active',
								params: { _meta: { 'io.modelcontextprotocol/subscriptionId': body.id }, cursor: `c.${state.seq}`, truncated: body.params.cursor === 'stale', heartbeatMs: 30000 }
							})
						}
					}),
					{ headers: { 'content-type': 'text/event-stream' } }
				)
			}
			return new Response('not found', { status: 404 })
		}
	})

	const live = () => state.streams.at(-1)!
	return {
		url: `http://127.0.0.1:${server.port}`,
		state,
		/** A turn ended in `threadId`. */
		settle(threadId: string, parentThreadId: string | null = null) {
			const cursor = `c.${++state.seq}`
			live().send({
				jsonrpc: '2.0',
				method: 'notifications/events/event',
				params: {
					_meta: { 'io.modelcontextprotocol/subscriptionId': 1 },
					eventId: `m${state.seq}`,
					name: 'thread.run_settled',
					timestamp: new Date().toISOString(),
					cursor,
					data: { id: `m${state.seq}`, type: 'thread.run_settled', threadId, parentThreadId, outcome: 'completed', occurredAt: new Date().toISOString(), isSubagentChild: !!parentThreadId }
				}
			})
		},
		/** Ends the stream as T3 Code does when access is revoked. */
		revokeAll() {
			tokens.clear()
			live().send({ jsonrpc: '2.0', method: 'notifications/events/terminated', params: { error: { code: -32024, message: 'Forbidden', data: { reason: 'Access revoked' } } } })
			live().close()
		},
		stop: () => server.stop(true)
	}
}
