# Q1-P3b — Scalar aggregate lowering through the real gateway

Status: active
Tier: Critical
Base: `c768eb1c6c529c84e3180cc7a7b078a126d33b55`
Branch: `packet/q1-p3b`

The branch merged accepted G3-P1b from `main` at `d376d09` before provider
execution, then accepted G3-P2a at `f242cde` before freeze. Their compiler,
storage, inventory, and tenant-completeness changes are disjoint from Q1-P3b's
aggregate catalog decoration; the merged focused counts are recorded below.

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

The focused test materializes a v3 Party fixture with a required exact-decimal
measure, a required effective timestamp, and a non-unique searchable stock
identity. It creates semantic rows through O0, adds 10,000 planner-only rows,
then executes the aggregate through `SemanticQueryGateway.invokeAggregate` and
`PostgresModuleRuntimeInterpreter` under forced RLS. PostgreSQL printed:

```text
Q1-P3b aggregate probe index=nsm_i_lepgpjussjyql6b3ldh4rwxrj4j57lv75uua4rhg2odbv7kpc7gq delta=1 rows_removed=3 empty=0 base=10.750002 policy=0.750002 archive_removed=100.750002 signed_subunit=-0.25 boundary_scale=0.000001 tenant_other=4000 environment_other=8000 forced_rls=true malformed_temporal=5 malformed_result=4
```

This observes:

- the exact folded stock index name and its `idx_scan` delta for the real gateway
  call: `nsm_i_...pc7gq`, exactly `1`;
- typed zero for an empty tenant partition;
- IR/PostgreSQL equality across `-0.25`, `1.000001`, and boundary-scale
  `0.000001`;
- base `10.750002` versus policy-narrowed `0.750002`;
- archive-free `100.750002` versus production `0.750002`;
- exclusion of same-stock rows from another tenant and another environment;
- a complete recognized `EXPLAIN (ANALYZE, FORMAT JSON)` tree supplementing,
  but never replacing, the execution-counter observation.

The first execution attempt also found a real cross-layer defect rather than a
fixture typo: v3 canonical scalar grammar and the aggregate evaluator admitted
the required signed sub-unit value `-0.25`, but the provider's generic operation
value validator still used the old negative-integer-only prefix. O0 failed with
`MODULE_FIELD_VALUE_INVALID` before SQL. The validator now accepts canonical
negative sub-unit exact decimals while retaining `-0` rejection. Reinstating
the former validator reproduces the red recorded below; restoring the fix makes
the same O0 write and aggregate receipt green.

## Recorded reds

The provider controls below were executed independently against fresh ephemeral
PostgreSQL instances.

### L3 dispatch tripwire — three caught near-forks

The first implementation made the Q1-P2 model-assisted dispatch tripwire go red
with `PREDICATE_DISPATCH_SIGNATURE_CHANGED` and architecture 89/90. It named
three distinct additions. Each was a duplicate authority, not a legitimate
target-specific evaluator:

1. **Canonical plan typing — `predicate-kernel.ts`.** The parameterized plan
   repeated the four predicate `kind` spellings as fresh string literals. That
   would let the internal plan vocabulary drift from the canonical predicate
   node union while still type-checking locally. The corrected type extracts
   each discriminant from the existing `PredicateLoweringNode` branches, so the
   new operand capability does not declare a second node-kind registry.
2. **Compiler lowering — `predicate-lowering.ts`.** The first draft added a
   second recursive walker for parameterized v3 predicates beside Q1-P1's
   `lowerNode`. It would have owned Boolean structure, comparison dispatch, and
   cost-row selection independently. The corrected implementation has one
   `lowerVersionedNode` traversal parameterized by the admitted plan profile;
   both legacy row filters and aggregate filters use that traversal.
3. **Gateway validation — `semantic-query-gateway.ts`.** The first draft added
   a separate recursive walk solely to discover parameter references after the
   existing lowering-plan validator had already traversed the same tree. That
   duplicated depth, node-kind, and comparison-shape dispatch and could accept
   a reference shape the validator rejected, or vice versa. The corrected
   `inspectLoweringNode` optionally collects parameter IDs during the one
   validating traversal; exact declared-versus-used comparison happens from
   that receipt.

