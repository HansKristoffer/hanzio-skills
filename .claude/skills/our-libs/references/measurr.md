# measurr

Written against measurr@0.5.0 (2026-10-20, today is 2026-10-21). Repo: HansKristoffer/measurr. Re-read its README and CHANGELOG when it releases.

A small typed semantic layer. You declare datasets (one fact table each) with measures and dimensions using typed expression builders; callers (UI, charts, an LLM tool) send a small JSON query; the engine compiles it to one SQL statement per dialect, runs it through your `execute` function and returns typed rows. Tenant scoping and per-dataset/per-field access are built in. It is not an ORM or a driver and has no SQL text in definitions; Postgres is the only shipped dialect. It replaced the retired metrickit/ts-metrics and covers hellu's `lib/metrics` engine.

## Install
```sh
bun add measurr zod
```
Peers: `zod` ^4.0.0 (required), `typescript` >=6.0.0 (optional peer, but the types need TS 6+). No runtime dependencies, no driver dependency. The `bun` export condition loads `src/*.ts` directly under Bun; Node gets `dist`.

## Exports
| Subpath | Gives |
| --- | --- |
| `measurr` | `createAnalytics`, `defineDataset`, `measure.*`, `dimension.*`, `table`, expression builders (`eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `inList`, `isNull`, `isNotNull`, `and`, `or`, `not`, `exists`, `caseWhen`, `coalesce`, `toText`, `literal`, `minutesAgo`), `allTenants`, `AnalyticsError`, `isAnalyticsError`, `AnalyticsResultSchema`, `analyticsToolGuidance`, dialect-author helpers (`renderStatement`, `decodeNumber`, `CompileError`), types (`AnalyticsQuery`, `AnalyticsResult`, `AnalyticsSource`, `AnalyticsCache`, `Tenant`, `TenantId`, `PeriodInput`, `Ratio`, `FieldKey`, `AccessKey`, ...) |
| `/postgres` | `postgresDialect({ timestamps?: 'timestamptz' \| 'utc' })` |
| `/shapes` | `toKpi`, `toTimeseries`, `toDistribution`, `toPivot`, `toLeaderboard`: pure result-to-chart shapes |
| `/handler` | `queryBatch`, `streamBatch`, `toHttpError`: framework-neutral serving |
| `/testing` | `checkDatasetContract`, `assertDatasetContract`: contract checks against a seeded DB |

## Setup
Dataset (trimmed from the README):
```ts
import { createAnalytics, defineDataset, dimension, eq, measure, table } from 'measurr'
import { postgresDialect } from 'measurr/postgres'

const order = table<Order>('orders') // Row types are plain TS types; Prisma models work as-is
const region = order.leftJoin(table<Region>('regions'), (r) => eq(r.col('id'), order.col('regionId')))

export const orders = defineDataset({
  key: 'orders',
  label: 'Orders',
  description: 'One row per order. Test orders are excluded.',
  from: order,
  tenantColumn: order.col('tenantId'), // or null for staff-only, tenantless tables
  scope: eq(order.col('isTest'), false),
  time: { created: { column: order.col('createdAt'), label: 'Created' } },
  measures: {
    orders: measure.count({ label: 'Orders' }),
    revenue: measure.sum(order.col('amount'), { label: 'Revenue' }),
    margin: measure.sum(order.col('amount').sub(order.col('cost')), { label: 'Margin', access: 'staff' }),
    paidShare: measure.share({ label: 'Paid', numerator: eq(order.col('status'), 'PAID') })
  },
  dimensions: {
    status: dimension.enum(order.col('status'), OrderStatus, { label: 'Status', labels: { OPEN: 'Open', PAID: 'Paid', REFUNDED: 'Refunded' } }),
    region: dimension.relation({ label: 'Region', key: region.col('id'), name: region.col('name'), empty: 'No region' }),
    week: dimension.timeBucket('created', 'week')
  }
})
```
Measures: `count`, `countWhere`, `countDistinct`, `sum`, `avg`, `median`, `share`, `ratio('a', 'b')`. Dimensions: `enum`, `computed`, `relation`, `manyToMany`, `number`, `timeBucket` (day, week, month), `timePart` (weekday, hour); `groupOnly`/`filterOnly`/`access` options. Datasets also take `defaultPeriod` (use `{ all: true }` for current-state tables) and `source`.

Engine (README):
```ts
export const analytics = createAnalytics({
  datasets: [orders],
  sources: {
    main: {
      dialect: postgresDialect({ timestamps: 'utc' }), // 'utc' for Prisma DateTime columns
      execute: ({ text, values }) => db.unsafe(text, [...values]) // read-only + statement timeout belong here
    }
  },
  tenant: (ctx: Ctx) => ctx.organizationId,          // id, readonly list of ids, or allTenants
  authorize: (dataset, ctx) => ctx.can(`analytics:${dataset.key}`),
  authorizeField: (dataset, key, access, ctx) => ctx.roles.includes(access), // required once any field has `access`
  timezone: (ctx) => ctx.timezone,
  onQuery: (event, ctx) => metrics.record(event.dataset, event.durationMs, event.outcome)
})

const result = await analytics.query(
  { dataset: 'orders', measures: ['orders', 'paidShare'], groupBy: ['status'], period: { last: { days: 30 } }, compareToPrevious: true },
  ctx
)
```
Analytics methods: `query`, `explain` (compiled statements), `querySchema({ ctx })` / `querySchema({ datasets })` / `querySchema()` (Zod input schema, usable as an LLM tool schema via `z.toJSONSchema`), `resultSchema(key)`, `listDatasets(ctx)`.

Prisma `execute` in a read-only transaction (README):
```ts
execute: ({ text, values }) =>
  prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY')
    await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS}`)
    return tx.$queryRawUnsafe<Record<string, unknown>[]>(text, ...values)
  }, { timeout: STATEMENT_TIMEOUT_MS + 1_000 })
```

