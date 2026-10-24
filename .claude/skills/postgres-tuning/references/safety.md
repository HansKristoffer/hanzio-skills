---
title: Production Safety
description: What may run against a production database without asking, what needs approval, and how to change schema and settings without locking out the app
tags: [production, locks, migrations, lock-timeout, alter-table, explain-analyze, alter-system]
---

# Production Safety

An optimization that locks a hot table for two minutes is an outage. Read this before running anything against production.

## What needs approval

| Action                                                                | Without asking | Needs approval                    |
| --------------------------------------------------------------------- | -------------- | --------------------------------- |
| `scripts/audit.sql` (read-only session, 60 s statement timeout)       | Yes            |                                   |
| `EXPLAIN` without `ANALYZE`, `EXPLAIN (GENERIC_PLAN)`                 | Yes            |                                   |
| `EXPLAIN ANALYZE` on a `SELECT`                                       | Yes, with `SET statement_timeout = '30s'` first; it runs the query | Over 30 s, or at peak traffic |
| `EXPLAIN ANALYZE` on `INSERT`/`UPDATE`/`DELETE`                       | Never outside `BEGIN; … ROLLBACK;` | Always on production   |
| Creating a read-only role, `pg_stat_statements_reset`, `CREATE EXTENSION` |            | Yes                               |
| Any migration, index, `VACUUM`, `ANALYZE`, `REINDEX`                  |                | Yes, through a reviewed migration |
| `ALTER SYSTEM`, restarts, killing sessions (`pg_terminate_backend`)   |                | Yes, with a time window           |

`EXPLAIN ANALYZE` executes the statement. On a write, the rows really change unless the transaction is rolled back, and triggers and foreign-key cascades fire.

## Read-only access

`audit.sql` forces `default_transaction_read_only = on` for its own session, so the normal app URL is safe for it. For repeated audits, ask for a dedicated role (PG14+):

```sql
CREATE ROLE db_audit LOGIN PASSWORD '…' IN ROLE pg_read_all_stats, pg_read_all_data;
ALTER ROLE db_audit SET default_transaction_read_only = on;
ALTER ROLE db_audit SET statement_timeout = '60s';
```

Without `pg_read_all_stats`, `pg_stat_activity` and `pg_stat_statements` hide other users' query text.

## The lock queue

Every `ALTER TABLE` takes a lock, usually `ACCESS EXCLUSIVE`. It waits behind any running transaction on that table, and every query arriving after it queues behind the waiting `ALTER`. A one-millisecond schema change behind a five-minute report blocks the whole app for five minutes.

Start every production migration with:

```sql
SET lock_timeout = '5s';
SET statement_timeout = '15min'; -- long enough for the index build, not forever
```

If it times out, nothing changed: find the long transaction (audit section 14) and retry.

## Schema changes that rewrite or scan the table

| Change                                              | What happens                                       | Safe pattern                                                                                                 |
| --------------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `CREATE INDEX`                                      | Blocks writes for the whole build                  | `CREATE INDEX CONCURRENTLY`, alone in its migration file                                                    |
| `ADD COLUMN … DEFAULT <constant or now()>`          | Instant (PG11+)                                    | Fine                                                                                                         |
| `ADD COLUMN … DEFAULT <volatile>` (`gen_random_uuid()`, `clock_timestamp()`) | Rewrites the table under `ACCESS EXCLUSIVE` | Add the column nullable, backfill in batches, then set the default                                  |
| `ALTER COLUMN … TYPE`                               | Usually a full rewrite plus index rebuilds         | New column, dual-write, backfill, switch reads, drop old. Exceptions: `varchar(n)` to larger `n` or `text`  |
| `ALTER COLUMN … SET NOT NULL`                       | Full scan under `ACCESS EXCLUSIVE`                 | `ADD CONSTRAINT c CHECK (col IS NOT NULL) NOT VALID;` then `VALIDATE CONSTRAINT c;` then `SET NOT NULL` (PG12+ skips the scan), then drop `c` |
| `ADD FOREIGN KEY`                                   | Scans the table, locks both tables                 | `ADD CONSTRAINT … FOREIGN KEY … NOT VALID;` then `VALIDATE CONSTRAINT` in a second migration                |
| `ADD UNIQUE` / `ADD PRIMARY KEY`                    | Builds the index while blocking writes             | `CREATE UNIQUE INDEX CONCURRENTLY idx …;` then `ADD CONSTRAINT … UNIQUE USING INDEX idx`                    |
| `RENAME COLUMN`, `DROP COLUMN`                      | Instant, but running app code breaks               | Deploy code that stops using the column first, then migrate                                                  |
| `VACUUM FULL`, `CLUSTER`                            | Rewrites under `ACCESS EXCLUSIVE`                  | `pg_repack`, or plain `VACUUM` and accept the space                                                          |
| `REINDEX`                                           | Blocks writes                                      | `REINDEX INDEX CONCURRENTLY` (PG12+)                                                                         |

Prisma generates the unsafe form of most of these. Check every generated migration for them before it reaches production, and edit the SQL (`prisma migrate dev --create-only`).

## Large backfills

`UPDATE big_table SET …` in one statement holds row locks on every row until it commits, bloats the table by its full size, and can lag replicas. Update in batches of 1,000-10,000 rows by primary key range, committing each batch, ideally as a graphile-worker job.

## Settings

- `ALTER SYSTEM SET name = value;` writes `postgresql.auto.conf` in the data directory. `SELECT pg_reload_conf();` applies reloadable settings.
- `shared_buffers`, `max_connections`, `shared_preload_libraries`, `io_method`, `wal_buffers` and `max_worker_processes` need a restart, which drops every connection. Schedule it.
- Check `pg_settings.pending_restart` after a reload to see what still waits for a restart.
- Prefer per-role or per-table settings (`ALTER ROLE app SET work_mem = '32MB'`, `ALTER TABLE … SET (autovacuum_…)`) over global ones: they are reversible and touch only what was measured.

## Killing sessions

`pg_cancel_backend(pid)` cancels the running query; `pg_terminate_backend(pid)` closes the connection and rolls back its transaction. Prefer cancel. Never terminate a session you have not identified (audit sections 14 and 15 show the query and application).
