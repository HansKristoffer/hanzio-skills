# better-graphile-worker

Written against better-graphile-worker@2.5.0 (2026-10-20, today is 2026-10-21). Repo: HansKristoffer/better-graphile-worker. Re-read its README and CHANGELOG when it releases.

Typed queues over Graphile Worker 0.17 (PostgreSQL jobs). Each queue is one `defineQueue` call with a Zod input schema, options and handler. It adds what Graphile lacks: typed enqueue, cron-init fan-out, durable steps, waiting on child jobs, progress, continuations, idempotency keys, timeouts, crash recovery, durable job outcomes, worker pools and optional OpenTelemetry. It is not a job runner of its own: Graphile does the scheduling, and you own the `pg.Pool`.

## Install
```sh
bun add better-graphile-worker graphile-worker pg zod
```
Peers: `graphile-worker` ^0.17.3 (the private-table adapter is pinned to 0.17.x), `pg` ^8.16.0, `zod` ^4.0.0, `@opentelemetry/api` ^1.9.0 (optional; tracing is a no-op without it). No runtime dependencies. ESM only, Node >=20, TypeScript 5.7+ (hellu and gey-mono run it under Bun). Prisma is not a dependency; `/prisma` only needs a client with `$queryRawUnsafe`.

## Exports
| Subpath | Gives |
| --- | --- |
| `better-graphile-worker` | `defineQueue`, `defineQueues`, `createBetterWorker`, `createBetterWorkerPool`, `pgPoolSize`, `createJobClient`, guards (`isRegularQueue`, `isCronQueue`, `isCronInitQueue`, `hasInputSchema`, `getQueueType`), errors (`NonRetriableError`, `RetryAtError`, `JobTimeoutError`, `ChildJobFailedError`, `WaitTimeoutError`, `JobValidationError`, `ShutdownTimeoutError`, ...), types (`QueueName`, `QueueInput`, `QueuePayload`, `QueueHandlers`, `JobContext`, `PreparedJob`, `PayloadMode`, `JobState`, ...) |
| `/client` | `createJobClient`: enqueue-only producer for API processes (no handlers needed) |
| `/prisma` | `enqueueInTransaction(tx, preparedJob)`: run `prepareJob(s)` SQL inside a Prisma transaction |
| `/cli` | `createCli(workerOrPool)`: returns `(argv) => Promise<void>` for an admin script |
| `/testing` | `createTestHarness(queues)` or `createTestHarness(contracts, handlers)`: run handlers without PostgreSQL |
| `/advanced` | low-level builders and SQL adapters (`createWorkerClient`, `buildTaskList`, `buildCronItems`, `createStepRunner`, `queryJobCounts`, payload envelope helpers). Application code should not need it |

## Setup
Queues and a worker (README):
```ts
import pg from 'pg'
import { defineQueue, defineQueues, createBetterWorker } from 'better-graphile-worker'
import { z } from 'zod'

const countCharacters = defineQueue({
  name: 'countCharacters',
  inputSchema: z.string().transform(value => value.length), // producers send string, handler gets number
  processFn: (length, ctx) => { ctx.logger.info('counted', { length }) }
})
const sendEmail = defineQueue({
  name: 'sendEmail',
  inputSchema: z.object({ to: z.string().email() }),
  maxAttempts: 5,
  processFn: async (payload, ctx) => {
    await ctx.createJob(countCharacters, payload.to) // inline handlers take the queue definition
  }
})
const dailySweep = defineQueue({ name: 'dailySweep', cron: '0 3 * * *', serial: true, processFn: (_p, ctx) => {} })

const queues = defineQueues([sendEmail, countCharacters, dailySweep])
const pgPool = new pg.Pool({ connectionString: process.env.DATABASE_URL })
const worker = createBetterWorker({ pgPool, queues })
await worker.migrate()               // Graphile schema + bgw_* tables; run as a DB owner
await worker.jobs.sendEmail({ to: 'person@example.com' })
await worker.start()
// shutdown: await worker.stop(); await pgPool.end()  (stop never closes your pool)
```
Queue kinds: regular (`inputSchema`), cron (`cron`, no schema), cron-init (`cron` + `inputSchema` + `initFn` returning inputs; `triggerCron(name)` runs `{name}_cron-init`).

Shared contracts for an API process: define queues without handlers in a shared module, pass `handlers: { ... }` (type with `satisfies QueueHandlers<typeof queues>`) to the worker, and use `createJobClient({ pgPool, queues })` from `better-graphile-worker/client` in the API. Call `producer.release()` when done.