Result cache (any store; key is `measurr:<dataset>:<sha256>`, checked after parse and authorization):
```ts
cache: {
  get: async (key, { ctx }) => ctx.refresh ? null : JSON.parse((await redis.get(`${BUILD_ID}:${key}`)) ?? 'null'),
  set: (key, result, { dataset }) => redis.setex(`${BUILD_ID}:${key}`, TTL_SECONDS[dataset], JSON.stringify(result))
}
```

Chart shapes:
```ts
import { toKpi, toTimeseries, toDistribution, toPivot, toLeaderboard } from 'measurr/shapes'
toKpi(result, 'orders') // { kind: 'kpi', value, previous?, change? }
toTimeseries(result, { bucket: 'day', unit: 'day', measure: 'orders', series: 'status', fill: 0 })
toDistribution(result, { by: 'status', measure: 'orders' })
toPivot(result, { rows: 'weekday', columns: 'hour', measure: 'orders' })
toLeaderboard(result, { by: 'region', measure: 'revenue' })
```

Serving (oRPC/tRPC error codes):
```ts
import { queryBatch, streamBatch, toHttpError } from 'measurr/handler'
const { results, errors } = await queryBatch(analytics, { total: q1, byStatus: q2 }, ctx) // one failure doesn't fail the rest
for await (const chunk of streamBatch(analytics, queries, ctx)) { /* { key, result } | { key, error } */ }
try { return await analytics.query(input, ctx) } catch (error) {
  if (!(error instanceof AnalyticsError)) throw error
  const { code, message, data } = toHttpError(error) // FORBIDDEN 403, UNAUTHORIZED 401, BAD_REQUEST 400
  throw new ORPCError(code, { message, data })
}
```

LLM tool: `querySchema({ ctx })` as the input schema, `resultSchema(key)` or `AnalyticsResultSchema` as the output contract, and `analyticsToolGuidance` (markdown bullets) in the instructions, plus a line naming the tool.

Contract tests:
```ts
import { assertDatasetContract } from 'measurr/testing'
await assertDatasetContract({ dataset: orders, source, tenant: seededTenantId }) // allTenants for tenantless datasets
```

## CLI
None.

