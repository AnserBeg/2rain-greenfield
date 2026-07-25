# Runtime request-path SLO families

Status: v0 measurement and plan-shape contract
Owner: PR-6 relation-plan gate; PR-6b folded-column and prefix-range work;
later platform budgets for percentile/error-budget ratification

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
| Exact/advisory resolve | Today: bounded tenant/environment partition scan with the fold evaluated per row; cost is `O(rows in the tenant partition)`, not `O(all tenants)`. | Shipped `fold(name) = fold(const)` measured **4,472 ms** on a 500,000-row partition. PR-6b's ratified stored-folded-column shape measured about **0.33 ms** (**0.24 ms** under a forced generic plan), but that is not shipped capability. | PR-6b before G3. |
| Unanchored substring search | Today: bounded tenant/environment partition scan with the fold evaluated per row. PostgreSQL's non-leakproof `textlike` prevents any index shape from serving this predicate through forced RLS. | Current fold-per-row search measured **1,005 ms** for a 20-match exit on a 500,000-row partition. The PR-6b stored-fold prototype removes the per-row fold and measured **123 ms** for that case and **188 ms** for a zero-match full-partition scan; it remains a scan. | PR-6b removes per-row folding; a future search projection is trigger-driven only if real partitions exceed the verdict's threshold. |
| Prefix/typeahead search | Not a current indexed capability. The present `LIKE` form remains non-indexable under forced RLS. | The debate measured **89.7 ms** for the leaky `LIKE` form and **0.31 ms** for PR-6b's ratified explicit leakproof range lowering. The latter is future work, not current behavior. | PR-6b. |

## Measurement and extrapolation discipline

All latency figures above are measured values from the pinned-image debate, not
estimates. PR-6's 100-row relation threshold is separately measured by seeding
the real compiled Party tables incrementally, running `ANALYZE`, and walking
`EXPLAIN (FORMAT JSON)` under the actual runtime role. The test never disables
sequential scans and requires the declared physical index name, so an unrelated
primary-key plan cannot make it green.

The `O(tenant partition)` and tenant-count-invariance statements are plan-shape
bounds, not latency extrapolations. The orchestrator verified the scope quals as
index conditions at a 100-tenant shape (one 100,000-row tenant and 99 1,000-row
tenants). Adding tenants therefore does not add rows to a given tenant's scan;
adding rows inside that tenant does. No p50/p95/p99, concurrency capacity, or
fleet error budget is inferred from these single-host measurements.

## Known materialization boundary

New module tables receive relation indexes in their same-plan creation. A
relation index added to an existing table is correctly classified as
`deferredOnlineFamily`: plain `CREATE INDEX` would block writes, while
`CREATE INDEX CONCURRENTLY` requires a non-transactional resumable executor and
`indisvalid` reconciliation that do not exist yet. Party is therefore not
upgraded by PR-6. The next materializer packet owns that capability; no
seconds-fast or online-upgrade claim is made here.
