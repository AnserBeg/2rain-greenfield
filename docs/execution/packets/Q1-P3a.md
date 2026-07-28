# Q1-P3a — Rule the query-level aggregate contract

Status: evidence ready; Critical review pending
Tier: Critical
Lane: KERNEL
Initial base: `a76d18f2df89c12317022e56519f2abfbc532575`
Integrated working base after lane merge: `ba1f83bdb8b3f3f44c2c3396d238599b9c4d9e0d`
Final integrated `main` parent: `37a41078f291d5ff10d22a4951fa3af339d4520f`

## Outcome

Q1-P3a rules the first query-level aggregate without widening the immutable v2 language or
lowering SQL. [ADR-0022](../../decisions/ADR-0022-query-level-aggregate-contract.md) admits one
future scalar operator: `sum` over a canonically required exact-decimal or quantity field. It
defines typed zero on empty input, rejects optional/absent elements, preserves quantity unit and
source scale, checks precision-38 overflow, excludes archived rows, requires policy and trusted
scope narrowing before aggregation, and assigns `tenantBoundedScan` for Q1-P3b.

The pure canonical evaluator and the PostgreSQL probe execute those semantics now. They confer no
runtime authority: the strict v2 `queryDefinition` schema still rejects every aggregate spelling.

## Scope and the language-version ruling

The packet began against `a76d18f`. Its first inspection found that aggregate admission could not
fit the stated lease:

- ADR-0021 calls v2 immutable and already defers `>=`/`<=` serialized spellings;
- `validateSemantics` raises `CANON_VERSION_MIXED` unless every nested node version equals the
  package language version; and
- current-plan row 4 owns the complete v2→v3 language/profile transition.

The orchestrator ruled that Q1-P3a must design and execute the semantics while retaining compile-
boundary rejection. No serialized node spelling lands here. Current `main` was then fast-forwarded
into the clean packet branch per `docs/execution/lanes.md`; the only intervening changes were
orchestrator documents.

The packet changes:

- ADR-0022 and this record;
- a strict, total, pure-server aggregate semantics evaluator and exported contract;
- deterministic aggregate cases extending the Q1 parity helper;
- canonical negative/totality coverage; and
- a real PostgreSQL parity probe plus its exact test inventory entry.

It does not change compiler output, predicate lowering, providers, gateways, canonical query
schemas, domain packages, apps, migrations, or release artifacts.

## Ruling summary

| Concern | ADR-0022 ruling |
| --- | --- |
| Admitted operators | `sum` only; `count`, `min`, `max` reject |
| Source types | required `exactDecimalFieldType` or `quantityFieldType` |
| Empty input | typed zero |
| Absent element | optional source rejects statically; required-row absence returns typed rejection |
| Result | exactly one scalar, precision 38, source scale, source quantity base unit |
| Overflow | typed `numeric-overflow`; no rounding or saturation |
| Grouping | unsupported; a future bounded grouped-result contract cannot fork Freeze I |
| Archive | excluded; no v1 override |
| Scope and policy | tenant, environment, archive, policy, compiled filter, then future temporal boundary are one pre-aggregate conjunction |
| Cost | `tenantBoundedScan`; provider probe `Q1-P3b/required-sum-tenant-bounded-scan` |
| As-of | effective/recorded horizons narrow the input row set; they do not change `sum` |
| v2 wire grammar | unchanged and closed; every aggregate spelling still rejects |

`count` is reserved as row count with identity zero if a future profile admits it. `min` and `max`
will require a tagged absent result on empty input. Those constraints prevent SQL's ambient `NULL`
or `COUNT(value)` spelling from silently choosing semantics, but none of the three is admitted by
this packet.

## Discovered finding: negative sub-unit decimals

The first parity run used `-0.25` and went red before aggregation:

```text
required-exact-decimal-non-empty
+ actual - expected
+ 'rejected'
- 'evaluated'
```

`CanonicalDecimalStringSchema` v2 accepts negative integers and negative values whose integer part
is at least one, but rejects every value between `-1` and `0`. PostgreSQL `numeric` accepts
`-0.25`, and plan §6.3 requires signed quantity deltas. This is a pre-existing scalar-language hole
exposed by the first real aggregate corpus.

The packet does not widen v2. ADR-0022 rules `-0.25` as the future canonical spelling while keeping
`-0` invalid, and routes the grammar correction to the same complete v3 event that must serialize
the aggregate node.

