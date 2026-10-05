# Execution: changing an external system safely

Read this when the engine writes to a system it doesn't own. A read-only engine needs none of it.

## Intent, plan, receipt

| Stage | What it is | Who reads it |
| --- | --- | --- |
| **Intent** | What the user asked for: a selection plus operations. Reusable, cheap to edit. | Planning |
| **Plan** | The concrete commands with their expected before-states, **sealed** (frozen and hashed). | Preview, approval, execution |
| **Receipt** | Only what the external system confirmed: observed before, applied after. | History, undo |

Approval is a compare-and-set on the plan hash, so nobody approves a plan that changed underneath them. Approval and enqueueing the run commit in one transaction. Preview reads plans; undo reads receipts, never plans.

## Admission

A pure function decides whether a command may still run: compare the external system's current state with the state the plan expected. The expected state is the baseline plus the confirmed effects of the plan's own earlier commands, so a plan's own change is never mistaken for drift. Drift is a conflict reported per command, not a crash.

## Durable effects

Every external write is an **attempt**:

1. Persist the attempt (its commands and payload digest) **before** sending.
2. Send through one shared write wrapper that forces the client library's retries to 0 for mutations and classifies the result: responded, rejected, or unknown. Only known pre-execution error codes count as "not applied". An HTTP 200 is not success; read the body.
3. Record the outcome. The union is wider than success and failure: `applied | notApplied | unknown | failed | pending`, plus `unresolved` / `deferred` at the run level.
4. A timeout is `unknown`. It must be **observed** (read back) before anything is retried.
5. Evidence is an append-only log per attempt.

## Derive guarantees, don't claim them

An adapter declares facts (does this write carry an idempotency key? a compare token?). The runtime derives its recovery class from those facts:

| Recovery class | When | After `unknown` |
| --- | --- | --- |
| `idempotent` | the write has an idempotency key | replay the same attempt |
| `conditional` | the write has a compare token / ETag | no blind retry; a late original fails as stale |
| `checkedBeforeWrite` | neither | nothing is retried automatically; past a deadline it goes to the user |

Nothing is idempotent by default. Retry policy is a total table, `retryDecision[recoveryClass][observation]`, so a new class or observation can't be forgotten.

## Checked write (no compare token)

1. Re-read the target right before writing. If it differs from the expected state, that command is a conflict and nothing is sent.
2. Write.
3. Read back. A different value is a conflict.
4. Map the external system's user errors back to the exact command by input index.

Each command is its own attempt with its own outcome, even when several attempts travel in one request for efficiency. Receipts record the value read before and the value read back, never the claim that the observed value was the one replaced.

## Runs, leases, claims

- **One worker per run.** A lease carries a fencing token, and every state write includes it (`... WHERE run_id = $1 AND lease_token = $2`). A zombie worker's writes affect zero rows.
- **Acquire, reconcile, advance**, in that order, enforced by the types (`advance` takes a `ReconciledLease`).
- **Claims belong to the run, not the worker**, have a primary key so two concurrent claims end with one owner, and are never released while effects they protect are unsettled.
- **The run driver** is the only module that imports the queue. One job per slice, keyed `run:{id}:{seq}`; a sequence number on the run row supersedes stale jobs. An advance returns `yield | waitUntil | waitForWake`; waiting never spends a retry. A recovery sweep re-enqueues stalled runs.
- **Tenant scoping is the only loading.** Engine tables are queried by ID only inside `storeFor(tenant)`, which returns `TenantOwned<T>`. Requests get the trusted tenant from verified auth; workers from the persisted job plus a check that the tenant is still installed or active.

## Undo

Plan undo from receipts only, through a total inverse map over command kinds. Offer explicit policies (skip what changed since, or overwrite). The inverse is an ordinary run: same admission, same durable effects, outcomes reported per effect.

## Bulk operations

When the external system has a bulk API, tag the attempt ID inside the remote payload (`# engine-attempt:<id>`) so crash recovery can find which remote job is yours, and hold a per-tenant slot claim if the system allows one bulk job at a time.

## Query semantics

If the same selection runs in two places (SQL for planning, in memory for preview or admission), implement it twice and test both against truth tables stored as data, never against each other's output. Values are always bound parameters. Paging is keyset with an ID tie-breaker. Null, blank, negation and quantifiers belong to the compiler, not to each operator.