After consolidation the same executed control reported:

```text
Q1-P2 dispatch tripwire synthetic=PREDICATE_DISPATCH_UNREGISTERED production=0 legitimate_kernel=0
architecture: 90/90
```

This is a proxy with Q1-P2's recorded limits: it can miss an unrecognized fork
and can flag a legitimate traversal. Here the finding was confirmed by reading
each named traversal, not by treating the pattern result as sufficient. Three
near-forks in the first aggregate-lowering packet are direct evidence that L3
guards the quarry failure it was designed around.

| Vacuity vector | Fault injection | Observation |
| --- | --- | --- |
| A new plan becomes a second expression dispatcher | The first implementation introduced the three authorities itemized above | **RED**, architecture 89/90; corrected re-run 90/90 with `production=0` and `legitimate_kernel=0`. |
| Aggregate cost receipt passes without its index | `Q1P3B_DEMONSTRATE_MISSING_INDEX=1` drops the exact stock index | **RED:** exact counter assertion `0n !== 1n`. |
| Policy seam is decorative | `Q1P3B_DEMONSTRATE_MISSING_POLICY=1` omits the compiled contribution | **RED:** actual `10.750002`, expected canonical/policy result `0.750002`. |
| Archive exclusion is not load-bearing | `Q1P3B_DEMONSTRATE_MISSING_ARCHIVE=1` requires the archive-free total to equal the production total | **RED:** actual archive-free `100.750002`, expected production `0.750002`. |
| Typed arguments reach the provider malformed | supply Boolean `atTime` | Executed rejection: `MalformedSemanticQueryRequestError`; aggregate executor count exactly zero. |
| Temporal argument validation accepts syntax but not the declared value domain | temporarily reinstate the former regex/`Date.parse` check and supply nonexistent `2026-02-30T00:00:00.000Z` | **RED:** `malformed parameter reached the provider`; the assertion expected `MalformedSemanticQueryRequestError`. The restored check also rejects hour 24, offset input for `utcInstant`, and missing milliseconds for a millisecond declaration before provider execution. |
| Provider result shape accepts any string as exact decimal | temporarily remove the precision/scale/canonical-decimal validation and return `NaN` | **RED:** `Missing expected rejection.` The restored check independently rejects `NaN`, `1e3`, scale 7 against scale 6, and a 33-integer-digit value against precision 38/scale 6. |
| Signed sub-unit literal is declaration-only | temporarily reinstate the former provider decimal validator, then execute the O0 write and compiled `amount >= -0.25` term | **RED:** `MODULE_FIELD_VALUE_INVALID`; with the fix, the gateway total includes `-0.25` and equals the IR evaluator. |
| Tenant/environment restriction is replaceable | same stock identity and time exist in both foreign scopes | real gateway result remains the same; forced RLS and policy catalog are observed |

## Review round 1

The first fresh Codex review of `622308b8157c762b695c9bd832a2d1502bc11109`
returned REVISE on two gateway-boundary gaps. Both were material: the temporal
argument check admitted values outside the compiled temporal domain, and the
aggregate result check trusted any string despite its exact-decimal contract.
The fixes are deliberately at the gateway boundary: untrusted request arguments
are rejected before provider execution, while untrusted executor results are
rejected before a semantic result is returned. The two independent former-code
reds above prove each check is load-bearing.

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
| Compiler | 78/78 after merging accepted G3-P1b |
| Integration | 59/59 |
| Architecture | 98/98 after merging accepted G3-P2a |

The untouched base compiler suite was 74/74. Q1-P3b adds no new test file, so
no repository-hygiene or reachability inventory entry is required; the
modified PostgreSQL file remains in the existing CI-discovered glob.

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

The exact final full-matrix counts and review verdicts are reported with the
frozen candidate SHA so this document does not change the SHA whose evidence it
names. Acceptance requires the complete install, format, lint, typecheck, build,
boundaries, schema, aggregate `test` chain, and security-scan matrix; a non-empty
fresh Codex xhigh review artifact; and a non-empty Fable max confirmation
artifact for the identical unchanged SHA.
