# Q1-P3b — Scalar aggregate lowering through the real gateway

Status: active
Tier: Critical
Base: `c768eb1c6c529c84e3180cc7a7b078a126d33b55`
Branch: `packet/q1-p3b`

## Outcome

Q1-P3b implements ADR-0022's one admitted query aggregate: scalar `sum` over a
required exact-decimal or quantity field. The compiler emits versioned aggregate
and parameterized-predicate plans, the Semantic Query gateway validates and binds
them from the request-pinned catalog, and the generic PostgreSQL interpreter
executes one exact scalar under its existing archive and forced-RLS conjunctions.
Empty input returns typed zero. The result does not reuse or fork Freeze I's
record-and-coverage List contract.

This packet does not admit another operator, optional aggregands, grouping,
traversal, joins, reports, exports, or a UI aggregate surface. It does not change
the canonical wire grammar: `schemas.ts` is unchanged.

## One lowering authority

The v3 catalog emitted aggregate metadata but previously carried no executable
plan. A `queryParameterReference` was also unrepresentable in the existing
row-plan type because its comparison value was fixed to `CanonicalScalar`.

The repair is shared, versioned internal IR:

- `northstar.predicate-lowering-plan/postgres-parameterized-v1` carries v3
  filter structure and scalar-or-parameter operands;
- `northstar.query-aggregate-lowering-plan/postgres-v1` carries the ruled sum
  row and its required provider probe;
- the compiler owns construction; the gateway owns validation and binding; the
  PostgreSQL interpreter owns execution.

Runtime re-lowering from canonical catalog objects, or a duplicated runtime-only
plan type, would create a second lowering authority. That is the exact failure
class behind the quarry's metric-service evaluator fork: one declared language
still diverged because another consumer reimplemented its semantics. The
ratified invariant is one owned evaluator per execution target, so the shared
plan contract is load-bearing rather than a convenience.

Existing record-producing consumers retain `RegisteredQueryDefinition` and
`SemanticQueryExecutor.execute`. Aggregate definitions and execution use a
separate discriminated type and `executeAggregate`; this prevents aggregate
support from widening every row/UI switch and makes an executor's lack of
aggregate support explicit.

## Versioned lowering table

Q1-P3b extends, rather than replaces, Q1-P1's two rows.

| Row ID | Admission | Cost class | Executed provider probe |
| --- | --- | --- | --- |
| `northstar.predicate-lowering/folded-equality-v1` | Existing Unicode-folded equality with declared index, including a typed parameter operand | `indexedFoldedEquality` | `Q1-P1/indexed-folded-equality` |
| `northstar.predicate-lowering/tenant-scan-comparison-v1` | Existing scalar comparison vocabulary | `tenantBoundedScan` | `Q1-P1/tenant-bounded-scan` |
| `northstar.predicate-lowering/parameterized-comparison-v1` | Typed parameter comparison, plus v3 `greaterThanOrEqual` / `lessThanOrEqual` | `tenantBoundedScan` | `Q1-P3b/parameterized-comparison-tenant-bounded-scan` |
| `northstar.query-aggregate-lowering/required-sum-v1` | ADR-0022 required exact-numeric scalar sum | `tenantBoundedScan` | `Q1-P3b/required-sum-tenant-bounded-scan` |

The aggregate row remains `tenantBoundedScan`: it must inspect every qualifying
measure. Its filter can still use the exact declared folded index to bound the
qualifying set; that does not turn the aggregate itself into point access.

## Gateway and SQL contract

The gateway validates exact catalog keys, plan versions, predicate digests,
structural equality, lowering-row/cost pairs, declared parameter use, parameter
types, result shape, and the fixed ADR-0022 aggregate identity before provider
execution. Arguments are untrusted JSON; the request must name exactly every
declared canonical parameter ID and each value must satisfy the compiler-derived
field type.

The provider appends all validated query and policy plans after its mandatory
archive predicate. Tenant and environment remain forced-RLS session predicates.
The scalar statement is structurally:

```sql
SELECT COALESCE(SUM(required_measure), 0)::numeric(38, declared_scale)::text
  FROM north_star_module.compiled_entity
 WHERE archived_at IS NULL
   AND compiled_filter
   AND policy_filter
```

Every comparison remains totalized as Q1-P1 ruled:
`field IS NOT NULL AND field OP $n`. Typed parameter references become ordinary
bound PostgreSQL parameters; stock identity and `atTime` are not smuggled through
provider-specific SQL.

The D3 seam accepts the same versioned plan contract for policy contributions.
A compiled filter never replaces the policy plan, archive predicate, or RLS
scope; all are conjunctions in the executed statement.

## Execution-observed provider evidence

Pending the lane's container/matrix clearance. The focused test is authored to
materialize a v3 Party fixture with a required exact-decimal measure, a required
effective timestamp, and a non-unique searchable stock identity. It creates the
semantic rows through O0, adds planner-only volume, then executes the aggregate
through `SemanticQueryGateway.invokeAggregate` and
`PostgresModuleRuntimeInterpreter` under forced RLS.

