-- Read-only health audit for one PostgreSQL 14+ database.
-- Run: psql "$DATABASE_URL" -X -f audit.sql > audit-$(date +%F).txt 2>&1
-- Every section is a SELECT; the session is forced read-only and time-limited.

\set ON_ERROR_STOP off
\pset pager off
\pset null '-'
SET default_transaction_read_only = on;
SET statement_timeout = '60s';
SET lock_timeout = '1s';
SET application_name = 'postgres-tuning-audit';

SELECT current_setting('server_version_num')::int >= 170000 AS pg17 \gset
SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_stat_statements') AS has_pss \gset

\echo '== 1. Server'
SELECT version(),
       current_database() AS database,
       pg_size_pretty(pg_database_size(current_database())) AS db_size,
       date_trunc('second', now() - pg_postmaster_start_time()) AS uptime,
       (SELECT stats_reset FROM pg_stat_database WHERE datname = current_database()) AS stats_reset;

\echo '== 2. Connections (in use vs max_connections)'
SELECT state, count(*) AS connections,
       current_setting('max_connections')::int AS max_connections
FROM pg_stat_activity
WHERE backend_type = 'client backend'
GROUP BY state
ORDER BY connections DESC;

\echo '== 3. Key settings (source = default means never tuned)'
SELECT name, setting, unit, source
FROM pg_settings
WHERE name IN (
  'shared_buffers', 'effective_cache_size', 'work_mem', 'maintenance_work_mem',
  'max_connections', 'random_page_cost', 'effective_io_concurrency', 'io_method',
  'max_wal_size', 'checkpoint_timeout', 'wal_compression',
  'autovacuum_max_workers', 'autovacuum_vacuum_scale_factor', 'autovacuum_vacuum_cost_limit',
  'shared_preload_libraries', 'idle_in_transaction_session_timeout', 'statement_timeout',
  'log_min_duration_statement', 'track_io_timing', 'jit')
ORDER BY name;

\echo '== 4. Top queries by total time (pg_stat_statements)'
\if :has_pss
SELECT queryid,
       calls,
       round(total_exec_time::numeric) AS total_ms,
       round((100 * total_exec_time / nullif(sum(total_exec_time) OVER (), 0))::numeric, 1) AS pct_total,
       round(mean_exec_time::numeric, 2) AS mean_ms,
       round(rows::numeric / nullif(calls, 0), 1) AS rows_per_call,
       round(100 * shared_blks_hit::numeric / nullif(shared_blks_hit + shared_blks_read, 0), 1) AS hit_pct,
       temp_blks_written,
       left(regexp_replace(query, '\s+', ' ', 'g'), 300) AS query
FROM pg_stat_statements
WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database())
ORDER BY total_exec_time DESC
LIMIT 25;
\else
\echo 'pg_stat_statements is not installed. See SKILL.md "Where our databases run" to enable it.'
\endif

\echo '== 5. Foreign keys with no index on their columns (slow joins and cascading deletes)'
SELECT c.conrelid::regclass AS table_name,
       c.conname AS constraint_name,
       (SELECT string_agg(a.attname, ', ' ORDER BY k.n)
          FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum, n)
          JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum) AS columns,
       c.confrelid::regclass AS references_table,
       pg_size_pretty(pg_relation_size(c.conrelid)) AS table_size
FROM pg_constraint c
JOIN pg_class t ON t.oid = c.conrelid
JOIN pg_namespace ns ON ns.oid = t.relnamespace
WHERE c.contype = 'f'
  AND ns.nspname NOT IN ('pg_catalog', 'information_schema')
  AND NOT EXISTS (
    SELECT 1 FROM pg_index i
    WHERE i.indrelid = c.conrelid
      AND i.indpred IS NULL
      AND (i.indkey::int2[])[0:cardinality(c.conkey) - 1] @> c.conkey
      AND (i.indkey::int2[])[0:cardinality(c.conkey) - 1] <@ c.conkey)
ORDER BY pg_relation_size(c.conrelid) DESC;

