# Runtime request-path SLO families

Status: v0 measurement and plan-shape contract
Owner: PR-6 relation-plan gate; PR-6b folded-access plan gates; PR-6c
existing-table locking-DDL window; later platform budgets for
percentile/error-budget ratification

This document records the runtime request-path bounds the repository can defend
today. It does not turn one-host measurements into fleet percentiles or claim a
launch error budget. The binding measurement source is the converged
[RLS index-access verdict](../execution/debates/pr6-rls-index-access-verdict.md),
which used pinned PostgreSQL 16.14 as the `NOBYPASSRLS` runtime role against
tables with forced row-level security.

## Current objectives and bounds

| Request family | Current executable objective or bound | Measured reference | Next owner |
|---|---|---|---|
| Parent-to-children relation read | Every compiled relation has a btree on `(tenant_id, environment_id, relation_column)`, and the forced-RLS predicate must use that exact index by name once the table has 100 analyzed rows. | PR-6's provider probe observes the local planner flip at 100 rows and rejects a sequential scan, the wrong index, or an unknown JSON plan node. It is a plan-shape measurement, not a latency claim. | PR-6; deferred-online installation on pre-existing tables belongs to the next materializer packet. |
| Exact/advisory resolve and case-insensitive unique lookup | Every compiled folded equality key uses a stored `COLLATE "C"` fold column and a tenant/environment-leading btree. The forced-RLS predicate must use that folded column in the intended index condition once the table has 100 analyzed rows. | The verdict measured the prior per-row-fold resolve at **4,472 ms** and the shipped stored-column shape at about **0.33 ms** on a 500,000-row partition (**0.24 ms** under a forced generic plan). PR-6b's provider probe independently verifies the current plan shape, not those latency values. | Current in PR-6b for newly materialized tables; deferred-online installation on pre-existing tables belongs to the next materializer packet. |
| Unanchored substring search | Bounded tenant/environment partition scan over the stored folded column. PostgreSQL's non-leakproof `textlike` prevents any index shape from serving this predicate through forced RLS; cost remains `O(rows in the tenant partition)`, not `O(all tenants)`, but the fold is no longer evaluated per row. | The verdict measured **1,005 ms** for the former fold-per-row 20-match exit. The shipped stored-fold shape measured **123 ms** for that case and **188 ms** for a zero-match full-partition scan on 500,000 rows. | A future search projection is trigger-driven only if real partitions exceed the verdict's threshold. |
| Prefix/typeahead search | Not a current compiled query mode. PR-6b's literal range prototype was removed because the existing substring input treats `%`, `_`, and `\` as SQL `LIKE` pattern syntax; shipping literal prefix bounds beside it would create two incompatible escaping contracts. | The verdict's **89.7 ms** leaky-`LIKE` and **0.31 ms** range figures remain measured design evidence, not current capability. | The queued prefix-semantics packet decides literal text versus user-visible pattern semantics before range lowering returns. |

## Measurement and extrapolation discipline

All latency figures above are measured values from the pinned-image debate, not
new measurements or estimates from PR-6b. PR-6 and PR-6b separately measure the
100-row planner threshold by seeding the real compiled Party tables
incrementally and running `ANALYZE` under the actual runtime role. PR-6 walks
`EXPLAIN (FORMAT JSON)` for relations. PR-6b walks
`EXPLAIN (ANALYZE, FORMAT JSON)` for folded equality, never disables sequential
scans, and requires both zero rows removed by post-filter across the entire plan
tree and a before/after `pg_stat_user_indexes.idx_scan` increase on the exact
accepted folded index. `pg_stat_force_next_flush()` makes the execution counter
observable after the query transaction returns idle. A scope-prefix scan on an
unrelated primary key cannot make the folded gate green, and an expected-index
scan whose folded equality is demoted to a post-filter cannot make it green
either.