## Replaces local code like
- `hellu apps/backend/src/lib/metrics/*` (about 2,900 lines) → datasets + `createAnalytics`. Pieces: `metrics/define-metric.ts` and its `defineKpiMetric`/`defineTimeSeriesMetric`/`defineDistributionMetric`/`definePivotMetric`/`defineLeaderboardMetric`/`defineTableMetric` factories with `allowedRoles`, `filterSchema`, `cacheTtl` and a Prisma `resolve()` doing `groupBy`/`count` → one `defineDataset` with measures/dimensions and `authorize`/`authorizeField`; `engine/cache.ts`, `cacheUtils.ts` (`stableHash`, FNV), `cacheCodec.ts` (Redis `mget`/`setex`) → `cache`; `engine/runMetricsBatch.ts` → `queryBatch`; `engine/runMetricsStreaming.ts` + `api/runMetricsStream.ts` → `streamBatch`; `schemas/output.ts` (kpi/timeseries/distribution/table/... kinds) and `metrics/helpers/{distribution,timeseries}.ts` → `measurr/shapes`; `engine/time.ts` + `schemas/time.ts` → `period` and `timezone`; `api/getAvailableMetrics.ts` + `catalog.ts` → `listDatasets(ctx)`; `resolveOrganizationIds` in `api/runMetrics.ts` → `tenant(ctx)` returning a list or `allTenants`.
- Feature metric files that call those factories, e.g. `hellu apps/backend/src/features/support-session/metrics/**`, `features/{booking,customer,knowledge-gap}/metrics/index.ts`, and `apps/backend/src/registries/metrics.ts` → dataset files (hellu already has some: `features/*/analytics/*.dataset.ts`, `registries/analytics-datasets.ts`, `features/analytics/runtime.ts`).
- `gey-mono apps/backend/src/lib/metrics/*` (same engine plus `metricMath.ts`, `pivot-helpers.ts`, `hasAccess.ts`, `clickhouse.ts`, `runTvDashboard.ts`) → same mapping; gey-mono's `lib/analytics/*` already uses measurr 0.4.0.
- Imports of `metrickit` or `ts-metrics` → measurr (those packages are retired).
- Grep symptoms: `prisma.<model>.groupBy(` inside "metrics" resolvers, hand-written `date_trunc`/`AT TIME ZONE` SQL for dashboards, `organizationIds` filters threaded manually into every metric query, FNV/`stableHash` cache keys, `chartType: 'donut'` in backend code, a hand-built Zod schema for an "analytics" or "metrics" LLM tool.

## Pitfalls
- 0.x: minor releases may change APIs. The README's "Stable API" section lists what is kept stable.
- Types need TypeScript 6+. Older TS fails on the column and dataset types.
- `tenant(ctx)` must come from the server-built `ctx`, never from query input. Null, `''` or a list containing those throws `missing_tenant`; an empty list matches no rows. `allTenants` is a symbol and cannot come from JSON.
- Datasets with `tenantColumn: null` are only queryable when `tenant(ctx)` is `allTenants`; any scoped caller gets `forbidden`.
- Marking any field with `access` makes `authorizeField` required (`createAnalytics` throws otherwise). A `ratio` inherits the access of the measures it divides.
- Prisma `DateTime` columns are `timestamp without time zone`: use `postgresDialect({ timestamps: 'utc' })`. The default `'timestamptz'` buckets them wrongly.
- `defineDataset` and `createAnalytics` validate at module load and startup (reachable columns, ratio cycles, computed values, every measure/grouping compiled). A bad definition fails boot, not the first query.
- A grouped query returns at most `limit` rows (default 20, max 100); `truncated` is set. Set `limit: 100` for time series. Periods are whole local days, max two years; `compareToPrevious` with `{ all: true }` is `invalid_query`.
- Many-to-many groupings repeat rows (an order with two tags counts twice); totals are a separate ungrouped statement and stay correct. `toDistribution` shares can sum above 1.
- `notIn` keeps rows without a value, unlike SQL `NOT IN`.
- Cache keys survive definition changes: prefix with a build id if old numbers must not outlive a deploy. Cache and `onQuery` errors are swallowed.
- Read-only transactions, statement timeouts and row caps are your `execute`'s job.
