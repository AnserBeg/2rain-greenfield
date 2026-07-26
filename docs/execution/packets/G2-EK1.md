# G2-EK1 — Expression kernel ceiling and strict runtime fence

Status: active — implementation and development evidence complete; full matrix and Critical review pending
Tier: Critical
Branch: `packet/g2-ek1`
Base: `b0f9fb001404e0a95a8252fab55e9b5a07caef8a`
Frozen reviewed candidate: pending
Review: pending — fresh naive Codex xhigh, then Fable max on the identical SHA

## Outcome

G2-EK1 records the expression-kernel ceiling in
`docs/decisions/ADR-0012-expression-kernel-ceiling.md` and replaces three lax
literal-true predicate checks with one strict, wire-shaped canonical-model entry
point. Runtime behavior is deliberately not widened: the only executable
predicate remains an exact literal `true` with a supported per-node language
version and no unknown properties.

The packet changes no canonical family, language/profile version, compiler
projection, release artifact, golden vector, or demo release root.

### Projection-family answer

**Yes: first-class `FormulaRuleDefinition` objects require a dedicated compiled
formula/rule projection family.** Inline query and operation predicates cannot
carry the plan-required cross-position profile, dependency graph, target and
lowering identity, cost/probe evidence, sink closure, explanation, and
deterministic-assertion references. The queued v3 packet must add that family
together with capability disclosures, buying one language/profile bump rather
than two. G2-EK1 states the contract but adds no family or output.

## Baseline at the exact base

The full unchanged-base matrix was re-established before branch creation at
`b0f9fb0`:

| Gate | Baseline result |
|---|---|
| frozen install | PASS — pnpm 11.9.0; 13 workspaces current |
| format / lint / typecheck / build | PASS |
| dependency boundaries | PASS — 101 files scanned |
| unit | PASS — 35/35 |
| compiler | PASS — 52/52 |
| integration | PASS — 46/46 |
| agent | PASS — 3/3 |
| architecture | PASS — 51/51 |
| contracts | PASS — 6/6 |
| schema | PASS — 10 applied / 10 verified; no drift |
| PostgreSQL | PASS — 70/70, first attempt |
| locale | PASS — 1/1 |
| browser | PASS — 7/7 |
| observability | PASS — 5/5 |
| reachability | PASS — 60/60 files from 9 producer artifacts |
| demo release | PASS — checked-in root unchanged |
| security | PASS — 262 commits clean; the disposable negative fixture produced its one expected finding |

## ADR decisions

ADR-0012 ratifies only the binding core requested by the converged debate:

- `PredicateExpression` is Formula IR's wire-compatible v0; serialized kinds do
  not move.
- Formula IR is total and terminating, has no loops or operation invocation,
  and reuses the existing depth ceiling of 24.
- Every binding position declares context, result, phase, purity,
  dependencies, absent/error behavior, and one of five execution targets.
- SQL admissibility is a cost class (`indexedEquality`,
  `indexedFoldedEquality`, `indexedPrefixRange`, `tenantBoundedScan`) paired
  with execution observation, not a binary indexability assertion.
- Canonical-model owns the version-dispatched wire parser; each execution
  target has one evaluator, with a server-inclusive duplicate-dispatch
  tripwire.
- Workflow mutations invoke whole Semantic Operations and compensate with
  named correcting operations.
- Saved-filter criteria are versioned canonical predicate envelopes validated
  against the pinned release; user preference writes go through a Semantic
  Operation because ADR-0008's administrative carve-out does not include them.
- Search input is ruled literal text. The prefix packet must evidence the
  intentional removal of today's unescaped `%`/`_` wildcard behavior.
- The seven-part client-target admission bar is fixed; no client evaluator is
  built.

Detailed profiles, durable receipt schemas, additional cost classes,
cross-target null/decimal/fold parity, an expression assertion family, and
volatile context bindings remain explicitly deferred.

### Mandated salvage inputs

Both quarry artifacts were read under `salvage-admission` REFERENCE mode and
cited in ADR-0012; neither enters this repository.

- `/home/rvham/2rain_erp/m0c-cel-spike-report.md` records structured builder
  only for v1 and rejects CEL source/parser/runtime authority. ADR-0012 agrees:
  textual CEL would imply excluded numeric, macro, collection, temporal, and
  function semantics and create a second parser.
