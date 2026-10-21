# orpc-fn

Written against orpc-fn@0.5.1 (2026-10-21, today is 2026-10-21). Repo: HansKristoffer/orpc-fn. Re-read its README and CHANGELOG when it releases.

Define a backend function once with `fn()`: a typed oRPC procedure with an OpenTelemetry span, one `fn.completed` log line, typed guards, injected handler extras and nested `call()`s that keep the context. The same procedure becomes a live query over Redis, a Mastra tool, an MCP tool, a Hono route or a CLI command, and client subpaths call it from Vue, React and Expo. It is a thin layer over `@orpc/server`: routers, `ORPCError`, `os`, `RPCLink` and `@orpc/tanstack-query` stay oRPC's own. Auth, session, context shape, database, i18n and permissions stay in the app and are injected once with `createFn`.

## Install
```sh
bun add orpc-fn @orpc/server @orpc/contract @orpc/client zod
```
Required peers: `@orpc/server`, `@orpc/contract`, `@orpc/client` ^1.14.0, `zod` ^4.0.0. Dependency: `hanzio` ^3.1.0 (used by `/cli` and the bin).
Optional peers, per subpath:
- `@opentelemetry/api` ^1.9.0: tracing (`createFn({ otel })`).
- `ioredis` ^5.0.0: `/live/ioredis`. Bun's `RedisClient` needs no peer (`/live/redis-bun`).
- `hono` ^4.0.0, `@orpc/openapi`, `@orpc/zod`, `@orpc/json-schema` (all ^1.14.0): `/hono`.
- `@mastra/core` ^1.51.0 plus `@orpc/zod`, `@orpc/json-schema`: `/mastra`.
- `@orpc/zod`, `@orpc/json-schema`: `/mcp`. `@modelcontextprotocol/sdk` ^1.32.0: `/mcp/sdk`. `@modelcontextprotocol/server` ^2.0.0: `/mcp/server`.
- `vue` ^3.3.0, `@tanstack/vue-query` ^5.80.0: `/vue`, `/vue/testing`.
- `react` ^18 || ^19, `@tanstack/react-query` ^5.80.0: `/react`.
- Not a peer but used in the client setup: `@orpc/tanstack-query` (for `createTanstackQueryUtils`).
Runtime: ESM only, Node >= 20 or Bun, TypeScript 5.7+.

## Exports
| Subpath | Gives |
| --- | --- |
| `orpc-fn` | `createFn` (returns `fn`, `fnLive`, `createPubSub`, `createPublisher`, `createRouter`, `readMeta`, `createCall`, `shutdown`, `drainPubSubSubscribers`, `activePubSubSubscriberCount`), `defineMeta`, `readFnMeta`, `FN_META_KEY`, `isExpectedClientError`, `createBoundCall`, `createBoundedEventQueue`, `createDefaultLogger`, `createRouter`, `createStreamManifest`, `createStreamManifestAsync`, `renderStreamManifest`; types `HandlerParams`, `RouteConfig`, `FnMeta`, `FnContext`, `FnCompletedEvent`, `ProcedureInput/Output/Context`, `GuardOptions`, ... |
| `orpc-fn/live` | `defineScopedChangeBus`, `invalidationStream`, `fnLivePatch`, `streamLiveSnapshots`, `throwInitialSnapshotError`, `createBoundedEventQueue`, `backlogKey`; types `PubSubTransport`, `PubSubTransportStats`, `PubSubMetric`, `InvalidationEvent`, `ScopedChangeBus` |
| `orpc-fn/live/redis-bun` | `bunRedisTransport(client, { subscriber? })` for Bun `RedisClient` |
| `orpc-fn/live/ioredis` | `ioredisTransport(client, { subscriber?, onError? })` |
| `orpc-fn/live/memory` | `memoryTransport()` for tests and single-process dev |
| `orpc-fn/hono` | `mountOrpc`, `normalizeExpoOrigin`, `markRequestArrival`, `msSinceRequestArrival`, `formatServerTiming`, `finishOrpcHeaders` |
| `orpc-fn/client` | `createRpcLink`, `hasOrpcErrorCode`, `userFacingErrorMessage`, `userSafeServerMessage`, `queryCacheSerializer`, `isSubscriptionPath`. No server code; safe in frontends |
| `orpc-fn/expo` | `createExpoLink`, `createBetterAuthExpoLink`, `createExpoFetch` (Expo is passed in, not imported) |
| `orpc-fn/vue` | `provideOrpc`, `useOrpc`, `useApiClient`, `useOrpcSubscription`, `useLiveQuery`, `useInvalidationStream`, `useSubscriptionInvalidates`, `useQueryErrorMessage`, `Register` (module augmentation) |
| `orpc-fn/vue/testing` | `withOrpcApp`, `createTestStream`, `createOrpcMock` |
| `orpc-fn/react` | `useOrpcSubscription`, `useLiveQuery`, `useInvalidationStream`, `useQueryCacheOwner` (works on React Native) |
| `orpc-fn/mastra` | `createMastraTool(procedure, { id, description, requireApproval, allowMissingInputSchema, onExecuteFinish, contextKey })`, `toToolName` |
| `orpc-fn/mcp` | `listTools`, `hasTag`, `toToolName`, `toolInputSchema` (inspection; also an `OpenAPIHandler` filter) |
| `orpc-fn/mcp/sdk` | `registerMcpTools(server, router, options)`, `formatMcpResult` for `@modelcontextprotocol/sdk` v1 |
| `orpc-fn/mcp/server` | same `registerMcpTools` for `@modelcontextprotocol/server` v2 |
| `orpc-fn/cli` | `procedureCommands(router, { filter?, context? })` returns a hanzio/cli `CommandGroup` |