The `O(tenant partition)` and tenant-count-invariance statements are plan-shape
bounds, not latency extrapolations. The orchestrator verified the scope quals as
index conditions at a 100-tenant shape (one 100,000-row tenant and 99 1,000-row
tenants). Adding tenants therefore does not add rows to a given tenant's scan;
adding rows inside that tenant does. No p50/p95/p99, concurrency capacity, or
fleet error budget is inferred from these single-host measurements.

## Existing-table materialization window

PR-6c processes `deferredOnlineFamily` elements through PostgreSQL's ordinary,
transactional locking DDL: `CREATE INDEX` and `ALTER TABLE ... ADD COLUMN ...
GENERATED ... STORED`. It deliberately does not use `CREATE INDEX
CONCURRENTLY`. A step's `STARTED` and `APPLIED` receipts share the DDL
transaction, so failure cannot leave either the DDL or its receipt committed by
itself.

The reproducible generated-column rehearsal runs the pinned PostgreSQL image in
the repository's 256 MiB disposable container. It seeds the real compiled
module table, observes the materializer waiting for `AccessExclusiveLock`,
queues a writer behind that DDL, releases the initial blocker, and measures with
`performance.now()` until the writer commits. These are single-host blocking
windows, not fleet percentiles:

| Populated rows | Observed queued-writer blocking window |
|---:|---:|
| 10,000 | 1,317.647 ms |
| 25,000 | 3,502.750 ms |

The promotion trigger is **2,000 ms of rehearsed writer blocking** on the
largest representative existing table. An in-place upgrade whose pinned-image
rehearsal reaches or exceeds 2,000 ms requires an online strategy before it is
approved without a maintenance window. The 25,000-row observation crosses that
trigger: the locking path is usable only with an explicit window at that scale,
and is not described as online. Rehearse every populated-table upgrade against
representative data; row count is not itself the promotion criterion because
row width, indexes, storage, and hardware all affect rewrite time.

### The window is platform-wide, not table-local

Recorded from the PR-6c Fable confirm (2026-07-26), which found it after review
round 1 had closed. Non-blocking for that packet; binding on how the window is
governed.

The measurement above is **writer blocking on the target table**. The actual
exclusion during a rewrite is wider: every materializer transaction — all tenants —
takes a single exclusive advisory key shared with kernel migrations. Before PR-6c
those transactions were short by construction. A deferred-family element transaction
now runs for the full rewrite duration.

So during a 1.3-3.5 s rewrite (10k-25k rows; unbounded above), **any other tenant's
`prepare` or `executeApprovedAttempt` fails `MIGRATION_LOCK_TIMEOUT`**, and kernel
migration replay queues for the whole rewrite. The failure arrives sooner than the
nominal timeout suggests: `maximumRetries: 5` at ~50 ms trips at roughly 300 ms,
while `timeoutMilliseconds: 5_000` is nearly unreachable.

This is availability, not correctness — failures are loud and retryable, and no data
path is corrupted. But a maintenance window planned for one tenant's table must be
understood to exclude **concurrent materializer work and migration replay
platform-wide** for its duration.

### The trigger is procedural, not mechanical

Also recorded from that confirm. Nothing in the activation path consumes rehearsal
evidence, so the 2,000 ms trigger holds only if an operator chooses to run the
documented rehearsal. That is a prose gate in a program whose AGENTS.md §6 requires
gates to observe the fact they assert.

Acceptable while no populated production table exists. It should become a **coded
admission input** when the online-strategy packet lands — approval consuming
rehearsal evidence rather than trusting that it was produced.

The attempted 100,000-row rehearsal did not yield a timing sample. PostgreSQL
returned SQLSTATE `53100` while extending the rewritten relation because the
test helper caps its data directory at 256 MiB. That failure is a harness
capacity limit, not evidence for a 100,000-row blocking window. Future online
work must cover both index construction and stored generated-column rewrites;
adding `CREATE INDEX CONCURRENTLY` alone would not satisfy this boundary.