\echo '== 6. Unused indexes since stats_reset (not unique, not primary key; check replicas before dropping)'
SELECT s.relname AS table_name,
       s.indexrelname AS index_name,
       s.idx_scan,
       pg_size_pretty(pg_relation_size(s.indexrelid)) AS index_size
FROM pg_stat_user_indexes s
JOIN pg_index i ON i.indexrelid = s.indexrelid
WHERE s.idx_scan = 0
  AND NOT i.indisunique
  AND NOT i.indisprimary
  AND NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conindid = s.indexrelid)
ORDER BY pg_relation_size(s.indexrelid) DESC;

\echo '== 7. Redundant indexes (same columns as, or a leading prefix of, another index of the same type)'
SELECT a.indrelid::regclass AS table_name,
       a.indexrelid::regclass AS redundant_index,
       pg_get_indexdef(a.indexrelid) AS redundant_def,
       b.indexrelid::regclass AS covered_by,
       pg_get_indexdef(b.indexrelid) AS covered_by_def,
       pg_size_pretty(pg_relation_size(a.indexrelid)) AS redundant_size
FROM pg_index a
JOIN pg_class ac ON ac.oid = a.indexrelid
JOIN pg_index b ON b.indrelid = a.indrelid AND b.indexrelid <> a.indexrelid
JOIN pg_class bc ON bc.oid = b.indexrelid
JOIN pg_namespace ns ON ns.oid = ac.relnamespace
WHERE ns.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
  AND ac.relam = bc.relam
  AND NOT a.indisunique
  AND a.indpred IS NULL AND b.indpred IS NULL
  AND a.indexprs IS NULL AND b.indexprs IS NULL
  AND cardinality(a.indkey::int2[]) <= cardinality(b.indkey::int2[])
  AND array_to_string((b.indkey::int2[])[0:cardinality(a.indkey::int2[]) - 1], ' ') = a.indkey::text
  AND (cardinality(a.indkey::int2[]) < cardinality(b.indkey::int2[]) OR b.indisunique OR a.indexrelid > b.indexrelid)
ORDER BY pg_relation_size(a.indexrelid) DESC;

\echo '== 8. Invalid indexes (a failed CREATE INDEX CONCURRENTLY; drop and recreate)'
SELECT indrelid::regclass AS table_name, indexrelid::regclass AS index_name
FROM pg_index
WHERE NOT indisvalid;

\echo '== 9. Tables read mostly by sequential scan (over 10k rows)'
SELECT relname AS table_name,
       n_live_tup,
       seq_scan,
       seq_tup_read,
       idx_scan,
       round(seq_tup_read::numeric / nullif(seq_scan, 0)) AS rows_per_seq_scan
FROM pg_stat_user_tables
WHERE n_live_tup > 10000
  AND seq_scan > 0
ORDER BY seq_tup_read DESC
LIMIT 20;

\echo '== 10. Vacuum and analyze health'
SELECT relname AS table_name,
       n_live_tup,
       n_dead_tup,
       round(100 * n_dead_tup::numeric / nullif(n_live_tup + n_dead_tup, 0), 1) AS dead_pct,
       n_mod_since_analyze,
       round(100 * n_tup_hot_upd::numeric / nullif(n_tup_upd, 0), 1) AS hot_update_pct,
       date_trunc('second', greatest(last_vacuum, last_autovacuum)) AS last_vacuum,
       date_trunc('second', greatest(last_analyze, last_autoanalyze)) AS last_analyze,
       (SELECT reloptions FROM pg_class WHERE oid = relid) AS table_options
FROM pg_stat_user_tables
WHERE n_live_tup + n_dead_tup > 1000
ORDER BY n_dead_tup DESC
LIMIT 20;

\echo '== 11. Largest tables'
SELECT c.oid::regclass AS table_name,
       pg_size_pretty(pg_total_relation_size(c.oid)) AS total,
       pg_size_pretty(pg_relation_size(c.oid)) AS heap,
       pg_size_pretty(pg_indexes_size(c.oid)) AS indexes,
       pg_size_pretty(coalesce(pg_total_relation_size(c.reltoastrelid), 0)) AS toast,
       c.reltuples::bigint AS est_rows