- `/home/rvham/2rain_erp/docs/selfserve-split-map.md` supplied the dormant
  predicate checklist used to account for typing, bounds, dependencies,
  evaluation targets, saved-filter/default/validation positions, historical
  readers, parity, security, provider, and release evidence.
- The quarry's one `RuntimeConditionAst` named six consumers, yet
  `runtime-metric-service.ts:478-515` reimplemented equality with strict `===`
  while the canonical evaluator used coercing `scalarEqual` at
  `condition-evaluator.ts:346-359`. That measured fork is the evidence for one
  owned evaluator per execution target.

## Runtime fence convergence

`packages/canonical-model/src/predicate-kernel.ts` exposes a pure
`unknown -> PredicateKernelReceipt` entry point. It closes the node shape,
dispatches explicitly across `v0-experimental`, `v1`, and `v2`, copies an
accepted node into a frozen wire-shaped result, and rejects unknown versions,
unknown properties, unknown kinds, false literals, arrays, nulls, and other
non-records.

`normalize.ts` now uses the same entry point when identifying an authored
default, deleting its private lax spelling. Query-filter, operation-precondition,
and operation-read-back checks use the same entry point. Their exact outcomes
remain:

```text
query-filter-unsupported
SEMANTIC_OPERATION_PRECONDITION_UNSUPPORTED
SEMANTIC_OPERATION_READ_BACK_UNSUPPORTED
```

The two operation failures still traverse `#recordNonAccepted`; integration
evidence asserts the row handed to the persistence port, not only the returned
unsupported envelope. Existing PostgreSQL trust tests separately prove that
non-accepted invocation rows are durably stored and RLS-scoped.

The runtime package gains its first canonical-model workspace dependency. The
authorized lockfile bridge was regenerated with pnpm 11.9.0. Its entire diff is
the `packages/runtime` importer gaining
`@north-star/canonical-model: workspace:*`; no other importer, resolved package,
or lockfile version moved.

## Negative controls and retained reds

Each temporary mutation below was restored before the next control. The final
focused suite is green and `git diff --check` is clean.

### Unknown node version cannot pass

Temporary mutation: route an unknown node version through the current v2
literal parser.

```text
$ node --import tsx --test --test-name-pattern="strict predicate receipts" test/integration/module-runtime.test.ts
# Subtest: unknown schemaVersion: query filter
not ok 1 - unknown schemaVersion: query filter
Expected values to be strictly equal:
+ actual - expected
+ 'exact'
- 'unsupported'
# Subtest: unknown schemaVersion: operation precondition
not ok 2 - unknown schemaVersion: operation precondition
+ 'succeeded'
- 'unsupported'
# Subtest: unknown schemaVersion: operation read-back
not ok 3 - unknown schemaVersion: operation read-back
+ 'succeeded'
- 'unsupported'
# tests 7
# pass 3
# fail 4
```

All three sites fail, so no site can silently retain the former lax behavior.

### Unknown property cannot pass or be normalized away

Temporary mutation: remove the kernel's exact-key check.

```text
$ node --import tsx --test --test-name-pattern="strict predicate receipts" test/integration/module-runtime.test.ts
# Subtest: unknown property: query filter
not ok 4 - unknown property: query filter
+ 'exact'
- 'unsupported'
# Subtest: unknown property: operation precondition
not ok 5 - unknown property: operation precondition
+ 'succeeded'
- 'unsupported'
# Subtest: unknown property: operation read-back
not ok 6 - unknown property: operation read-back
+ 'succeeded'
- 'unsupported'
# tests 7
# pass 3
# fail 4
```

The parser neither defaults nor repairs the input before measurement; removing
the unknown-property rejection is directly observable.

### Routing must emit an observed canonical receipt

Temporary mutation: remove the receipt-observer call at all three sites while
leaving canonical evaluation intact.

```text
$ node --import tsx --test --test-name-pattern="strict predicate receipts" test/integration/module-runtime.test.ts
# Subtest: unknown schemaVersion: query filter
not ok 1 - unknown schemaVersion: query filter
0 !== 1
# Subtest: unknown schemaVersion: operation precondition
not ok 2 - unknown schemaVersion: operation precondition
0 !== 1
# Subtest: unknown schemaVersion: operation read-back
not ok 3 - unknown schemaVersion: operation read-back
+ []
- [ 'accepted', 'rejected' ]
...
# tests 7
# pass 0
# fail 7
```

