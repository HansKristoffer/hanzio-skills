---
name: postgres-tuning
description: Audit and optimize our PostgreSQL 14-18 databases behind Prisma apps, with a read-only audit script, a ranked findings report, safe migrations and before/after measurement. Covers slow-query forensics with pg_stat_statements and EXPLAIN, indexes (B-tree, partial, covering, BRIN, GIN, pgvector HNSW), autovacuum and bloat, async I/O and memory settings, connection pooling, partitioning, keyset pagination and Postgres-backed queues. Use when asked to optimize, audit or health-check a Postgres database, when a query or endpoint is slow, when reading an execution plan, when adding an index or a Prisma migration for one, when tuning postgresql.conf or autovacuum, when setting up PgBouncer, or when a table outgrows a single partition.
---

# PostgreSQL Tuning

Finds and fixes what makes our PostgreSQL databases slow, then proves the fix with numbers. The audit script runs on PG14+; the tuning notes target PG17/18. It optimizes performance across I/O, query execution, indexing, and maintenance. Covers the native AIO subsystem introduced in PostgreSQL 18, forensic query plan analysis with EXPLAIN BUFFERS (auto-included in PG18), B-tree skip scans for composite indexes, native UUIDv7 generation, and autovacuum tuning for high-churn tables.

**When to use:** Optimizing a database ("make our Postgres faster", "audit this database"), diagnosing a slow query or endpoint, reading an execution plan, choosing and migrating indexes, tuning autovacuum, memory, I/O and pooling.

**When NOT to use:** Schema design, application-level caching strategy, database selection decisions.

## Process: optimizing a database

1. **Context.** Read the repo's `AGENTS.md` / `CLAUDE.md`; their rules win. Find which database and environment the user means, its Postgres version, where it runs (see **Where our databases run**) and whether you have production access. Read [safety](references/safety.md) before connecting to production.
2. **Baseline.** Run the read-only audit and keep the output; it is the "before" for every change:

   ```bash
   psql "$DATABASE_URL" -X -f <this skill>/scripts/audit.sql > /tmp/pg-audit-before.txt 2>&1
   ```

   Save it outside the repo unless asked: it contains schema and query text. If section 4 says `pg_stat_statements` is missing, enabling it is finding number one; the rest of the audit still works.
3. **Read the code behind the top queries.** Map each slow query from section 4 to its Prisma call ([prisma](references/prisma.md)). Most fixes are an index or a changed call, not a setting.
4. **Diagnose.** `EXPLAIN` the top queries ([query-plan-analysis](references/query-plan-analysis.md)), using `EXPLAIN (GENERIC_PLAN)` on PG16+ for the parameterized text. Look at plans on production-sized data; a dev database with 100 rows plans differently.
5. **Report and propose, then stop.** Write the report below and wait for approval. Nothing that writes runs on production before that.
6. **Apply.** Indexes and table settings through Prisma migrations, code changes as normal commits, server settings with `ALTER SYSTEM` in an agreed window. One fix per migration or commit, so a regression points at one change.
7. **Verify.** After deploy, reset the statistics of only the queries you changed, let real traffic run (a day for daily patterns), then compare with the baseline:

   ```sql
   SELECT pg_stat_statements_reset(0, 0, <queryid>); -- one query; needs approval on production
   ```

   Re-run the audit and fill in the report's results table. A fix that did not move its number is reverted or explained.

### Ranking findings

Fix in this order; within a group, by the time or size it costs:

1. **Risks to availability:** transaction ID age over 50% (section 16), a sequence over 50% used (17; Prisma `Int @id` is int4), invalid indexes (8), sessions idle in transaction for minutes (14), connections near `max_connections` (2).
2. **Missing indexes** on foreign keys of large or frequently joined tables (5), and on the filters of the top queries (4, 9).
3. **The top queries** by `pct_total` in section 4: anything over 10% of total time is worth a plan.
4. **Write overhead:** unused (6) and redundant (7) indexes. Check that a replica does not use an "unused" index before dropping it, and that `stats_reset` (section 1) is weeks old.
5. **Maintenance:** per-table autovacuum for tables with high `dead_pct` or old `last_analyze` (10), `fillfactor` for tables with low `hot_update_pct`.
6. **Server settings** (3, 12, 13, 18) last, sized to the machine's memory.

### Report template

```markdown
# Postgres audit: <database> (<environment>), <date>

Postgres <version> on <host>, <db_size>, stats since <stats_reset>, pg_stat_statements <on/off>.

## Findings

### 1. <Title: what is wrong, in one line>

- **Evidence:** <numbers from audit section N or the EXPLAIN plan>
- **Fix:** <migration SQL, schema.prisma change or code change, with file paths>
- **Risk:** <locks taken, table rewrite or not, deploy order, how to roll back>
- **Verify by:** <queryid and its mean_ms / total_ms before; the number that should drop>

## Not changing

<Things that looked wrong but are fine, and why.>

## Results

| Finding | Metric | Before | After |
| ------- | ------ | ------ | ----- |
```

## Where our databases run