Bin: `orpc-fn` (stream manifest generator, see CLI).

## Setup

Factory, once per app (`lib/fn.ts`):
```ts
import { ORPCError, os } from '@orpc/server'
import * as otel from '@opentelemetry/api'
import { createFn } from 'orpc-fn'
import { bunRedisTransport } from 'orpc-fn/live/redis-bun'

const publicProcedure = os.$context<{ headers: Headers; user?: User }>()
const protectedProcedure = publicProcedure.use(({ context, next }) => {
  if (!context.user) throw new ORPCError('UNAUTHORIZED')
  return next({ context: { user: context.user } })
})

export const { fn, fnLive, createPubSub, createRouter, shutdown } = createFn({
  procedures: { public: publicProcedure, protected: protectedProcedure },
  default: 'protected',
  extras: () => ({ db }),
  guards: { permission: (required: Permission, { context }) => context.user?.can(required) ?? false },
  otel,
  pubsub: { transport: () => bunRedisTransport(new RedisClient(process.env.REDIS_URL)), ownsTransport: true }
})
```
Other `createFn` options: `extrasByProcedure`, `meta: defineMeta<AppMeta>()`, `tags`, `logger`, `spanAttributes`, `onCompleted`, `isExpectedError`; `pubsub` also takes `namespace`, `maxQueueSize`, `maxIngressSize`, `maxReplaySize`, `initializationTimeoutMs`, `onDrop`, `onMetric`.

A procedure:
```ts
export const getOrder = fn({
  name: 'order.get',            // required: operationId and span name
  method: 'GET', path: '/orders/{id}',
  permission: 'orders:read',    // a configured guard key
  input: z.object({ id: z.string() }),
  handler: async ({ input, context, db, call, logger, signal, errors }) => {
    const order = await db.order.find(input.id)
    return { ...order, customer: await call(getCustomer, { id: order.customerId }) }
  }
})
```
Route options: `name`, `procedure`, `path`, `method`, `summary`, `description`, `tags`, `deprecated`, `successStatus`, `successDescription`, `inputStructure`, `outputStructure`, guard keys, `guardResolvers`, `meta`, `stream`, `errors`. Outside a handler (scripts, seeders, tests) use `createCall(context, signal?)`.

Live query and pub/sub:
```ts
export const listOrders = fnLive({
  name: 'order.list',
  input: z.object({ organizationId: z.string() }),
  handler: ({ input, db }) => db.order.list(input.organizationId),
  live: {
    eventSchema: z.object({ organizationId: z.string(), orderId: z.string() }),
    channel: ({ organizationId }) => `orders:${organizationId}`,
    coalesceMs: 50
  }
})
// router: { list: listOrders.procedure, subscribe: listOrders.subscribe }
await listOrders.publish({ organizationId, orderId }) // after a committed write
```
`live` also takes `shouldUpdate`, `transformerFn` (+ `stateSchema`, `emitSchema` for `fnLivePatch`), `authFn`, `reauthorize`, `useBacklog`/`backlogSize`/`backlogTtl`, `safePublish`, `maxBatchSize`. `createPubSub({ name, inputSchema, eventSchema, channel, filterFn, authFn, mirrorChannel, overflowMarker, ... })` returns `{ subscribe, publish, publishMany, getSubscriptionChannelName, getPublishChannelName }`; `createPublisher` is the publish-only half.