The result alone is therefore insufficient; all three paths must produce an
observed receipt.

### Exact per-site codes and non-accepted rows cannot drift

Temporary mutation: replace all three codes with explicit `*_CODE_DRIFT`
sentinels.

```text
$ node --import tsx --test --test-name-pattern="strict predicate receipts" test/integration/module-runtime.test.ts
# Subtest: unknown schemaVersion: query filter
not ok 1 - unknown schemaVersion: query filter
+ 'query-filter-code-drift'
- 'query-filter-unsupported'
# Subtest: unknown schemaVersion: operation precondition
not ok 2 - unknown schemaVersion: operation precondition
+ failureCode: 'SEMANTIC_OPERATION_PRECONDITION_CODE_DRIFT'
- failureCode: 'SEMANTIC_OPERATION_PRECONDITION_UNSUPPORTED'
# Subtest: unknown schemaVersion: operation read-back
not ok 3 - unknown schemaVersion: operation read-back
+ failureCode: 'SEMANTIC_OPERATION_READ_BACK_CODE_DRIFT'
- failureCode: 'SEMANTIC_OPERATION_READ_BACK_UNSUPPORTED'
# tests 7
# pass 0
# fail 7
```

The operation assertions read the recorded persistence rows; a matching return
value cannot hide a missing or changed non-accepted record.

### A fourth server spelling is detected

Temporary mutation: add the former lax helper to the server query gateway.

```text
$ node --import tsx --test --test-name-pattern="literal-true predicate dispatch" test/architecture/canonical-contracts-purity.test.ts
not ok 1 - literal-true predicate dispatch has one canonical owner, with a server-inclusive canary
+ [
+   '/home/rvham/2rain-greenfield/packages/runtime/src/semantic-query-gateway.ts'
+ ]
- []
# tests 1
# pass 0
# fail 1
```

This scan is intentionally recorded as a proxy. It detects the known
literal-true redispatch spelling in canonical-model and server runtime source;
it does not prove that every conceivable implementation is semantically an
evaluator.

### Zero subjects are reported explicitly

The permanent empty-catalog journey asserts that no predicate entry point ran.
Temporarily changing its expected observed count from zero to one produced:

```text
$ node --import tsx --test --test-name-pattern="empty catalogs execute zero" test/integration/module-runtime.test.ts
not ok 1 - empty catalogs execute zero predicate-kernel inputs explicitly
zero catalog subjects must be reported as zero kernel inputs
0 !== 1
# tests 1
# pass 0
# fail 1
```

Zero is therefore measured and named, not treated as implicit success.

### Canonical-output boundary

The first combined architecture run was red at 51/52 because
`request-runtime-view-boundary.test.ts` correctly pinned runtime's former zero
dependencies:

```text
not ok 30 - Freeze D has one provider-neutral RequestRuntimeView authority and preserves request-context exports
+ { '@north-star/canonical-model': 'workspace:*' }
- undefined
```

The owned test was strengthened to require exactly the single new workspace
edge. Architecture returned to 52/52.

The first format check after implementation was also red on four changed files;
repository Prettier formatted those files and the focused format/typecheck/lint
loop returned green.

Compiler then passed 52/52, `check:demo-release` passed without regeneration,
and this boundary command returned zero diff:

```text
git diff --exit-code -- 'test/**/*.golden.bytes' \
  'test/**/*.golden.sha256' apps/web/release/shell.compiled.json
```

No golden or compiled shell file is present in the packet diff.

## Full-matrix evidence

Pending at the frozen candidate.

## Test it yourself

Pending final frozen SHA. The focused falsification flow will run the strict
kernel unit, all three gateway routes, the duplicate-dispatch proxy, compiler
goldens, and demo-release in under ten minutes.

## Review evidence

Pending.

## Known limits

- Only exact literal `true` executes. ADR-0012 creates no authority for wider
  evaluation.
- Runtime receipts are returned by the pure canonical entry point. Tests inject
  a read-only observer, not an alternate parser, so instrumentation cannot widen
  admission. Durable receipt/explanation formats are deferred as ADR-0012 states.
- The architecture source scan is a bounded proxy for the known fork pattern.
- Formula/rule and capability-disclosure projection families remain absent
  until the single queued v3 language/profile evolution.
- This packet cannot prove future SQL, workflow, saved-filter, client, or
  cross-target parity behavior that it deliberately does not implement.