Assumptions to confirm on each project: production on Railway Postgres, local development in Docker started by buncargo (`dev.config.ts`). Check before relying on either.

- **Railway:** use the `use-railway` skill for the CLI. `railway connect <postgres-service>` opens `psql`; for the audit script, take `DATABASE_PUBLIC_URL` from the Postgres service's variables. Check whether the role is a superuser (`SELECT rolsuper FROM pg_roles WHERE rolname = current_user;`): settings changes and `pg_stat_statements` need it.
- **Settings on Railway:** there is no `postgresql.conf` to edit in the repo. Use `ALTER SYSTEM` (it persists on the volume) and restart the service for restart-only settings. Size memory settings from the service's memory limit and its real usage in Railway's metrics, not from the host machine.
- **Enabling `pg_stat_statements`:** read `SHOW shared_preload_libraries;` first and append, never overwrite: `ALTER SYSTEM SET shared_preload_libraries = '<existing>,pg_stat_statements';`, also `ALTER SYSTEM SET track_io_timing = on;`, restart, then `CREATE EXTENSION pg_stat_statements;` in each database. All of it needs approval.
- **Local Docker:** settings go in the compose service's `command` (`-c shared_preload_libraries=pg_stat_statements`). Local plans are only useful with production-like row counts.

## Our stack

- **Prisma owns the schema.** Express indexes in `schema.prisma` (`@@index`, `@@unique`, `@@index(..., type: Gin|Brin|Hash)`) so `prisma migrate` does not drop them. Partial indexes, `INCLUDE`, `NULLS NOT DISTINCT`, `fillfactor`, per-table autovacuum settings and partitioning have no Prisma syntax: write them in a migration created with `prisma migrate dev --create-only` and edit the SQL ([prisma](references/prisma.md)).
- **`CREATE INDEX CONCURRENTLY` in a migration:** keep it as the only statement in its migration file. Postgres runs a multi-statement script as one implicit transaction and rejects `CONCURRENTLY` inside it. On a small table a plain `CREATE INDEX` is fine.
- **Pagination:** Prisma's `cursor` + `take` is keyset pagination; it needs a unique, indexed sort key ([pooling-and-patterns](references/pooling-and-patterns.md)).
- **Queues:** jobs go through graphile-worker (via `better-graphile-worker`, see the `our-libs` skill), which already claims jobs with `FOR UPDATE SKIP LOCKED`. Do not hand-roll a job table.
- **Pooling:** the app may go through PgBouncer in transaction mode; migrations and graphile-worker (it uses `LISTEN`/`NOTIFY`) need a direct or session-mode connection. Check how the repo splits these URLs before changing either.
- **UUIDs:** Prisma's `@default(uuid(7))` generates UUIDv7 in the client; `@default(dbgenerated("uuidv7()"))` uses the PG18 built-in. Either fixes the random-insert index churn of UUIDv4 keys.
- **What rarely matters at our size:** async I/O, partitioning and checkpoint tuning. Look at them only after the audit shows I/O-bound queries or tables over ~100 GB.

**Key monitoring views:**

- `pg_stat_statements`: slow query patterns by cumulative execution time
- `pg_stat_io`: I/O by backend type, object, and context (PG16+)
- `pg_stat_checkpointer`: checkpoint frequency and timing (PG17+; previously in `pg_stat_bgwriter`)
- `pg_stat_user_tables`: dead tuple counts for bloat detection and autovacuum monitoring
- `pg_statio_user_tables`: buffer cache hit ratios per table
- `pg_aios`: in-progress AIO operations (PG18+)

## Quick Reference

| Pattern               | Configuration / Query                   | Key Points                                                                                         |
| --------------------- | --------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Async I/O             | `io_method = worker` or `io_uring`      | PG18 default is `worker`; `io_uring` Linux-only (kernel 5.1+, requires liburing build flag)        |
| I/O concurrency       | `io_max_concurrency` and `io_workers`   | `io_workers` defaults to 3; `io_max_concurrency` defaults to -1 (auto-calculated)                  |
| Forensic EXPLAIN      | `EXPLAIN (ANALYZE, BUFFERS, SETTINGS)`  | PG18 auto-includes BUFFERS with ANALYZE; target Shared Hit > 95%                                   |
| UUIDv7 primary keys   | `DEFAULT uuidv7()`                      | PG18 built-in; time-ordered, monotonic within a session; RFC 9562 compliant                        |
| B-tree skip scan      | Composite index on `(a, b)`             | PG18 skips leading column; works best with low-cardinality prefix and equality on trailing columns |
| Aggressive autovacuum | `autovacuum_vacuum_scale_factor = 0.01` | Triggers at 1% row change instead of default 20%                                                   |
| Shared buffers        | Start at 25% of RAM                     | Do not exceed 40% without benchmarking                                                             |
| work_mem tuning       | `SET work_mem = '64MB'` per session     | Prevents sort spills to disk; allocated per operator, not per query                                |
| BRIN index            | `CREATE INDEX USING brin(...)`          | 100x smaller than B-tree for physically ordered time-series data                                   |
| HNSW vector index     | `USING hnsw (col vector_cosine_ops)`    | Tune `m` (default 16) and `ef_construction` (default 64) for recall vs speed                       |
| GIN index             | `CREATE INDEX USING gin(...)`           | JSONB containment, full-text search, array operators; slower writes                                |
| Checkpoint tuning     | `checkpoint_timeout = 30min`            | Spread writes over 90% of timeout window to avoid I/O storms                                       |
| WAL compression       | `wal_compression = zstd`                | Available since PG15; reduces WAL I/O 50-70% for write-heavy workloads                             |
| Bloat detection       | `pg_stat_user_tables.n_dead_tup`        | Over 30% dead: `REINDEX CONCURRENTLY` for index bloat, `pg_repack` for table bloat                 |
| I/O monitoring        | `SELECT * FROM pg_stat_io`              | Watch `evictions` (cache too small) and `extends` (fast growth)                                    |
| Checkpoint monitoring | `pg_stat_checkpointer`                  | PG17+ moved checkpoint stats out of `pg_stat_bgwriter`                                             |