Scoped change bus plus one invalidation stream for the app shell:
```ts
import { defineScopedChangeBus, invalidationStream } from 'orpc-fn/live'

const defineChangeBus = defineScopedChangeBus(createPubSub, {
  subscribe: (context) => activeOrganizationId(context), // throw to refuse
  publish: (event: { organizationId: string }) => event.organizationId
})
export const dealChanges = defineChangeBus({
  name: 'deal.subscribe', prefix: 'deal:change', // channel `${prefix}:${scope}`
  inputSchema: z.object({}),
  eventSchema: z.object({ organizationId: z.string(), dealId: z.string() })
})
// fnLive({ live: { channel: dealChanges.channel, ... } }) shares its events.

export const subscribeChanges = fn({
  name: 'realtime.subscribeChanges', stream: true, input: z.object({}),
  handler: ({ context, signal }) => invalidationStream({
    context, signal,
    sources: { deal: dealChanges.subscribe, workItem: workItemChanges.subscribe },
    events: { deal: (e) => (e.kind === 'won' ? { dealId: e.dealId } : undefined) }
  })
})
```

Transport stats for gauges (all three transports have `stats()`: `{ channels, listeners, subscriberConnected }`; no connection opens until the first subscribe):
```ts
const transport = bunRedisTransport(redis)
createFn({ /* ... */, pubsub: { transport, ownsTransport: true } })
meter.createObservableGauge('pubsub_subscribed_channels').addCallback((g) => g.observe(transport.stats().channels))
```
Pair with `activePubSubSubscriberCount()` from `createFn`.

Hono server:
```ts
import { mountOrpc, normalizeExpoOrigin } from 'orpc-fn/hono'
mountOrpc(app, {
  router, rpcPrefix: '/rpc',
  openapi: { prefix: '/api', info: { title: 'API', version: '1.0.0' } }, // + docsPath, filter, smartCoercion, spec, plugins
  context: async (c, { headers, timing }) => ({ headers, timing, session: await getSession(headers) }),
  normalizeHeaders: normalizeExpoOrigin, // copies `expo-origin` to `origin`
  onError: (error, request) => errorTracker.capture(error, request) // unexpected errors only
})
```
Also: `batch` (default true, 25), `serverTiming` (default true), `sseKeepAlive` (default 15000 ms), `plugins`, `queueMs`, `isExpectedError`. Call `markRequestArrival(request)` in `Bun.serve({ fetch })` before routing so `Server-Timing` `queue` covers in-process queueing. `context` may return a `Response` (e.g. 401).

Client (Vue, React, Expo):
```ts
import { createORPCClient } from '@orpc/client'
import { createTanstackQueryUtils } from '@orpc/tanstack-query'
import { createRpcLink, hasOrpcErrorCode, userFacingErrorMessage } from 'orpc-fn/client'
import { streamPaths } from './stream-paths' // generated by the orpc-fn bin
const link = createRpcLink({ url: `${apiOrigin}/rpc`, streamPaths, fetch: (r, init) => fetch(r, { ...init, credentials: 'include' }) })
export const client: RouterClient<typeof router> = createORPCClient(link)
export const orpc = createTanstackQueryUtils(client)
```
`userFacingErrorMessage(error, fallback)` returns server text only when the server set `data: { userMessage }`. Expo: `createBetterAuthExpoLink({ url, fetch /* expo/fetch */, native: Platform.OS !== 'web', getCookie, getExpoOrigin })`.

Vue:
```ts
app.use(VueQueryPlugin, { queryClient })
provideOrpc(app, { client, utils: orpc })
declare module 'orpc-fn/vue' { interface Register { client: typeof client; utils: typeof orpc } }

const { useQuery, useMutation, invalidate } = useApiClient()
const order = useLiveQuery(() => ({ id: props.id }), (input, o) => o.order.get.queryOptions({ input }), (o) => o.order.watch.call)
useInvalidationStream({}, (o) => o.realtime.subscribeChanges.call, {
  domains: { order: { debounceMs: 100, queryKeys: [orpc.order.key()] } }, logger
})
```
Tests: `withOrpcApp(setup, { utils })`, `createTestStream()` (`await stream.push(event)` resolves once handled), `createOrpcMock({ fn: mock })`.