## Executed positive evidence

Focused parity and canonical evidence:

```bash
node --import tsx --test \
  test/unit/canonical-model/negative-contracts.test.ts \
  test/postgres/query-aggregate-semantics.test.ts
```

Observed after correcting the first corpus arithmetic expectation:

```text
Q1-P3a aggregate probe cases=2 ir=4 postgres=5 empty_raw=NULL empty_total=0 visible_total=1 archived_included_total=101 optional_sql_sum=5 optional_rows=3 optional_present=2 optional_ir=optional-aggregand
tests 21
pass 21
fail 0
```

The two executions are independent: the IR path performs scaled-`bigint` arithmetic in the
canonical-model evaluator; the database path sends committed input arrays to ephemeral PostgreSQL
and reads `SUM(numeric)` results. The archive/policy probe uses a real table with six differently
scoped rows.

The existing Q1-P2 predicate corpus remains present and executes from the same canonical test file:

```text
Q1-P2 offline corpus receipt cases=18 rows=15 sha256=fb68943504912eead0e68bb486fba0a6cd86e3fef43d3093825be05f18dca3a8
```

## Executed reds

Each vacuity vector was perturbed separately and restored before the green run.

### Empty identity is load-bearing

```bash
Q1P3A_PERTURB_EMPTY_IDENTITY=1 \
  node --import tsx --test test/postgres/query-aggregate-semantics.test.ts
```

Recorded red:

```text
required-quantity-empty
null !== '0'
tests 1 · pass 0 · fail 1
```

This selects raw PostgreSQL `SUM` instead of the ruled totalized value.

### Archive exclusion is load-bearing

```bash
Q1P3A_PERTURB_ARCHIVED_VISIBILITY=1 \
  node --import tsx --test test/postgres/query-aggregate-semantics.test.ts
```

Recorded red:

```text
'101' !== '1'
tests 1 · pass 0 · fail 1
```

The archived row is worth `100`, so an implementation that silently counts it cannot pass.

### Optional/null-skipping admission is rejected

```bash
Q1P3A_PERTURB_ABSENT_ADMISSION=1 \
  node --import tsx --test test/postgres/query-aggregate-semantics.test.ts
```

Recorded red:

```text
+ actual   'rejected'
- expected 'evaluated'
tests 1 · pass 0 · fail 1
```

The same probe observes PostgreSQL's contrary behavior: `SUM=5`, three rows, two present values.

### Unsupported operators stay rejected

```bash
Q1P3A_DEMONSTRATE_UNSUPPORTED_AGGREGATE=1 \
  node --import tsx --test test/unit/canonical-model/negative-contracts.test.ts
```

Recorded red on `count`:

```text
+ actual   'rejected'
- expected 'evaluated'
tests 20 · pass 19 · fail 1
```

The ordinary run separately checks `count`, `min`, and `max` all return
`unsupported-operator`.

### The v2 compile boundary remains closed

```bash
Q1P3A_DEMONSTRATE_V2_AGGREGATE_ADMISSION=1 \
  node --import tsx --test test/unit/canonical-model/negative-contracts.test.ts
```

Recorded red:

```text
F3 operators and the complete v2 aggregate spelling stay compile-time rejected
CanonicalModelError: CANON_SCHEMA_INVALID
tests 20 · pass 19 · fail 1
```

The green path exercises required and optional `sum`, `count`, `min`, and `max` spellings. All
reject at normalization rather than falling through to runtime.

## What row 4 must carry before Q1-P3b

The v3 canonical-language packet is now a hard gate between this ruling and lowering. On behalf of
Q1 it must add:

1. a `queryType: "aggregate"` branch with exactly one `queryAggregateSelection` containing stable
   `selectionId`, operator `sum`, and a source-field reference;
2. bounded `queryParameterDefinition` nodes and a typed `queryParameterReference` predicate operand
   so stock identity and `atTime` are generic registered inputs rather than provider SQL;
3. normalization checks for source locality, required presence, exact-decimal/quantity type,
   parameter use/type consistency, scalar cardinality, no grouping, and maximum result count one;
4. derived result and input metadata in the compiled query catalog;
5. `greaterThanOrEqual` and `lessThanOrEqual` from ADR-0021;
6. canonical negative sub-unit decimals such as `-0.25`; and
7. unchanged v0/v1/v2 readers and rejection behavior.

