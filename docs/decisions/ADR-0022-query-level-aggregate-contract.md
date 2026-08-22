# ADR-0022: Query-level aggregate contract

Date: 2026-07-28
Status: **ratified** 2026-08-21 — Q1-P3a is accepted (ledger; reviewed
`98dce892afab7d549fdeacc993bfbcc368f32c42`, integrated `581ce99`, matrix green there on
the first attempt), completing the condition this ADR set for itself. (Status corrected
by the orchestrator's bridge to `record-claim-fidelity`, 2026-08-21. The 2026-08-21
record sweep corrected the six ADRs phrased *"ratified when that packet is accepted"*
and missed the five phrased *"pending packet acceptance"*; R1's own gate found them on
its first run.)
Tier: Critical (review per `review-tiers`)

## Context

G3 defines inventory truth as:

```text
onHand(stockIdentity, atTime)
  = SUM(posted inventory_movement.quantity_delta up to atTime)
```

This is a query-level aggregate over an already filtered row set. It is not plan §5.12 F5,
which is an expression-level fold over a declared to-many relation and belongs to the G6
Formula/rule language. Importing F5's trigger, maintenance, and concurrency contract here would
solve a different problem.

ADR-0021 already rules two parts of `SUM`: an optional aggregand rejects, while a required
aggregand returns typed zero for an empty input. The canonical v2 query grammar nevertheless has
no aggregate selection. Adding one to v2 would widen an immutable language version, and
`CANON_VERSION_MIXED` requires one language version for the package envelope and every nested
node. This ADR therefore designs the future serialized shape and supplies executable semantics,
but does not admit a wire spelling or lower SQL.

The first parity probe also found a scalar prerequisite: v2's canonical decimal regex rejects
`-0.25`. PostgreSQL `numeric` accepts it, and G3 explicitly requires signed quantity deltas.
Negative sub-unit quantities are not optional inventory behavior, so the same future language
event must correct that scalar grammar rather than teaching the aggregate evaluator a permanently
private decimal language.

## Candidates considered

### Return one synthetic record through the shared List contract

This would preserve the existing result envelope by placing a total in `records[0]`. It would
make record identity, revision, archive state, paging coverage, and cursors meaningless, while a
future grouped result would tempt callers to treat groups as business records. Rejected. Freeze I
remains the row-list contract; scalar and grouped aggregate results are different semantic shapes.

### Admit `sum`, `count`, `min`, and `max` together

This is familiar SQL vocabulary, but only `sum` is on G3's critical path. `count` needs a durable
choice between rows and present values; `min` and `max` need a tagged absent result on empty input;
and all three would enlarge Q1-P3b's provider surface and probe matrix. Rejected for v1.

### Copy PostgreSQL null-skipping and empty `NULL`

This would make a missing movement quantity indistinguishable from a non-contributing movement
and would make a valid aggregate data-dependently absent. It contradicts ADR-0021 totality and its
specific optional-`SUM` ruling. Rejected.

### Required exact-numeric scalar `sum`

Admit one operator over required exact-decimal or quantity fields, with typed zero for empty,
checked precision, one scalar result, and all row-set restrictions applied before aggregation.
This is the smallest complete contract that implements G3's stated equation. Selected.

## Decision

### 1. The first aggregate profile admits only scalar `sum`

`northstar.query-aggregate-profile/v1` admits exactly:

- operator `sum`;
- one aggregate selection;
- one source field whose type is `exactDecimalFieldType` or `quantityFieldType`;
- a canonically `required` source field; and
- no grouping.

`count`, `min`, and `max` remain compile-time unsupported. Their future empty semantics are
reserved explicitly rather than inferred from SQL: `count` counts rows, not present values, and
has identity zero; `min` and `max` require a tagged absent scalar on empty input. Admitting any of
them still requires a new profile/version decision and provider evidence.

Integer and money sums also remain unsupported. Integer has no bounded aggregate result precision
in today's type, while money would make currency and accounting semantics part of this packet.
Neither is required for inventory quantity truth.

### 2. The future canonical node shape is closed and scalar

The next complete language/profile version adds an `aggregate` query branch to the existing query
family. Its normalized shape is a `queryDefinition` with `queryType: "aggregate"`, tier `q1`,
`maximumResultCount: 1`, the existing source entity/filter/permission fields, a bounded ordered
`parameters` collection, and exactly one:

```text
{
  kind: "queryAggregateSelection",
  schemaVersion: <package language version>,
  selectionId: <canonical id>,
  operator: "sum",
  field: <fieldReference>
}
```

That branch has no ordinary `selections` and admits no `groupBy` property. Normalization derives
the result contract from the referenced field; an author cannot separately assert precision,
scale, unit, absence, or cost class and create two authorities.

An aggregate over a compiled literal would not implement `onHand(stockIdentity, atTime)`. The same
v3 query branch therefore declares required inputs as:

```text
{
  kind: "queryParameterDefinition",
  schemaVersion: <package language version>,
  parameterId: <canonical id>,
  orderKey: <bounded integer>
}
```

`fieldComparisonPredicate.value` gains a `queryParameterReference` alternative naming one of those
definitions. Normalization derives the parameter's scalar type from the compared field, rejects an
unused parameter, and rejects one parameter used against incompatible field types. The compiled
query catalog carries that derived input type so the gateway validates untrusted arguments before
provider execution. This is parameter binding, not F2 field-to-field comparison and not a second
aggregate filter language.

The current v2 `queryDefinition` remains byte-for-byte closed. Both `aggregate` and the earlier
speculative `aggregates` spelling continue to reject with `CANON_SCHEMA_INVALID` until the whole
package advances. The executable evaluator input in this packet is a profile request, not a
serialized canonical query node and not runtime authority.

### 3. Scalar results do not fork Freeze I

A successful aggregate query returns exactly one `semanticAggregateResult`, not a
`SemanticQueryResultEnvelope` containing a fake record and not a `SharedListResult`:

```text
{
  kind: "semanticAggregateResult",
  schemaVersion: "northstar.semantic-aggregate-result/v1",
  queryId,
  outcome: "exact",
  value: {
    selectionId,
    kind: "exactDecimalResult" | "quantityResult",
    value,
    precision: 38,
    scale: <source scale>,
    baseUnitId?: <source quantity base unit>
  }
}
```

The value is present even for an empty row set because `sum` has identity zero. A future grouped
aggregate needs its own bounded grouped-result contract with coverage and a cursor over stable
group keys. It may reuse Freeze I's coverage principles, but it may neither alter
`SHARED_LIST_RESULT_VERSION` nor represent groups as list records. Grouping is not admitted here.

### 4. Exact type, empty, absence, and overflow semantics

The result precision is 38 and the result scale is the source field's declared scale. Quantity
results preserve the source field's base-unit identity. Arithmetic is exact: no binary floating
point, rounding, scale reduction, saturation, `Infinity`, or scientific notation.

An empty input returns typed zero. An optional source field rejects during canonical normalization;
if an allegedly required row nevertheless presents an absent value to the reference evaluator,
evaluation returns the typed rejection `required-element-absent`. PostgreSQL's behavior of silently
skipping null elements is not copied.

A mathematical sum outside precision 38 returns `numeric-overflow`. Q1-P3b must make PostgreSQL
enforce the same boundary explicitly because PostgreSQL's unconstrained `SUM(numeric(p,s))` result
can exceed the input typmod.

Canonical negative sub-unit decimals use the ordinary spelling `-0.25`; `-0` remains non-canonical.
The v3 language event must correct the scalar grammar accordingly. This packet does not widen the
v2 `CanonicalDecimalStringSchema`.

### 5. The aggregate sees one provider-owned row set

The aggregate consumes the conjunction of:

1. trusted tenant scope;
2. trusted environment scope;
3. archive exclusion;
4. current policy narrowing;
5. the compiled query filter; and
6. a typed effective-time boundary when the registered query supplies one.

Every predicate is applied before aggregation in the same SQL statement. A compiled filter cannot
remove, replace, or weaken tenant, environment, archive, or policy predicates. Profile v1 has no
`includeArchived` override: archived rows are excluded. The PostgreSQL probe observes the opposite
choice changing the total from `1` to `101`.

Inventory movements are append-only and therefore will not normally enter an archived lifecycle,
but the generic query contract is explicit so another entity cannot silently count invisible rows.

### 6. Cost class and the Q1-P3b provider receipt

The only admitted row has cost class `tenantBoundedScan` and provider probe identity
`Q1-P3b/required-sum-tenant-bounded-scan`. Aggregation must inspect every qualifying value, so an
index on the measure cannot turn it into point access.

Q1-P3b must execute the compiled aggregate through the real gateway under forced RLS and observe:

- access to the exact declared tenant-scope index by name and its `idx_scan` delta;
- one scalar result from the provider, including typed zero for an empty tenant partition;
- the same value as the canonical evaluator for present, negative fractional, and boundary-scale
  values;
- a changed total when archive or policy narrowing is deliberately removed; and
- no contribution from another tenant or environment.

The probe must retain a perturbed or dropped-index red. Plan text alone is a proxy and cannot
satisfy the cost-class evidence requirement.

### 7. Effective-time and recorded-time compose without changing `sum`

The aggregate operator consumes an already narrowed row set. The v3 parameter/reference shape lets
G3 bind stock-dimension identifiers and contribute `effectiveAt <= atTime` to that row set before
aggregation; it does not add a temporal mode to `sum` or post-filter an aggregate result. Q1-P3b
must lower those typed references as SQL parameters through the generic query path. They must not
become provider-bespoke SQL.