React / React Native: same hooks, client procedure passed as is: `useLiveQuery({ id }, (input) => orpc.order.get.queryOptions({ input }), client.order.watch)`, `useInvalidationStream({}, client.realtime.subscribeChanges, { enabled, domains })`, `useOrpcSubscription(input, client.x.watch, { onEvent })`. `useQueryCacheOwner(owner)` clears the cache when user/org changes; pass the same owner as the persister `buster` with `queryCacheSerializer`. Wire TanStack `focusManager` to `AppState` on RN.

Mastra / MCP:
```ts
createMastraTool(getOrder, { requireApproval: true }) // runtime: requestContext.set('orpcContext', context)
registerMcpTools(server, router, { filter: hasTag('external'), context: ({ signal }) => authenticate(signal) })
```

## CLI

### `orpc-fn/cli`: procedures as app commands
```ts
import { defineCli } from 'hanzio/cli'
import { procedureCommands } from 'orpc-fn/cli'

const updateDeal = fn({
  name: 'deal.update', summary: 'Move a deal to another stage', meta: { cli: true },
  input: z.object({ id: z.string().meta({ positional: true }), stage: z.string() }),
  handler: async ({ input, context }) => { /* ... */ }
})
await defineCli({
  name: 'app',
  globals: z.object({ as: z.string().optional() }),
  context: async ({ as }) => ({ user: as ? await loadUser(as) : undefined }),
  commands: procedureCommands(router, { context: (ctx, meta) => ctx })
}).run() // app deal update d_1 --stage won --as ada@example.com
```
Mapping rules (from source):
- Default selection: procedures with `meta: { cli: true }` (add `cli?: boolean` to your meta type). `filter: (meta: FnMeta) => boolean` overrides it.
- Router keys become nested command groups, camelCase to kebab-case: `dealRoom.update` is `deal-room update`. Empty groups are dropped.
- Flags and positionals come from the route's `z.object()` input (`.meta({ positional: true })`, `.describe()`); help text is the route `summary`, then `description`.
- Each command runs `call(procedure, input, { context })` through oRPC, so middleware, guards, tracing and the `fn.completed` log run as over HTTP.
- `context: (cliContext, meta) => orpcContext` maps the CLI context per procedure; throw a hanzio `CliError` to refuse (hellu checks `meta.procedure === 'protected'` and requires `--as`).
- A 4xx `ORPCError` becomes `CliError("CODE: message")`; 5xx and other errors keep their stack.
- Streaming routes and non-object inputs throw a `TypeError` when the commands are built.

### `orpc-fn` bin: stream manifest
```sh
orpc-fn stream-manifest src/router.ts#appRouter --out ../web/src/stream-paths.ts          # export const streamPaths = [...]
orpc-fn stream-manifest src/router.ts#appRouter --out ../web/src/stream-paths.ts --check  # CI: exit 1 when stale
```
Flags: `<module>[#export]` positional (default export `default`), `--out <file.ts|file.json>`, `--name <const>` (ts only), `--check`. Writes only on change. Exit 2 when the export is missing. Built on hanzio/cli, so `orpc-fn completion <bash|zsh>` also exists. It imports the router (module side effects run, then it exits); run TS routers with `bun`, `tsx` or Node >= 22.18. gey-mono uses it as `bunx --bun orpc-fn stream-manifest src/registries/orpc-routes.ts#orpcApiPublicRouter --out src/registries/orpc-stream-paths.ts --name orpcStreamPaths`.

