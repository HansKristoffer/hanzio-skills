# hono-webhooks

Written against hono-webhooks@0.4.1 (2026-10-21, today is 2026-10-21). Repo: HansKristoffer/hono-webhooks. Re-read its README and CHANGELOG when it releases.

Type-safe inbound webhook endpoints for Hono. Each webhook is defined once with Standard Schema schemas (Zod, Valibot, ArkType) for `params`, `query`, `headers`, `body` and `response`, and `createWebhooks` returns a plain Hono app to mount under a prefix. It adds signature verifiers (GitHub, Shopify, Stripe, Svix, any HMAC), one `onEvent` observability hook, an OpenTelemetry adapter, test helpers and a CLI. It is not a webhook sender, queue or retry system, and not an oRPC/RPC router: use it for third-party callbacks only.

## Install
```sh
bun add hono-webhooks hono zod
bun add @opentelemetry/api   # only for hono-webhooks/otel
```
Peers: `hono ^4.8.0` (required), `@opentelemetry/api ^1.9.0` (optional, needed by `/otel`). Dependency: `@standard-schema/spec`. Bring your own schema library. ESM only. No `engines`; runs on every runtime Hono supports (signatures use Web Crypto). Under Bun the `bun` export condition loads `src/*.ts`; Node and bundlers load `dist`.

## Exports
| Subpath | Gives |
| --- | --- |
| `hono-webhooks` | `defineWebhook`, `createWebhooks` (Hono app + `.webhooks`), `createWebhookFactory<Env>()`, `WebhookValidationError`, `describeWebhooks`, `testWebhook`, `summarizeEvent`, `formatIssues`; types `Webhook`, `WebhookConfig`, `WebhookEvent`, `WebhookEventSummary`, `WebhooksOptions`, `WebhookRequestInfo`, `WebhooksApp`, `Verify`, `VerifyInput`, `TestWebhookInput`, `BodyType`, `ValidationTarget`, `PathParams`, `StandardSchemaV1` |
| `hono-webhooks/signatures` | `github`, `shopify`, `stripe`, `svix` (each `.verify(secret, options?)` and `.sign(rawBody, secret, options?)`), `hmac({ header, encoding, prefix?, hash? })`; types `Secret`, `SignatureScheme`, `HmacOptions` |
| `hono-webhooks/otel` | `otelWebhooks(options?)` returns `{ around, onEvent }`; `UNMATCHED_ROUTE` (`'__unmatched__'`); type `OtelWebhooksOptions` |

`defineWebhook` config: `method` (`GET POST PUT PATCH DELETE OPTIONS`, `HEAD` answered by `GET`), `path` (Hono path), `params`, `query`, `headers` (lower-case keys), `body`, `response`, `verify`, `bodyType` (`'auto' | 'json' | 'form' | 'text'`), `description`. Handler gets `{ c, params, query, headers, body, rawBody }`. Returns: `Response` as is, `undefined` = 204, string = 200 text, else 200 JSON.

`createWebhooks` options: `around(info, next)`, `onEvent(event)` (not awaited; promise goes to `executionCtx.waitUntil` when present), `onError(error, c)` (return a `Response` or nothing for the default), `logErrors` (default `true`).

Signature schemes: `stripe.verify(secret, { toleranceSeconds })` and `svix.verify(secret, { toleranceSeconds })` reject timestamps more than 300 s away by default. `svix` covers Resend, Clerk and Standard Webhooks (`svix-*` or `webhook-*` headers, `whsec_<base64>` secret). `secret` is a string or `(c) => string | Promise<string>`.

