# Runtime request-path SLO families

Status: v0 measurement and plan-shape contract
Owner: PR-6 relation-plan gate; PR-6b folded-access plan gates; later platform
budgets for percentile/error-budget ratification

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
| Prefix/typeahead search | Prefixes lower to explicit leakproof `COLLATE "C"` range quals over the stored fold column. The forced-RLS plan must contain that column in the intended btree's `Index Cond`. | The verdict measured **89.7 ms** for the former leaky `LIKE` form and **0.31 ms** for the shipped explicit range lowering. PR-6b's provider probe verifies the plan and Unicode/C-collation bounds, not latency. | Current in PR-6b for newly materialized tables; deferred-online installation on pre-existing tables belongs to the next materializer packet. |

## Measurement and extrapolation discipline

All latency figures above are measured values from the pinned-image debate, not
new measurements or estimates from PR-6b. PR-6 and PR-6b separately measure the
100-row planner threshold by seeding the real compiled Party tables
incrementally, running `ANALYZE`, and walking `EXPLAIN (FORMAT JSON)` under the
actual runtime role. The tests never disable sequential scans and require the
declared physical index name and intended index condition, so an unrelated
primary-key plan cannot make them green.

The `O(tenant partition)` and tenant-count-invariance statements are plan-shape
bounds, not latency extrapolations. The orchestrator verified the scope quals as
index conditions at a 100-tenant shape (one 100,000-row tenant and 99 1,000-row
tenants). Adding tenants therefore does not add rows to a given tenant's scan;
adding rows inside that tenant does. No p50/p95/p99, concurrency capacity, or
fleet error budget is inferred from these single-host measurements.

## Known materialization boundary

New module tables receive relation indexes, generated folded columns, and folded
indexes in their same-plan creation. Adding an index or a stored generated
column to an existing populated table is correctly classified as
`deferredOnlineFamily`: plain index creation can block writes, and adding the
stored column rewrites the table. The repository has neither the
non-transactional resumable executor needed for `CREATE INDEX CONCURRENTLY` nor
an online stored-column rewrite path. Party is therefore not upgraded by PR-6
or PR-6b. The next materializer packet owns those capabilities; no seconds-fast
or online-upgrade claim is made here.