## Replaces local code like
- A local `fn()` wrapper that opens an OTel span, runs permission checks and logs completion around `os.handler` → `createFn`. hellu and gey-mono `apps/backend/src/lib/fn/fn.ts` already call `createFn` (with `ioredisTransport` in gey-mono, `bunRedisTransport` in hellu); copy that shape: `lib/fn/` keeps only app policy (context, guards, extras, transport factory).
- `hellu apps/backend/src/lib/fn/define-organization-change-bus.ts` + `channel-scope.ts` (`redisChannelOrganizationFlat`) → `defineScopedChangeBus`.
- `hellu apps/backend/src/lib/fn/transport.ts` (`fnTransportStats`, own channel `Map`, wrapping `subscriber.connected`) and `lib/observability/pubsub-metrics.ts` → transport `stats()` + `activePubSubSubscriberCount()`.
- `hellu apps/backend/src/features/realtime/providers/stream-shell-changes.ts` (fan-in of per-domain change streams) → `invalidationStream`.
- `hellu apps/backend/src/lib/fn/use-orpc-hono-handler.ts`, `gey-mono .../use-orpc-hono-handler.ts`, `hellu lib/hono/request-arrival.ts`, `lib/http/sse-keepalive.ts` → `mountOrpc`, `markRequestArrival`. Symptoms: hand-built `RPCHandler`/`OpenAPIHandler` + Scalar, `setInterval` SSE keep-alive comments, manual `Server-Timing`.
- `lib/fn/expected-client-error.ts` → `isExpectedClientError`; `lib/fn/orpc-context-headers.ts` (`expo-origin` → `origin`) → `normalizeExpoOrigin`; `lib/fn/write-stream-manifest.ts` → `orpc-fn stream-manifest`; `hellu apps/platform/src/lib/orpc-shared.ts` `hasOrpcErrorCode` and `lib/error-message.ts` → `orpc-fn/client`.
- `hellu apps/platform/src/composables/orpc/{useApiClient,useLiveQuery,useOrpcSubscription,reconnect-delay,useSubscriptionInvalidates,useRealtimeCoordinator,default-orpc}.ts`, `composables/useQueryErrorMessage.ts`, `gey-mono apps/platform/src/composables/useApiClient.ts` → `orpc-fn/vue`; `hellu apps/platform/src/test-utils/{orpc,orpc-subscription}.ts` → `orpc-fn/vue/testing`.
- `hellu apps/expo/src/support/orpc/{useOrpcSubscription,reconnect-delay}.ts`, `apps/expo/src/utils/useShellRealtime.ts`, `utils/query-persistence.ts` → `orpc-fn/react` (`useQueryCacheOwner`, `queryCacheSerializer`).
- Hand-rolled Mastra/MCP tool wrappers that call a procedure → `orpc-fn/mastra`, `orpc-fn/mcp/*`. A trpc-cli or `parseArgs` script that calls backend services → `procedureCommands` (hellu `apps/backend/src/entry/lib/cli.ts` is the reference wiring with `--as`/`--org` and a local-database guard).
- Grep: `os.handler(`, `new RPCHandler(`, `EventPublisher`, `redis.publish(` next to `subscribe(` in API code, `reconnectDelay`, `document.visibilityState` in a subscription composable.

## Pitfalls
- Procedure builders must not set `.input()`/`.output()`; schemas go on routes. Guard keys cannot reuse route option names; unknown route options and extras that shadow built-in handler params are rejected.
- With an output schema the handler returns the schema's input type; callers get its output type.
- Live/pub-sub `eventSchema`, `stateSchema`, `emitSchema`, Mastra and MCP adapters need Zod 4; core schemas accept any Standard Schema.
- CLI, MCP and Mastra adapters parse already-validated input again: transforms and refinements must be pure and accept their own output.
- `/cli` uses orpc-fn's own `hanzio` dependency; keep the app's `hanzio` on the same major so `defineCli` and the `CommandGroup` come from one copy.
- `createRpcLink` batches by default; without `streamPaths` a streaming call can be batched and break. Regenerate the manifest in CI with `--check`. Mark custom iterator routes `stream: true`.
- Replay/backlog is bounded and TTL-limited, not durable resume. A snapshot may already contain a queued delta: reducers need revisions or idempotence. Raw pub/sub fails with `SERVICE_UNAVAILABLE` after detected loss unless you set `overflowMarker`.
- `shutdown()` closes the transport only with `ownsTransport: true`. Redis Lua batching supports standalone Redis, not Cluster.
- 0.4.0 breaking: pub/sub log messages became constant names (`pubsub.subscribed`, `pubsub.subscription_lost`, ...) with `channel`, `error_type`, `error_message` attributes; update log alerts.
- Expo SDK 55: cancelling a stream throws `Controller is already closed` in `expo/fetch`; patch `src/winter/fetch/FetchResponse.ts` (README has the fix). Without the abort signal, cancelled subscriptions leak sockets.
- Vue `useLiveQuery`: leave `refetchType` at `'active'`; use `shallow: true` for large payloads. React: pass `structuralSharing: false` for large caches your `applyEvent` keeps immutable.
- MCP: one `registerMcpTools` per server; resolve lazy routers with oRPC `unlazyRouter` first. Streams are rejected.
- `npm i orpc-fn` without vue installed failed with ERESOLVE in a scratch dir (npm picked vue 2 via the optional `@tanstack/vue-query` peer); bun or `--legacy-peer-deps` installs fine.
- The extraction plan calls it `fnInvalidationStream`; the published export is `invalidationStream` from `orpc-fn/live`.