## Key Version Changes

**PostgreSQL 18:**

- Native async I/O via `io_method` parameter (reads only; writes remain synchronous)
- Built-in `uuidv7()` function with monotonic ordering within a session (RFC 9562)
- `uuidv4()` alias for `gen_random_uuid()` and `uuid_extract_timestamp()` for UUIDv7
- B-tree skip scan for composite indexes (equality on trailing columns, low-cardinality prefix)
- EXPLAIN ANALYZE auto-includes buffer statistics without specifying BUFFERS
- `pg_stat_io` gains byte-level columns (`read_bytes`, `write_bytes`, `extend_bytes`); `op_bytes` removed
- `effective_io_concurrency` default changed from 1 to 16
- AIO monitoring via `pg_aios` system view for in-progress I/O operations

**PostgreSQL 17:**

- Checkpoint statistics moved from `pg_stat_bgwriter` to `pg_stat_checkpointer`
- Column renames: `checkpoints_timed` to `num_timed`, `checkpoints_req` to `num_requested`
- `buffers_backend` and `buffers_backend_fsync` removed from `pg_stat_bgwriter` (now in `pg_stat_io`)

**PostgreSQL 15:**

- `wal_compression` expanded from boolean to support `pglz`, `lz4`, and `zstd` algorithms

## Common Mistakes

| Mistake                                                            | Correct Pattern                                                                                          |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| Using `uuid_generate_v7()` or `gen_random_uuid()` for ordered keys | PG18 provides built-in `uuidv7()` for time-ordered UUIDs; pre-PG18 use `pg_uuidv7` extension or Prisma `uuid(7)` |
| Using `max_async_ios` as a configuration parameter                 | The correct PG18 parameter is `io_max_concurrency` (max concurrent I/O ops per process)                  |
| Querying `pg_stat_bgwriter` for checkpoint statistics on PG17+     | Checkpoint stats moved to `pg_stat_checkpointer` in PG17; columns renamed (`num_timed`, `num_requested`) |
| Using SELECT \* in high-frequency queries                          | Select only needed columns (Prisma `select`) to reduce I/O and allow index-only scans                    |
| Ignoring sequential scans on tables over 10k rows                  | Add targeted indexes on columns used in WHERE, ORDER BY, and JOIN clauses                                |
| Setting shared_buffers above 40% of RAM without testing            | Start at 25% and benchmark; excessive allocation causes OS page cache contention                         |
| Leaving autovacuum at default settings for high-churn tables       | Tune `autovacuum_vacuum_scale_factor` to 0.01 for tables with frequent UPDATE/DELETE                     |
| Over-indexing columns rarely used in queries                       | Every extra index slows UPDATE/INSERT and prevents HOT (Heap Only Tuple) updates                         |
| Expecting B-tree skip scan to work with range predicates           | PG18 skip scan only works with equality operators on trailing columns                                    |
| Ignoring "External Merge Disk" in query plans                      | Increase work_mem for specific sessions; it indicates sort spills to disk                                |
| Setting `io_method = io_uring` without verifying build flags       | PostgreSQL must be built with `--with-liburing` and requires Linux kernel 5.1+                           |
| Assuming PG18 AIO accelerates writes                               | AIO in PG18 only covers reads (seq scans, bitmap heap scans, VACUUM); writes remain synchronous          |
| Adding a partial or covering index by hand outside a migration     | Put it in a `--create-only` Prisma migration, or the next `migrate dev` drift check flags it             |

## References

- [Async I/O configuration and storage tuning](references/aio-tuning.md)
- [Query plan analysis and operator forensics](references/query-plan-analysis.md)
- [Indexing strategies and bloat management](references/indexing-and-bloat.md)
- [Connection pooling, partitioning, and query patterns](references/pooling-and-patterns.md)
- [Production safety: approvals, locks and safe migrations](references/safety.md)
- [Prisma query and schema patterns](references/prisma.md)
- [Read-only audit script](scripts/audit.sql)