Worker pools (lanes). Each queue names a `runner`; the pool needs options for every runner:
```ts
const sendReply = defineQueue({ name: 'sendReply', runner: 'turn', inputSchema: z.object({ id: z.string() }), processFn })
const nightlyDigest = defineQueue({ name: 'nightlyDigest', runner: 'background', cron: '0 3 * * *', processFn })
const runners = {
  turn: { concurrency: 10, pollInterval: 100, secondLookOnNotify: 10 },
  background: { concurrency: 4, pollInterval: 1000 }
}
const pgPool = new Pool({ connectionString, max: pgPoolSize(runners) + 4 }) // + producer headroom
const workers = createBetterWorkerPool({ pgPool, queues: defineQueues([sendReply, nightlyDigest]), runners, completedJobs: { maxPerQueue: 50 } })
await workers.start()
```
- A runner sets only `concurrency`, `pollInterval`, `secondLookOnNotify` and `graphile`; all other options are shared. `workers.runners.turn` is that runner's own worker. Enqueue/admin methods cover every queue.
- `secondLookOnNotify: ms` fetches again that long after each new-job NOTIFY. Needed because Graphile's fetch from another runner can lock a lane and hide the job until the next poll. Costs one extra fetch per insert; also accepted by `createBetterWorker`.
- Alternative without a pool: several `createBetterWorker({ ..., process: ['exportRun'], concurrency: 2 })` instances with disjoint `process` lists.

Transactional enqueue with Prisma:
```ts
import { enqueueInTransaction } from 'better-graphile-worker/prisma'

const job = await worker.prepareJob('advanceRun', { shopId, runId }) // prepare BEFORE the transaction
await prisma.$transaction(async (tx) => {
  await tx.run.update({ where: { id: runId, status: 'sealed' }, data: { status: 'approved' } })
  const [jobId] = await enqueueInTransaction(tx, job) // throws (rolls back) if Graphile made fewer jobs
})
// node-postgres: await client.query(job.text, job.values) between BEGIN and COMMIT
```

Payload modes: wire inputs must be plain JSON by default (`payloadMode: 'strict'`): Dates, bigints, class instances and nested `undefined` are rejected. `payloadMode: 'json-compat'` on a worker, pool or job client runs inputs through `JSON.stringify` first (drops undefined fields, Dates become ISO strings, `NaN` becomes `null`), as v1 producers did. Validation runs on the converted value. Set the same mode on workers and job clients.

Queue metrics: `createBetterWorker({ ..., otel: { api, metrics: true } })` (where `api` is `@opentelemetry/api`) records on the `graphile-worker` meter: `graphile_job_total` and `graphile_job_duration_ms` (by `queue`, `status`), `graphile_job_permanently_failed_total` and `graphile_job_enqueue_fail_total` (by `queue`). A job client records only enqueue failures. `otel: { api: null }` disables tracing.

Other options worth knowing (all on the root types):
- Per queue: `serial` (true or a shared lane name), `deriveJobOptions(input)` (computes `queueName`, `jobKey`, `idempotencyKey`, `priority`, ... per job), `timeout`, `outputSchema` (for waits), `progressSchema`, `maxAttempts`.
- Per worker: `defaultTimeout`, `crashRecovery` (default on: 30 s heartbeat, 5 min `staleAfter`), `jobOutcomes: { retention }` (keeps final state so `getJob(id)` works after success), `permanentFailure: 'retain' | 'discard'`, `completedJobs: { maxPerQueue }`, `hooks` (`createLogger`, `onJobFinished`, `onPermanentFailure`, `onEnqueueFail`, `shouldSkipEnqueue`), `handleSignals`, `graphile` overrides.
- In handlers: `ctx.step.run(id, fn, codec?)`, `ctx.step.triggerAndWait` / `batchTriggerAndWait` (replay, not suspension), `ctx.continue({ runAt? })`, `ctx.progress.set/get/flush`, `ctx.signal`, `throw new RetryAtError(date, { cause })`, `throw new NonRetriableError(...)`.
- Admin: `getJobStats`, `listJobs({ state, limit, before })`, `getJob`, `getJobProgress(queue, id)`, `retryJobs`, `failJobs`, `getQueueDefinitions`, `triggerCron`, `runOnce`.

## CLI
No bin. `/cli` builds one from your worker or pool:
```ts
import { createCli } from 'better-graphile-worker/cli'
await createCli(worker)(process.argv.slice(2))
```
Commands: `list-queues`, `schema <name>`, `create-job <name> [json]`, `stats`, `list-jobs`, `get-job <id>`, `retry <id>`, `fail <id> [reason]`, `run-once`. Flags: `--json` (pretty output and `{ error }` on failure), `-h/--help`; `create-job` takes `--priority`, `--run-at`, `--max-attempts`, `--job-key`; `list-jobs` takes `--queue`, `--state pending|running|failed`, `--limit`, `--offset`. Errors set exit code 1. Parsing is `node:util` `parseArgs`, not `hanzio/cli`.

