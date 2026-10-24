---
title: Prisma Query and Schema Patterns
description: Tracing slow SQL back to Prisma calls, the Prisma patterns that produce slow queries, index syntax in schema.prisma, migrations for what Prisma cannot express, and connection pool sizing
tags: [prisma, n-plus-one, pg-trgm, indexes, migrations, connection-pool]
---

# Prisma Query and Schema Patterns

Most slow queries in our apps come from how Prisma is called, not from Postgres settings. Fix the call or add the index; tune the server last.

## From slow SQL to the Prisma call

1. Take the query text from audit section 4. Prisma's SQL is recognizable: quoted identifiers (`"public"."Order"."organizationId"`), `$1` parameters, `LIMIT $n OFFSET $m`.
2. Grep the code for the model and the filtered fields: `prisma.order.findMany` together with `organizationId`. Repositories and oRPC handlers are the usual homes.
3. To see SQL and timing for a code path locally:

   ```ts
   const prisma = new PrismaClient({ log: [{ emit: 'event', level: 'query' }] });
   prisma.$on('query', (e) => console.log(e.duration, 'ms', e.query, e.params));
   ```

4. Explain the parameterized text from `pg_stat_statements` directly on PG16+ without picking values:

   ```sql
   EXPLAIN (GENERIC_PLAN) SELECT … WHERE "organizationId" = $1 ORDER BY "createdAt" DESC LIMIT $2;
   ```

   A generic plan shows index choice but no timing. For timing, substitute real values from the logs and run `EXPLAIN ANALYZE` (SELECT only; see [safety](safety.md)).

## Patterns that make slow queries

| Pattern in code                                                     | What Postgres sees                                         | Fix                                                                                                         |
| ------------------------------------------------------------------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `await prisma.x.findFirst(...)` inside a `for` loop                 | One query per row: thousands of calls in section 4         | One `findMany({ where: { id: { in: ids } } })`, then map in memory. Prisma batches `findUnique` calls in the same tick, not sequential `await`s or `findFirst` |
| `include` on a relation with thousands of rows                      | A second query with `WHERE "parentId" IN ($1 … $5000)`     | Paginate the relation (`include: { items: { take: 50 } }`), or try `relationLoadStrategy: 'join'` and compare plans |
| `findMany()` with no `take`                                         | Reads the whole table as it grows                          | Always `take`; keyset with `cursor` for lists                                                                 |
| `skip: page * size` on deep pages                                   | `OFFSET` scans and discards every earlier row              | `cursor` + `take` on a unique, indexed sort key ([pooling-and-patterns](pooling-and-patterns.md))            |
| No `select` on models with big `Json` or `String` columns           | Every column, TOAST included, read and sent                | `select` the fields used, or `omit` the heavy ones                                                           |
| `contains` / `endsWith`, or `mode: 'insensitive'`                   | `LIKE '%x%'` / `ILIKE`: B-tree unusable, sequential scan   | `pg_trgm` GIN index (below). `startsWith` without `insensitive` can use a B-tree with `text_pattern_ops`     |
| `prisma.x.count()` on a large table for a dashboard                 | Full index or table scan on every page load                | Cache it, or use the estimate `SELECT reltuples FROM pg_class WHERE oid = '"X"'::regclass`                   |
| `where: { a }, orderBy: { b }` with separate indexes on `a` and `b` | Scans by one index and sorts or filters the rest           | One composite `@@index([a, b])`, equality column first                                                       |
| `updateMany` / `deleteMany` over a large set                        | One huge transaction, row locks and bloat                  | Batch by id range in a graphile-worker job                                                                    |
| `$transaction(async (tx) => { … await fetch(…) … })`                | A connection and its row locks held during network calls   | Do external calls outside the transaction; keep it to the writes. Default timeout is 5 s for a reason        |
| `@default(uuid())` primary keys on hot insert tables                | Random inserts spread over the whole index                 | `@default(uuid(7))`                                                                                           |

## Indexes in schema.prisma

Postgres does not index foreign-key columns, and Prisma does not add the index on PostgreSQL. Every relation scalar used in `where`, joins or cascading deletes needs one (audit section 5):

```prisma
model Order {
  id             String   @id @default(uuid(7))
  organizationId String
  status         String
  createdAt      DateTime @default(now())
  metadata       Json?
  title          String

  organization Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)

  @@index([organizationId, createdAt(sort: Desc)])
  @@index([metadata], type: Gin)
  @@index([title(ops: raw("gin_trgm_ops"))], type: Gin) // needs the pg_trgm extension
}
```

A composite index whose first column is the foreign key also covers the foreign key; a separate single-column index is then redundant (audit section 7).

## Migrations for what Prisma cannot express

Partial indexes, `INCLUDE` columns, `NULLS NOT DISTINCT`, `fillfactor`, per-table autovacuum settings and partitioning have no schema syntax. Create an empty migration and write the SQL:

```bash
bunx prisma migrate dev --create-only --name order_status_partial_index
```

```sql
-- migration.sql: the only statement in this file, so it runs outside a transaction block
CREATE INDEX CONCURRENTLY IF NOT EXISTS "Order_pending_createdAt_idx"
  ON "Order" ("createdAt") WHERE status = 'pending';
```

The schema does not know about this index, so a later `migrate dev` may put a `DROP INDEX` for it in the generated migration. Read every generated migration and delete that line. Per-table settings migrations look the same:

```sql
ALTER TABLE "Session" SET (fillfactor = 80, autovacuum_vacuum_scale_factor = 0.02);
```

## Connection pool sizing

Count every client before raising anything:

```text
app instances × pool size per instance
+ graphile-worker pool (direct connection)
+ migrations, cron, admin and monitoring (~5)
≤ 80% of max_connections
```

- Prisma 6 with the Rust engine: pool size is the `connection_limit` URL parameter, default `num_cpus * 2 + 1` per `PrismaClient`.
- With a driver adapter (`@prisma/adapter-pg`, the default from Prisma 7): the `pg.Pool` `max` option, default 10.
- One `PrismaClient` per process. A client created per request (or per hot reload) opens a new pool each time; section 2 then shows connections climbing to `max_connections`.
- Many idle connections in section 2 usually mean the pool is too large, not too small. Raising `max_connections` costs memory per backend; add PgBouncer instead.
