# RLS index-access debate — converged verdict (2026-07-25)

Pipeline: `position-v1` -> two independent naive round-1 reviews (Codex
`gpt-5.6-sol` xhigh; Fable max) -> orchestrator adjudication plus two
orchestrator experiments on the pinned image -> `position-v2` -> two independent
naive round-2 reviews. Round 2 **converged**: both reviewers independently
recommended the same end state, the same next step, and independently rejected
the same alternatives. The debate is **CLOSED**. This document is binding input
to the storage/index work and to the agent query surface; packet writers follow
it and do not relitigate it.

Working files: `/home/rvham/debate-pr6-rls-search/` (`position-v1.md`,
`position-v2.md`, `r1-codex-reply.md`, `r1-fable-reply.md`, `r2-codex-reply.md`,
round-2 Fable reply recorded in the orchestrator transcript).

## The question

PostgreSQL will not evaluate a **non-leakproof** predicate before a row-level
security barrier, so such a predicate cannot become an index qual on a table
running `FORCE ROW LEVEL SECURITY`. Every module table does. The two
compiler-emitted runtime predicates that matter are therefore unindexed:

- resolve / unique lookup — `fold(col) = fold($1)`
- substring search — `fold(col) LIKE '%' || fold($1) || '%'`

This is a documented PostgreSQL behaviour, not a defect in this repository. The
external performance review's recommendation (a `pg_trgm` GIN index on the folded
column) **cannot work as specified**: `textlike` is not leakproof, so no index of
any shape serves a `LIKE` predicate under forced RLS. Prefix-anchored `LIKE 'x%'`
also fails — the `~~` RestrictInfo is rejected for leakiness before prefix-range
derivation is attempted.

## Ratified decisions (not reopenable)

**R1. Stored generated folded columns are the index mechanism.** The compiler
emits `<col>_folded text GENERATED ALWAYS AS (fold(col)) STORED` plus a btree on
`(tenant_id, environment_id, <col>_folded)`. The interpreter predicate becomes
`<col>_folded = fold($1)`. The row side is then plain `texteq`, which is
leakproof; the non-leakproof fold is applied only to the **parameter**, never to
protected rows. Verified empirically, including under a forced generic plan.

**R2. Coverage extends beyond unique business keys.** Today only
`caseInsensitiveUnique` columns receive a fold-expression index. Advisory resolve
keys must receive one too — in the Party fixture `number` is the identifier key
but **`name` is the advisory resolve key**, which is what an agent actually
resolves. The existing `search` index is a btree on the **raw** column and serves
no predicate the interpreter issues; it is pure write amplification and is
retired.

**R3. Prefix / typeahead search is indexable and must be lowered as a range.**
Btree text comparison operators are leakproof, so lowering `LIKE 'x%'` to explicit
range predicates (`col_folded >= p AND col_folded < p'`) obtains full index access
under forced RLS. Production requires C-collation-disciplined bound computation
(e.g. a `COLLATE "C"` folded column). This is generic lowering, not per-module
code. Only **unanchored** substring match remains unindexable.

**R4. Unanchored substring search stays a bounded partition scan.** Its cost is
`O(tenant partition)` and is **invariant in tenant count** — RLS quals bound every
scan to the tenant's own rows, so growing from 100 to thousands of tenants adds no
rows to any tenant's scan. Under R1 the per-row fold cost disappears, which is
most of the measured cost.

**R5. `LEAKPROOF` marking of the fold function is rejected.** It requires genuine
superuser (foreclosing managed PostgreSQL) and the materializer's
`CREATE OR REPLACE` silently clears the bit on every materialization — a ~2,000×
regression with no functional failure. R1 retires that trap by construction rather
than by test.

**R6. End-state topology is pooled shared-table pods with forced RLS inside each
pod**, sharded on `tenant_id` with environments colocated, and whale tenants tiered
into single-tenant pods. **No decision is required now: shard count of one is the
current architecture.** Pods are retroactively adoptable; schema-per-tenant is not.

**R7. Schema-per-tenant is rejected** as end state and as a schema-tier hybrid.
Measured: 1,000 schemas x 8 tables = 352 MB of empty catalog; ~800 schemas in one
transaction fails with `out of shared memory`; backend relcache grows ~25 KB per
touched relation and is unevictable, i.e. ~1 GB per backend at 1,000 tenants x 40
tables. Pooling dies in the 1,000-2,000 tenant range. Its isolation story is also
weaker than assumed: `search_path` governs only unqualified name resolution, so any
schema-qualified reference bypasses it — isolation would be convention, not
structure. Schema-tiering would fork the platform substrate into two permanently
proven security models; pod-tiering achieves the same ends with zero compiler
changes.

**R8. ADR-0009 is not amended. The agent does not write SQL.** The five-tool
boundary makes agent authority **principal-scoped**; any SQL grant makes it
**role-scoped**. Injection against a capability boundary yields a wrong answer;
injection against a syntax boundary yields an exfiltration primitive, and an ERP is
saturated with third-party-authored text. Read-only SQL against compiler-emitted
views is **also rejected**: view grants are role-level so per-principal permission
binding and classification are still lost, cost is unbounded, and the emitted views
become a second permanent contract surface that ADR-0011 exists to prevent.

**R9. Aggregation is Q1, which the plan already specifies** (§5.1, §5.9, §9.2.2) —
filters, traversal, joins, grouping, aggregates, reports, exports. The
orchestrator's "make Q0 compositional" framing was wrong and would have contradicted
the plan. Today the gateway rejects every tier other than Q0 and every filter other
than literal `true`. The `reporting` projection family is the right seam for
*declared* read models (dimensions, measures, lineage, freshness) and the wrong seam
for a second ingress or execution authority. Plan §12.8 already reserves an isolated
analysis workspace with a read-only SQL validator at **N5** — that is the sanctioned
long-term home for SQL-shaped analysis, not an operations-agent tool.