## Replaces local code like
- `hellu apps/backend/src/lib/queue/create-queue.ts` (lane-aware `createQueue` wrapper with a `lane` field) → `defineQueue({ runner })`.
- `hellu apps/backend/src/lib/queue/instance.ts` + `apps/backend/src/registries/queue-lanes.ts` (`QUEUE_LANES`, `LANE_RUNNERS`, `TOTAL_LANE_CONCURRENCY`, `getCompletedJobsAcrossLanes`, one `createBetterWorker` per lane) → `createBetterWorkerPool`, `pgPoolSize`, `workers.getCompletedJobs()`.
- A hand-rolled `secondLookOnNotify(delayMs): WorkerEvents` that listens to Graphile `events` and calls fetch again (same `instance.ts`) → `secondLookOnNotify` option.
- `hellu apps/backend/src/lib/queue/create-job.ts` `toWireInput` (`JSON.parse(JSON.stringify(x))` before enqueue) → `payloadMode: 'json-compat'`.
- `hellu apps/backend/src/lib/queue/transactional-job.ts` (`enqueueTransactionalJob(tx, job)` calling `prepareJob` then `$queryRawUnsafe`) → `enqueueInTransaction` from `/prisma`.
- `hellu apps/backend/src/lib/observability/queue-metrics.ts` (`defineMetric` counters/histograms named `graphile_job_*`) → `otel: { api, metrics: true }`.
- `hellu apps/backend/src/lib/queue/cli.ts` already uses `createCli`; keep it, pass the pool.
- `hellu apps/backend/src/lib/queue/legacy-payloads.ts` (a trigger wrapping v1 payloads) is transitional; delete it once no v0.1/v1 producer runs.
- Raw Graphile usage: `import { run, quickAddJob, makeWorkerUtils } from 'graphile-worker'` with untyped payloads, a `taskList` object of handlers, or `GraphileWorker.Tasks` augmentation → `defineQueue` + `createBetterWorker`.
- Trigger.dev tasks (`budget-app packages/modules/*/trigger/*`, imports of `@trigger.dev/sdk`, `task({ id, run })`, `schedules.task`, `triggerAndWait`) → regular/cron queues and `ctx.step.triggerAndWait`. The README has a porting section: give each wait a stable ID and move side effects before a wait into `ctx.step.run`.
- Grep symptoms: `from 'graphile-worker'` outside the queue module, `JSON.parse(JSON.stringify(` near enqueue, `addJob(` in app code, hand-written `pg_notify`/`LISTEN` second fetches, per-lane `run({ concurrency })` loops.

## Pitfalls
- Version 2 changed the wire format. v2 workers accept only version-2 envelopes; raw, flat and v1 jobs fail permanently. Drain old jobs and upgrade producers and workers together. `createQueue` became `defineQueue`; low-level imports moved to `/advanced`; `setOtelApi` became `otel: { api }` per instance.
- Inline handlers enqueue with the queue definition (`ctx.createJob(sendEmail, input)`), not the name. Worker/client methods and a separate `handlers` registry use names. Do not mix inline handlers and a `handlers` registry on one worker.
- Run `migrate()` with a DB owner before producers. Enqueue does no migration checks. Enqueue-only roles need Graphile's table/sequence/RLS grants, plus `SELECT, INSERT, UPDATE, DELETE` on `bgw_idempotency_keys`.
- Pool size: `Σ concurrency + 2 per started instance (LISTEN + maintenance) + producer headroom`. `pgPoolSize(runners)` covers the first two.
- In a pool, every queue must name a `runner` and every named runner needs options.
- `prepareJob` must run before opening the transaction. Graphile 0.17.3 can return fewer rows than inputs when a key is claimed during enqueue; `enqueueInTransaction` throws in that case so the transaction rolls back.
- `createJobs` is one atomic statement and is never chunked. Batch options have no shared `jobKey` or `idempotencyKey`; derive per-item keys with `deriveJobOptions`.
- A `jobKey` only holds while the job is pending. Use `idempotencyKey` + `idempotencyTtl` (default 30 days) to dedupe over time.
- Waits replay the handler from the top. Put side effects and slow reads before a wait in `ctx.step.run`, and keep step/wait order deterministic. `ChildJobFailedError` and `WaitTimeoutError` are non-retriable.
- `ctx.continue()` must not be swallowed by a `try/catch`; call it once per run. Keep time slices inside the queue `timeout`.
- Keep executions under 4 hours (Graphile reclaims beyond that). A handler that blocks the event loop for `staleAfter` looks dead to crash recovery and can run twice; raise `staleAfter` or turn `crashRecovery` off for that worker.
- `timeout` cannot kill code: pass `ctx.signal` to fetch/DB calls.
- Without `jobOutcomes`, a succeeded job is deleted and `getJob`/`getJobProgress` return not found/null. Enable `jobOutcomes` on every worker instance.
- Step results must survive JSON; Dates need a codec (`{ encode, decode }`).
- Graphile peer range is bounded to 0.17.x because of the private-table adapter; do not bump graphile-worker past it without a library release.