## Setup
Typed env once, then one file per webhook and one registry:
```ts
// src/webhooks/factory.ts
import { createWebhookFactory } from 'hono-webhooks'

export type AppEnv = { Bindings: { RESEND_WEBHOOK_SECRET: string } }
export const { defineWebhook, createWebhooks } = createWebhookFactory<AppEnv>()
```
```ts
// src/webhooks/resend.ts
import { svix } from 'hono-webhooks/signatures'
import { z } from 'zod'
import { defineWebhook } from './factory'

export const resendEvents = defineWebhook(
	{
		method: 'POST',
		path: '/resend',
		verify: svix.verify((c) => c.env.RESEND_WEBHOOK_SECRET), // whsec_...
		body: z.object({ type: z.string(), data: z.object({ email_id: z.string() }) })
	},
	({ body }) => {
		if (body.type === 'email.bounced') markBounced(body.data.email_id)
	}
)
```
```ts
// src/app.ts
import type { Webhook } from 'hono-webhooks'
import { otelWebhooks } from 'hono-webhooks/otel'

const webhooks: Webhook<AppEnv>[] = [health, resendEvents]
const app = new Hono<AppEnv>()
app.use('/webhooks/*', requestId()) // middleware on the parent, before app.route
app.route(
	'/webhooks',
	createWebhooks(webhooks, {
		...otelWebhooks<AppEnv>({
			ignoreRoutes: ['/health'],
			onWebhookCall(call, event) {
				// call = summarizeEvent(event); the request span is active here
				logger.info('webhook.completed', { route: call.route, status: call.status })
			}
		}),
		logErrors: false // onWebhookCall logs errors with route and span
	})
)
```
`/otel` gives a `SERVER` span `webhook: POST /orders/:id` (attributes `http.method`, `http.route`, `http.status_code`, `webhook.duration_ms`, `webhook.success`, `webhook.validation_error`) and metrics `webhook_request_total` (counter) and `webhook_request_duration_ms` (histogram), both by `route` and `status` (`success` below 400, else `failed`). `tracer`/`meter` default to `trace.getTracer('webhooks')` / `metrics.getMeter('webhooks')`; the meter resolves on the first request.

Storing calls without OTel: `onEvent: async (e) => { const call = summarizeEvent(e); await db.insert(...) }`. `summarizeEvent` is JSON-safe, rounds `durationMs`, adds `ip`/`userAgent`, and leaves request headers out on purpose.

Tests:
```ts
import { testWebhook } from 'hono-webhooks'
import { shopify } from 'hono-webhooks/signatures'

const res = await testWebhook(orderPaid, {
	params: { orderId: '42' },
	body: { amount: 10, currency: 'DKK' },
	sign: (rawBody) => shopify.sign(rawBody, 'test-secret'),
	env: { SHOPIFY_WEBHOOK_SECRET: 'test-secret' }
})
```
`describeWebhooks(appOrArray, { target: 'openapi-3.0' | 'draft-07' })` returns JSON Schemas for docs and admin pages (needs a schema library with Standard JSON Schema, e.g. Zod 4.2+).

## CLI
Bin `hono-webhooks` (built on `hanzio/cli`, bundled; no extra install).
```sh
hono-webhooks <module> list
hono-webhooks <module> schema <path>
hono-webhooks <module> test <method> <path> [-b body] [-q "a=1&b=2"] [-H "name: value"]... \
  [-r ./secrets.ts]... [-s github|shopify|stripe|svix] [-e SECRET_ENV_NAME]
```
- `<module>` exports a `createWebhooks()` app or an array of webhooks (default or named).
- `-r, --preload` imports modules first (repeatable), e.g. to load secrets. `-s, --sign` signs the exact `--body` with the secret in the env var named by `-e, --secret-env`.
- `test` skips the parent app's middleware and exits 1 on a 4xx/5xx.
- hellu wires it as a script: `"webhooks": "bunx --bun hono-webhooks ./src/registries/webhooks.ts --preload ./src/registries/secrets.ts"`.