**R10. A privileged `SECURITY DEFINER` module reader (B) is not built.** A search
projection (F) gets a **numeric trigger**, not an implementation. Note that a
privileged path already exists and runs on every Q0 request
(`platform.read_tenant_release_artifacts`), so no topology "eliminates privileged
reads"; the question is only whether a *second* one for module business data is
added.

## Measured evidence (pinned image `postgres@sha256:57c72fd2…`, PostgreSQL 16.14)

All measurements as the `NOBYPASSRLS` runtime role under forced RLS, with the fold
declared exactly as shipped.

| Shape | Plan | Latency |
|---|---|---|
| Shipped `fold(name) = fold(const)`, 500k partition | pkey prefix scan + fold-per-row filter | 4,472 ms |
| **R1 `name_folded = fold(const)`** | **Index Scan, all three columns in Index Cond** | **0.33 ms** |
| **R1 with forced generic plan `= fold($1)`** | **Index Cond includes `fold($1)` on the parameter side** | **0.24 ms** |
| R1 unique lookup on stored column | Index Cond, unique | 0.10 ms |
| Unanchored `LIKE` today, 20-match exit | partition scan, fold per row | 1,005 ms |
| **Unanchored `LIKE` under R1** | partition scan, plain `~~` | **123 ms** |
| Unanchored `LIKE` under R1, zero matches, full 500k partition | partition scan | 188 ms |
| Prefix via `LIKE` under R1 | rejected (leaky `~~`) | 89.7 ms |
| **R3 prefix via explicit range quals** | **full Index Cond** | **0.31 ms** |

Orchestrator measurement at the real target shape (100 tenants, one with 100k rows,
99 with 1k): under forced RLS the tenant/environment quals **are** used as index
conditions on the primary key; the scan is bounded to the tenant partition, not the
whole table, with the fold evaluated per row of that partition.

## Scheduling consequences (these have deadlines)

**S1. R1 must land before G3.** `ADD COLUMN … GENERATED ALWAYS AS … STORED` is a
full table rewrite under `ACCESS EXCLUSIVE` — measured at ~12 s for 599k rows. On a
shared table that is an **all-tenant write outage proportional to total table
size**. It is nearly free at current row counts and expensive once inventory posts
movements. Deferral raises the price of the only known-good index shape.

**S2. Q1 aggregation must exist before G3.** G3's own correctness contract is an
aggregate: on-hand = `SUM(posted movement.quantity_delta)` (plan §, line 832).
Without Q1, G3 hand-rolls aggregation against ADR-0011's grain.

## Required implementation evidence

**E1. A plan-shape gate, not an index-existence check.** A missing or unused index
produces **no functional failure, only a silent multi-thousand-fold regression** —
one reviewer hit exactly this mid-experiment when a `CREATE INDEX` was rolled back
by an unrelated failure in the same implicit transaction. Assert via `EXPLAIN` that
the folded column appears in `Index Cond` under the runtime role with forced RLS.

**E2. Uniqueness contract migration.** The physical shape must move with the
predicate shape; keeping the expression index while querying stored columns would
leave two sources of fold truth. Note that G2-P2b established **two** distinct
unique expression indexes over the same folded key, and during coexistence the
**old** index fires first — so typed-error mapping must key on constraint *class*,
not name, or the transition order must be pinned. Compiler-emitted `uniquenessFold`
scenarios must pass unchanged: case-fold equivalents conflict, NFKC-compatibility-
distinct strings stay distinct.

**E3. Populated-table transition test** with pre-existing fold duplicates failing
closed (`23505`), in the style of migration 0010: the constraint is the guard, and
nothing is deleted.

**E4. Catalog conformance extension** must pin the generation expression
(`attgenerated = 's'`), plus a drift probe asserting
`count(*) WHERE col_folded IS DISTINCT FROM fold(col) = 0`. A new fold version must
be a new function name, a new column definition, and an accounted rewrite.

## Corrections to the orchestrator's own evidence (recorded so they are not repeated)

1. The fold function is **not** inlined. It carries `SET search_path = pg_catalog`,
   giving it a non-null `proconfig`, and PostgreSQL's inliner categorically refuses
   to inline such functions. The orchestrator's round-1 experiment used a `SET`-less
   wrapper this repository does not ship.
2. "Seq Scan" framing was wrong; RLS policy quals are security-level-0 and are
   eligible index quals.
3. Schema-per-tenant does **not** deliver `DROP SCHEMA` erasure — it relocates only
   module tables, while release, trust, audit, outbox, receipt and lifecycle rows
   remain in shared `platform` tables.
4. PostgreSQL PITR is cluster-level; per-schema point-in-time restore is not a
   native capability.
5. Tenant-count thresholds quoted from secondary sources were heuristics, not
   published PostgreSQL limits; R7's figures are measured.

## What would reopen this

- A sales-driven requirement for per-tenant sovereign residency or
  bring-your-own-database — collapses to pod-per-tenant economics, still never
  schema-per-tenant inside a shared instance.
- Master-data partitions routinely exceeding ~10^6 rows with sub-100 ms unanchored
  substring-search UX requirements — promotes F to now.
- A demonstrated Q1 expressiveness gap on a real analytical task that an algebra
  cannot close but SQL can — the answer is widening the algebra before amending
  ADR-0009.
- A credible revision of the fleet ceiling back to a few hundred tenants forever —
  would reopen R7 only.