ADR-0018's later recorded-time axis composes the same way as an additional pre-aggregate horizon.
A materialized result also records the `recordedAt` horizon from which it was computed. Neither
axis changes arithmetic, empty, absence, visibility, policy, or result-shape semantics, so adding
as-of reads does not reopen this ADR.

## Canonical kernel encoding

`packages/canonical-model/src/query-aggregate-kernel.ts` owns the pure-server reference evaluator.
It accepts `unknown`, checks exact keys, dispatches only
`northstar.query-aggregate-profile/v1`, uses scaled `bigint` arithmetic, and returns a typed
evaluated or rejected receipt for every input. It never throws because a valid row set is empty or
because an invalid required row is absent.

This evaluator is not a second runtime execution path. PostgreSQL is the production row-set target;
Q1-P3b lowers the future compiled node and must remain differential against this one semantics.
The v2 runtime gateway has no aggregate query type and cannot invoke this profile.

## Consequences

- G3 receives one precise aggregate capability: required exact-numeric scalar `sum`.
- Freeze I remains unchanged; aggregate results cannot masquerade as paged records.
- Optional quantities, archived rows, policy-hidden rows, and cross-scope rows cannot silently
  contribute.
- Count, extrema, grouping, money, integer sums, and F5 relation folds remain explicit rejects.
- Q1-P3b is now blocked on the complete v3 language/profile event, not merely on this ruling.
- No current canonical bytes, compiled release roots, provider paths, gateways, or product surfaces
  change in Q1-P3a.

## What the v3 language packet must carry for Q1

Current-plan row 4 is the gate between this ruling and Q1-P3b. In addition to its existing families,
it must carry:

1. the scalar aggregate query branch and `queryAggregateSelection` shape above;
2. bounded `queryParameterDefinition` nodes and a typed `queryParameterReference` predicate operand,
   including locality, use, and consistent inferred-type checks;
3. normalization-time source locality, required presence, admitted type, single-selection, no-group,
   and `maximumResultCount: 1` checks;
4. the `greaterThanOrEqual` and `lessThanOrEqual` predicate nodes already parked there by ADR-0021;
5. canonical negative sub-unit exact decimals such as `-0.25`, while continuing to reject `-0`;
6. retained v0/v1/v2 readers and rejection behavior; and
7. derived aggregate result and input metadata in the compiled query catalog without introducing an
   author-asserted duplicate authority.

Until that complete package/profile transition lands, Q1-P3b cannot admit or lower aggregates.

## Evidence

The real PostgreSQL parity probe emitted:

```text
Q1-P3a aggregate probe cases=2 ir=4 postgres=5 empty_raw=NULL empty_total=0 visible_total=1 archived_included_total=101 optional_sql_sum=5 optional_rows=3 optional_present=2 optional_ir=optional-aggregand
```

This observes rather than infers that PostgreSQL returns `NULL` for empty `SUM`, skips an absent
element (`3` rows, `2` present, total `5`), and includes an archived row unless constrained. The
totalized SQL agrees with the independent scaled-integer evaluator for both non-empty and empty
cases. Unit evidence observes checked overflow, exact profile dispatch, unsupported operators,
unknown properties, required-row absence, and the still-closed v2 compile boundary.

The first probe run also recorded the negative-sub-unit finding: PostgreSQL accepted `-0.25` while
the current `CanonicalDecimalStringSchema` rejected it. The evaluator profile and this ADR rule the
future representation; v2 remains unchanged.

Sources: plan §5.9 and §6.3; plan §5.12's distinction between F1 and F5; ADR-0012's totality,
position-profile, cost-class, and one-evaluator-per-target rules; ADR-0021's required/optional and
empty-`SUM` rulings; ADR-0018's effective/recorded-time one-way door; and Q1-P0 through Q1-P2's
differential evidence pattern.

## Enforcement

- The aggregate reference evaluator owns exact arithmetic and typed rejection receipts.
- Canonical negative tests keep every aggregate spelling rejected by the current v2 strict query
  schema, including required `sum` and optional `sum`.
- The evaluator rejects `count`, `min`, `max`, optional sources, absent required elements, unknown
  profile versions, unknown properties, unsupported types, and overflow.
- The PostgreSQL probe independently executes every committed aggregate parity case and contains
  perturbations for empty identity, archive visibility, and absent admission.
- Q1-P3b cannot claim admission until its real provider receipt covers the named cost-class probe.

## Limits

This ADR does not serialize an aggregate or parameter node, lower SQL, change the semantic gateway
result union, execute `stockIdentity` or `atTime` bindings, build as-of reads, or implement a
materialized balance. It does not admit grouping, count, extrema, money/integer sums, traversal,
joins, reports, exports, Formula F5 folds, or policy evaluation. Its direct SQL probe proves
PostgreSQL semantics, not planner access or gateway enforcement; those observations belong to
Q1-P3b after v3.

The operation-precondition field-locality defect remains unreachable and unchanged: this packet
does not widen operation execution or query runtime admission.