## Replaces local code like
- The in-app `lib/webhook` this package came from (hellu `apps/backend/src/lib/webhook/*` before commit `7c72467f3`, 2026-09-28): `createHttpRoute(handlerData, handler)` with `reqBodySchema`/`reqQuerySchema`, `rawBody: true` plus hand-checked signatures, built-in span/logger/`recordWebhookCall` → `defineWebhook` + `createWebhooks`. The README has a full `createHttpRoute` migration table. Copies of older hellu-derived projects may still have it.
- hellu `apps/backend/src/lib/webhook/use-hono-webhooks.ts` (`traceWebhook` with `tracer.startActiveSpan('webhook: …')`, `recordWebhookEvent` setting `http.status_code`/`webhook.success`, `UNMATCHED_WEBHOOK_ROUTE = '__unmatched__'`) and `apps/backend/src/lib/observability/webhook-metrics.ts` (`webhook_request_total`, `webhook_request_duration_ms`, `recordWebhookRequest`, `webhookOtelMetrics` in `registries/otel-metrics.ts`) → `otelWebhooks()` from `/otel`; keep only the app logger call in `onWebhookCall`. Still local on hellu main at time of writing.
- gey-mono `apps/backend/src/lib/webhook/index.ts` (`useHonoWebhooks(app)` with a hand-written `around` span) + `features/system/api/webhook.ts` `recordWebhookCall` → `otelWebhooks({ onWebhookCall })`, storing the call from `onWebhookCall`. gey-mono pins `^0.3.0`; `/otel` needs 0.4+.
- Hand-rolled signature checks in a webhook handler: `createHmac(...)` + `timingSafeEqual` against `x-hub-signature-256`, `x-shopify-hmac-sha256`, `stripe-signature`, `svix-signature`/`webhook-signature`, or Stripe SDK `constructEvent` → `github`/`shopify`/`stripe`/`svix.verify` or `hmac({ header, encoding })`. Do not replace HMACs that sign your own tokens (hellu `voice-connect-token.ts`, `hosted/address.ts`); those are not webhooks.
- Ad-hoc Hono routes like `app.post('/webhooks/x', async (c) => { const body = await c.req.json(); schema.parse(body) ... })` with their own 400/401 handling → `defineWebhook` with `body`/`verify`.
- Grep: `createHttpRoute`, `useHonoWebhooks`, `recordWebhookCall`, `webhook-metrics`, `x-hub-signature`, `stripe-signature`, `svix-`, `whsec_`, `c.req.text()` near `createHmac`.

## Pitfalls
- Mount under its own prefix (`/webhooks`), never `/`: the webhooks app answers 404/405 for everything under its prefix.
- Middleware goes on the parent app before `app.route()`. `defineWebhook`/`createWebhooks` type `c` as `Context<any>`; use `createWebhookFactory<AppEnv>()` for typed `c.env`/`c.var`, and `otelWebhooks<AppEnv>()` to keep `onWebhookCall` typed.
- `verify` runs right after routing, before params/query/headers/body validation. A bad signature is 401 and `onEvent` gets `validation.target: 'signature'`. An empty secret throws (500) instead of accepting or rejecting everything.
- `bodyType: 'auto'` parses JSON only for `application/json` or `+json`; providers that send JSON with another content type need `bodyType: 'json'`. Malformed JSON is a 400 even without a `body` schema; use `bodyType: 'text'` to accept anything.
- A failing `response` schema does not change the response; it is reported as `event.validation` with `target: 'response'`.
- Pass `logErrors: false` when `onEvent`/`onError`/`onWebhookCall` logs errors, or the default 500 path logs twice. Since 0.2, `onError` alone no longer silences `console.error`.
- Since 0.2, `event.path` is relative to the mount point; use `event.c.req.path` for the full path. `hono` 4.8+ is required.
- `otelWebhooks` returns `{ around, onEvent }`: spreading it and also passing your own `onEvent` replaces one. Use `onWebhookCall`, or call its `onEvent` from yours. `ignoreRoutes` skips metrics only; the span and `onWebhookCall` still run.
- Same method + path defined twice throws when `createWebhooks` runs. Static paths beat dynamic ones regardless of order.
- `summarizeEvent(e).ip` comes from `x-forwarded-for`/`x-real-ip`/`cf-connecting-ip`; trust it only behind a proxy that overwrites them.
- CLI: `bunx hono-webhooks` starts under Node (22.18+ loads plain TS) and reruns under Bun when Node cannot load the module (extensionless imports). In Bun projects run `bunx --bun hono-webhooks ...`.
