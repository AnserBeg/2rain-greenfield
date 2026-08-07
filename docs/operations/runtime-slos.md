# Runtime request-path SLO families

Status: v0 measurement and plan-shape contract
Owner: PR-6 relation-plan gate; PR-6b folded-access plan gates; PR-6c
existing-table locking-DDL window; PR-6d literal search and prefix-range
gates; U1 registered-query feedback-ladder grading; later platform budgets
for percentile/error-budget ratification

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
| Unanchored substring search | Bounded tenant/environment partition scan over the stored folded column. Search input is literal: substring lowering escapes `!`, `%`, and `_` before an explicit `ESCAPE '!'`, while `\` is ordinary text. PostgreSQL's non-leakproof `textlike` prevents any index shape from serving this predicate through forced RLS; cost remains `O(rows in the tenant partition)`, not `O(all tenants)`. | The verdict measured **1,005 ms** for the former fold-per-row 20-match exit. The shipped stored-fold shape measured **123 ms** for that case and **188 ms** for a zero-match full-partition scan on 500,000 rows. PR-6d's 10,000-row probe observed the same tenant-primary-key plan before and after escaping, with 9,999 rows removed by the bounded post-filter and an exact primary-index `idx_scan` delta of 1. | A future search projection is trigger-driven only if real partitions exceed the verdict's threshold. |
| Prefix/typeahead search | Current on compiled Q0 search through `matchMode: 'prefix'`. Each searchable stored fold is `COLLATE "C"`; lowering emits leakproof `>= folded_parameter` and, when one exists, `< exclusive_successor` range predicates. Every searchable non-unique fold receives a tenant/environment-leading `foldedAccess` btree; existing unique folded indexes serve unique fields. | The binding verdict measured **89.7 ms** for prefix `LIKE` and **0.31 ms** for explicit range lowering. PR-6d's local 10,000-row forced-RLS comparison observed **4.474 ms → 0.569 ms** with the complete compiled Party search shape; its exact-name execution oracle flipped at 100 analyzed rows and retained both zero tree-wide filter removals and expected-index counter deltas through 10,000 rows. | Re-measure at representative partition sizes and PostgreSQL upgrades; latency is recorded evidence, while exact-name access is the executable gate. |
| Registered query read, graded against the UI feedback ladder | **One `SemanticQueryGateway` call is timed, which is narrower than the interval the user waits.** Each read-ingress call is timed from an injected monotonic source and recorded as **either one [ADR-0032](../decisions/ADR-0032-feedback-ladder-and-loading-states.md) §1 band or one named rejection**, before it returns and inside the region its refusal is raised in. The executable gate reads the recorded in-process counter and requires bands plus rejections to equal the invocation count, so an ingress path that escapes measurement goes red rather than absent. **Outside the timer:** authentication, definition load, the entry policy read and view construction, all of which precede it; page render, which follows it; and every call but the one being timed — a scoped surface issues two sequential reads (`surface-runtime.ts:126` and `:202`), so two 350 ms calls are each recorded inside the budget while the page takes past 700 ms. | Twenty sequential compiled Party list reads through the composed runtime, against the pinned PostgreSQL image under the forced-RLS `north_star_runtime` role, recorded **20 of 20 in `under_100ms`** on each of three runs, whose per-call means from the same monotonic source were **12.370 ms, 14.265 ms and 18.075 ms** (totals 247.404 / 285.296 / 361.498 ms). The spread across identical runs on one loaded host is why the band, not the figure, is what this family records: it is a band observation, not a percentile, and the counter can never yield a p95. | `op-latency` owns the operation gateway. `U5` owns skeleton geometry and `U9` the visual-conformance gates, so no band above 400 ms has a treatment to verify. **Nothing serves this counter yet** — `apps/api` composes the surface server alone, so it is in-process evidence, not an operator-visible metric. |

## Measurement and extrapolation discipline

The verdict latency figures above are measured values from the pinned-image
debate, not estimates from PR-6b. PR-6d adds one local before/after measurement,
described below; it is not a fleet percentile. PR-6 and PR-6b separately measure
the 100-row planner threshold by seeding the real compiled Party tables
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

PR-6d uses the same real compiled Party query shape, forced-RLS runtime role,
10,000 analyzed tenant rows, and `EXPLAIN (ANALYZE, FORMAT JSON)` for both sides
of its local comparison. The before side is the former prefix
`folded_column LIKE (folded_parameter || '%')`; the after side is the literal
C-collated range. PostgreSQL's root `Actual Total Time` supplies the recorded
4.474 ms and 0.569 ms observations. No latency threshold is asserted. The
executable prefix gate instead requires an `idx_scan` increase for every exact
compiled index name and zero `Rows Removed by Filter` across the entire plan
tree. Dropping only the declared name-folded index makes that gate red with
9,999 rows removed, even though another folded index remains available.

The `O(tenant partition)` and tenant-count-invariance statements are plan-shape
bounds, not latency extrapolations. The orchestrator verified the scope quals as
index conditions at a 100-tenant shape (one 100,000-row tenant and 99 1,000-row
tenants). Adding tenants therefore does not add rows to a given tenant's scan;
adding rows inside that tenant does. No p50/p95/p99, concurrency capacity, or
fleet error budget is inferred from these single-host measurements.

## The feedback-ladder family grades the ingress, not the surface

Recorded by U1. ADR-0032 ratified the ladder on 2026-07-31 and plan §15.1 now
carries Doherty's 400 ms with its citation, but
[ux-strategy-proposal.md](../execution/ux-strategy-proposal.md) §18 risk 4 named
the way that ratification could still fail: "the ladder is only meaningful if
latency is measured. U1 must ship the measurement, not just the number, or it
becomes another unratified aspiration." Before U1 nothing in the repository read
a clock — no `hrtime`, no `performance.now`, no duration field anywhere in the
runtime, platform-runtime or web sources.

**What executes, and how far it reaches.** `SemanticQueryGateway` is the sole
application read ingress, so it is where the timing seam sits, and it wraps the
whole gateway call rather than the executor: policy authorization, catalog
resolution and legal-entity scope issuance are latency the caller waited
through, and a band measured from the executor inward would record a faster
operation than the one that happened.

**But one gateway call is not the interval the user waits, and this family must
not be read as if it were.** Authentication, definition load, the entry policy
read and view construction all happen in `entry.run` before the timer starts;
HTML rendering and transport happen after it stops. A surface with a
workspace-context bar issues *two* sequential ingress calls
(`surface-runtime.ts:126` and `:202`), each timed separately, so two 350 ms
reads are both recorded inside the 400 ms budget while the page takes past
700 ms to appear. Nothing here measures the sum, and no gate would notice it.

Every call is recorded, including the ones that throw — an `answered` sample is
an envelope returned to the caller and a `refused` sample is a named refusal,
and the slowest refusals are exactly the ones a "successes only" counter would
hide. The envelope-shape refusal is raised *inside* the timed region for that
reason: U1's first round recorded it after the timer had already closed as
`answered`, so a throwing call was graded a successful answer. The gate reads
the counter composition recorded, never the observer the test injected, because
the ingress swallows observer faults by design and silence there is
indistinguishable from an observer that never ran.

**What is evidence.** The band, and only the band, in process memory. Duration
never reaches the counter and neither does the query id: `outcome x band` is
twelve series and stays twelve series however many queries a release registers,
which is why cardinality cannot follow the catalog — and equally why **this
family cannot say which query earned a treatment.** That matters for ADR-0032
§2: a treatment applied to every surface because *some* read was slow is the
default decoration the ADR forbids, and attributing one would need the query id
this counter deliberately discards.

**Nothing serves the counter.** `apps/api` composes the surface runtime server
alone; `createHealthServer` — which is what exposes `/metrics` — is composed
only by `apps/web/observability/server.ts`, a separate process holding its own
`ObservabilityMetrics`. So `runtime.metrics` is reachable from a test and from
nowhere else. It is in-process evidence, not an operator-visible metric.

The recorded latency figure in the table above is a single-host observation of
one compiled query on one seeded tenant. It is not a p50, p95 or p99, no error
budget is derived from it, and ADR-0032 §7's "p95 under 400 ms" remains
unverified at the fleet level for the same reason the plan-shape rows above
decline to extrapolate.

**Unusable samples are refused by name, never clamped.** AGENTS.md §6 records
that this machine's WSL2 kernel steps its wall clock backward about two seconds
under CPU load. A negative or non-finite duration therefore increments a named
rejection counter instead of grading as a fast band — clamping it to zero would
file a broken clock under `under_100ms`, which is the precise shape of the
defect this family exists to prevent. A clock that throws produces the same
named rejection and the read still returns.

**One ADR boundary was resolved, not invented.** ADR-0032 §1 writes its last two
rows as "3 s – 10 s" and "> 10 s", which leaves exactly 10,000 ms unclaimed. The
grading treats every band as lower-inclusive, so 10,000 ms is `over_10s` — the
band that owes the user progress plus cancel or background-handoff. The
resolution is in the direction that owes more, and it is what makes the ladder
total, which is what lets the graded count be compared against an invocation
count at all.

**One check here is a proxy, and is recorded as one.** A separate gate matches
the 400 ms threshold and the six §1 rows against ADR-0032, plan §15.1 and the
`ux-grammar` skill, so the code and the doctrine cannot drift apart unnoticed.
Prose can only be matched, never observed, so per AGENTS.md §6 that check
ratchets wording; it proves nothing about behaviour. Everything else in this
family reads a recorded counter.

**`loadingTreatmentAdmitted` is a helper, not a gate.** ADR-0032 §2 is written
as a predicate that answers `false` for the two bands at or under 400 ms, and a
unit test holds it to that. **No production path calls it.** It constrains
nothing today and is available for `U5` and `U9` to gate against; this family
does not claim that a treatment inside the budget would be refused anywhere.

**One check here is a proxy, and is recorded as one.** A separate gate matches
the 400 ms threshold and the six §1 rows against ADR-0032, plan §15.1 and the
`ux-grammar` skill, so the code and the doctrine cannot drift apart unnoticed.
Prose can only be matched, never observed, so per AGENTS.md §6 that check
ratchets wording; it proves nothing about behaviour.

### Declared unproven

Named individually, because an unlisted obligation is lost in a handoff. The
first three were blocking findings in U1 round 1 and are now gated; the residue
each still leaves is stated rather than dropped.

1. **Aggregate measurement on a real database.** `invokeAggregate` is now
   witnessed answered and refused against a hand-built pinned catalog. No
   aggregate query runs through a composed runtime against PostgreSQL, because
   the compiled application registers none.
2. **Answered/refused classification.** The envelope-shape refusal now happens
   inside the timed region, with a control in each direction. What remains
   unproven is that every *other* throw site in the ingress is likewise inside
   it; the controls cover the two the round-1 defect exposed.
3. **Clock liveness.** The exported source must observably advance, bounded by a
   containing `hrtime` window, so a frozen clock reds. The gate proves the
   source moves, not that it moves at the rate real time does.
4. **Executable sole-ingress enforcement.** That no second browser read path
   exists was closed by source inspection, not by a gate. `AUTH003_GATEWAY_BYPASS`
   is a narrow textual scan, and instrumentation remains an optional gateway
   constructor argument, so a future uninstrumented composition would be caught
   by no check here. Deliberately not built in U1.
5. **Query attribution.** The composed observer discards the query id, so
   nothing can name which registered query was slow.
6. **Operator exposure.** No process serves the counter; see above.
7. **Authentication, view-construction and render latency.** All outside the
   seam, all unmeasured.
8. **Cumulative latency across the reads one surface issues.** Each call is
   graded alone; the sum a user experiences is not recorded anywhere.

Beyond those: no band's *treatment* is observed, because none exists — `U5` owns
skeleton geometry and `U9` the visual-conformance gates. ADR-0032's optimistic
allow-list (§4), weighted success states (§5), name-only near-match suggestions
(§6) and the mandatory `prefers-reduced-motion` fallback are outside the ingress
entirely and are untouched. Operation-path latency is uninstrumented and belongs
to `op-latency`: the operations §1 expects to exceed the threshold — posting,
release publication, import, long verification — travel through
`SemanticOperationGateway`, which this family does not measure.

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