The final evidence will record:

- the exact folded stock index name and its `idx_scan` delta for the real gateway
  call;
- typed zero for an empty tenant partition;
- IR/PostgreSQL equality across `-0.25`, `1.000001`, and boundary-scale
  `0.000001`;
- base versus policy-narrowed totals;
- the changed total when the archive predicate is deliberately omitted;
- exclusion of same-stock rows from another tenant and another environment;
- a complete recognized `EXPLAIN (ANALYZE, FORMAT JSON)` tree supplementing,
  but never replacing, the execution-counter observation.

## Recorded reds

The provider controls below are authored independently and remain pending
execution until the orchestrator releases the container slot. Exact output will
replace the pending rows before freeze.

| Vacuity vector | Fault injection | Observation |
| --- | --- | --- |
| A new plan becomes a second expression dispatcher | The first implementation added separate parameterized-node traversals to canonical plan typing, compiler lowering, and gateway parameter discovery | **RED**, architecture 89/90: `PREDICATE_DISPATCH_SIGNATURE_CHANGED` named all three files. The implementation was refactored to derive canonical kinds from the existing node types, use one parameterized compiler traversal, and collect parameters during the gateway's existing plan validation. Re-run: `Q1-P2 dispatch tripwire synthetic=PREDICATE_DISPATCH_UNREGISTERED production=0 legitimate_kernel=0`, architecture 90/90. |
| Aggregate cost receipt passes without its index | `Q1P3B_DEMONSTRATE_MISSING_INDEX=1` drops the exact stock index | exact `idx_scan` delta assertion goes red |
| Policy seam is decorative | `Q1P3B_DEMONSTRATE_MISSING_POLICY=1` omits the compiled contribution | narrowed total differs from the canonical expected value |
| Archive exclusion is not load-bearing | `Q1P3B_DEMONSTRATE_MISSING_ARCHIVE=1` requires the archive-free total to equal the production total | independent archive-free statement changes the total and the assertion goes red |
| Typed arguments reach the provider malformed | supply Boolean `atTime` | `MalformedSemanticQueryRequestError`, aggregate executor count zero |
| Signed sub-unit literal is declaration-only | execute the compiler-emitted `amount >= -0.25` term against real stored rows | gateway total includes `-0.25` and agrees with the IR evaluator |
| Tenant/environment restriction is replaceable | same stock identity and time exist in both foreign scopes | real gateway result remains the same; forced RLS and policy catalog are observed |

## Focused gates so far

No PostgreSQL/container suite has been started while another lane holds the
serialized matrix slot.

| Gate | Result |
| --- | --- |
| `format` | PASS |
| `build` | PASS |
| `typecheck` | PASS |
| `lint` | PASS |
| `check:boundaries` | PASS, 131 files scanned |
| Unit | 45/45 |
| Compiler | 74/74 |
| Integration | 59/59 |
| Architecture | 90/90 |

The untouched base compiler suite was 74/74. Q1-P3b adds no new test file, so no
repository-hygiene or reachability inventory entry is required; the modified
PostgreSQL file remains in the existing CI-discovered glob.

## Known limits and what the gates cannot prove

- No production domain package declares this aggregate yet. G3-P5 can now author
  `onHand` without provider-specific SQL after this packet is accepted.
- The policy seam is real SQL conjunction, but the current product policy remains
  allow-all and row 7 still owns the policy kernel.
- Cost plans are data- and statistics-sensitive. Exact named-index counters and a
  controlled plan tree prove this fixture's execution, not every future
  distribution or a latency SLO.
- Scalar aggregate results are deliberately not pageable List results. Grouping
  remains unsupported rather than weakening Freeze I.
- The gateway validates the currently compiled parameter field kinds. It does not
  introduce a general UI/query-authoring surface for them.
- Q1-P2's predicate parity corpus remains the deterministic guard for admitted
  predicates. This packet adds an aggregate evaluator comparison in the real
  provider receipt; it does not claim grouped or optional-value coverage that
  ADR-0022 rejects.

## Test it yourself

There is no UI aggregate surface in this slice. After checkout, run the real
gateway/provider receipt (normally under two minutes):

```bash
cd /home/rvham/2rain-greenfield
node --import tsx --test \
  --test-name-pattern='q1 required sum executes' \
  test/postgres/query-filter-lowering.test.ts
```

The output must print a `Q1-P3b aggregate probe` line with typed `empty=0`, an
exact named index `delta=1`, `signed_subunit=-0.25`,
`boundary_scale=0.000001`, a smaller policy total than the base total, and a
different archive-free total. The command exits nonzero if IR/SQL parity,
parameter binding, index execution, archive/policy conjunction, or tenant/
environment isolation fails.

## Full gates and review evidence

Pending serialized full-matrix clearance. The final immutable handoff will name
the frozen integrated SHA, complete gate counts, the non-empty fresh Codex xhigh
review artifact, and the non-empty Fable max confirmation artifact for that
identical unchanged SHA.