Q1-P3b then lowers the node through the real gateway into one scoped aggregate statement, adds the
distinct scalar result envelope, lowers typed query-parameter references, and executes the named
`tenantBoundedScan` provider probe. G3's stock-identity and effective-time bindings narrow the input
row set and do not alter aggregate arithmetic.

## Known limits and what the gates cannot prove

- No aggregate query is admitted at runtime. The PostgreSQL test probes semantics directly; it
  cannot prove a future compiler or provider invokes the ruled path.
- The cost class is a ruled requirement, not execution evidence. Q1-P3b owns exact-index,
  forced-RLS, policy, archive, and cross-scope provider receipts.
- No stock-identity or temporal input binding executes yet. Row 4 must serialize the generic typed
  parameter/reference shape and Q1-P3b must lower it; neither may use bespoke provider SQL.
- No grouping, count, extrema, money/integer aggregate, traversal, join, report, export, or Formula
  F5 fold is admitted.
- The current v2 scalar grammar still rejects `-0.25`; only the non-serialized evaluator profile
  and ADR rule its future representation.
- The operation-precondition field-locality defect remains unreachable because this packet changes
  neither operation grammar nor runtime admission.
- Direct SQL parity proves result semantics, not snapshot consistency under concurrent writes.
  The production aggregate must be one statement; materialized read models and reconciliation are
  G3 work under ADR-0018.

## Baseline and final gates

The first-attempt baseline at `a76d18f2df89c12317022e56519f2abfbc532575` was green:

| Gate | Baseline observation |
| --- | --- |
| `format`, `build`, `lint`, `typecheck` | PASS |
| `check:boundaries` | PASS — 124 production files |
| `check:schema` | PASS — 12 applied / 12 verified plus drift |
| `check:demo-release`, `check:app-release` | PASS |
| Unit | 42/42 |
| Compiler | 54/54 |
| Integration | 59/59 |
| Agent | 3/3 |
| Architecture | 75/75 |
| Contracts | 6/6 |
| PostgreSQL | 90/90 |
| Locale | 1/1 |
| Browser | 17/17 |
| Observability | 5/5 |
| Reachability | 72/72 from 9 producer artifacts |

The full matrix then passed on its first attempt at the integrated candidate. No retry was used:

| Gate | Integrated-candidate observation |
| --- | --- |
| `format`, `build`, `lint`, `typecheck` | PASS |
| `check:boundaries` | PASS — 125 production files |
| `check:schema` | PASS — 12 applied / 12 verified plus drift |
| `check:demo-release`, `check:app-release` | PASS; canonical demo/app artifacts unchanged |
| Unit | 43/43 |
| Compiler | 54/54; canonical bytes and release-root goldens unchanged |
| Integration | 59/59 |
| Agent | 3/3 |
| Architecture | 75/75 |
| Contracts | 6/6 |
| PostgreSQL | 91/91 |
| Locale | 1/1 |
| Browser | 17/17 |
| Observability | 5/5 |
| Reachability | 73/73 from 9 producer artifacts; `query-aggregate-semantics.test.ts` executed |

The final documentation-only candidate reruns the same full matrix so the frozen SHA, packet
record, and executed evidence remain identical.

## Review evidence

Pending: fresh naive Codex xhigh review to PASS, followed by Fable max confirmation on the identical
unchanged SHA.

## Test it yourself

Read [ADR-0022](../../decisions/ADR-0022-query-level-aggregate-contract.md). Check that it explicitly
decides the operator set, empty and absent behavior, scalar result versus Freeze I, archive/policy
scope, exact type and overflow, cost class, and effective/recorded-time composition. Also check its
“What the v3 language packet must carry for Q1” section; aggregate admission is deliberately not
hidden inside this packet.

Then run the real PostgreSQL parity probe (normally under ten seconds):

```bash
cd /home/rvham/2rain-greenfield-q1p3a
node --import tsx --test test/postgres/query-aggregate-semantics.test.ts
```

Expect one passing test and the `Q1-P3a aggregate probe` line showing raw empty `NULL`, totalized
empty `0`, visible total `1`, archived-included counterfactual `101`, and optional input rejected by
the IR while PostgreSQL reports its silent-skipping totals.