FROM pg_class c
JOIN pg_namespace ns ON ns.oid = c.relnamespace
WHERE c.relkind IN ('r', 'p')
  AND ns.nspname NOT IN ('pg_catalog', 'information_schema')
ORDER BY pg_total_relation_size(c.oid) DESC
LIMIT 20;

\echo '== 12. Cache hit ratio (target over 99% for heap and index)'
SELECT round(100 * sum(heap_blks_hit)::numeric / nullif(sum(heap_blks_hit) + sum(heap_blks_read), 0), 2) AS heap_hit_pct,
       round(100 * sum(idx_blks_hit)::numeric / nullif(sum(idx_blks_hit) + sum(idx_blks_read), 0), 2) AS index_hit_pct
FROM pg_statio_user_tables;

\echo '== 13. Temp files and deadlocks since stats_reset (temp files mean work_mem spills)'
SELECT temp_files, pg_size_pretty(temp_bytes) AS temp_bytes, deadlocks,
       xact_commit, xact_rollback
FROM pg_stat_database
WHERE datname = current_database();

\echo '== 14. Long transactions and idle-in-transaction sessions (over 1 minute; they block vacuum)'
SELECT pid, usename, application_name, state,
       date_trunc('second', now() - xact_start) AS xact_age,
       wait_event_type, wait_event,
       left(regexp_replace(query, '\s+', ' ', 'g'), 200) AS last_query
FROM pg_stat_activity
WHERE xact_start < now() - interval '1 minute'
  AND pid <> pg_backend_pid()
ORDER BY xact_start;

\echo '== 15. Blocked queries and who blocks them'
SELECT blocked.pid AS blocked_pid,
       date_trunc('second', now() - blocked.query_start) AS waiting_for,
       left(regexp_replace(blocked.query, '\s+', ' ', 'g'), 150) AS blocked_query,
       blocker.pid AS blocker_pid,
       blocker.state AS blocker_state,
       left(regexp_replace(blocker.query, '\s+', ' ', 'g'), 150) AS blocker_query
FROM pg_stat_activity blocked
CROSS JOIN LATERAL unnest(pg_blocking_pids(blocked.pid)) AS b(pid)
JOIN pg_stat_activity blocker ON blocker.pid = b.pid;

\echo '== 16. Transaction ID wraparound (pct_to_forced_vacuum over 50% needs attention)'
SELECT c.oid::regclass AS table_name,
       x.xid_age,
       round(100 * x.xid_age::numeric / current_setting('autovacuum_freeze_max_age')::numeric, 1) AS pct_to_forced_vacuum
FROM pg_class c
JOIN pg_namespace ns ON ns.oid = c.relnamespace
LEFT JOIN pg_class toast ON toast.oid = c.reltoastrelid
CROSS JOIN LATERAL (SELECT greatest(age(c.relfrozenxid), age(toast.relfrozenxid)) AS xid_age) x
WHERE c.relkind IN ('r', 'm')
  AND ns.nspname NOT IN ('pg_catalog', 'information_schema')
ORDER BY x.xid_age DESC
LIMIT 10;

\echo '== 17. Sequences close to their limit (Prisma Int @id is int4: max 2147483647)'
SELECT schemaname || '.' || sequencename AS sequence_name,
       data_type,
       last_value,
       max_value,
       round(100 * last_value::numeric / max_value, 2) AS pct_used
FROM pg_sequences
WHERE last_value IS NOT NULL
ORDER BY last_value::numeric / max_value DESC
LIMIT 10;

\echo '== 18. Checkpoints (requested much higher than timed means max_wal_size is too small)'
\if :pg17
SELECT num_timed, num_requested, round(write_time) AS write_ms, round(sync_time) AS sync_ms, stats_reset
FROM pg_stat_checkpointer;
\else
SELECT checkpoints_timed AS num_timed, checkpoints_req AS num_requested,
       round(checkpoint_write_time) AS write_ms, round(checkpoint_sync_time) AS sync_ms, stats_reset
FROM pg_stat_bgwriter;
\endif

\echo '== Done'
