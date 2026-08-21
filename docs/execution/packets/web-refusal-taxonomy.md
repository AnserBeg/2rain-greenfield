# web-refusal-taxonomy — truthful web-boundary refusals and slot-local failure

Date: 2026-08-20

Base: `8136cfaa8caf23a73221cfa2b0feb5c90987556b`

Branch: `packet/web-refusal-taxonomy`

Tier: Critical

Status: Stop 2 — full matrix requires an architecture-test bridge

## Goal

Remove two traps before Purchasing and Sales fan out:

1. preserve the typed runtime-view refusal reason at the HTTP boundary and stop
   presenting an identified provider refusal as generic unavailability; and
2. keep an unsupported non-mutation slot visibly failed without allowing it to
   veto a write rendered by a registered mutation-bearing slot.

The packet may change what a refusal says. It does not change what is admitted.
`resolveFormAdmission`, `operationAvailableForRecord`, command-bar admission,
and posted-transaction preconditions are outside the change.

## Rulings

### Open provider vocabulary gets an honest residual

Yes: an identified `ModuleRuntimeInterpreterError` whose code has no dedicated
catalog entry renders `OPERATION_REFUSED`, names its stable provider code as a
separate subject, and tells the operator to give that code to an administrator.
Calling it `OPERATION_UNAVAILABLE` was worse: the provider had answered, and the
answer was a refusal for a known reason. A code-bearing residual is cheaper and
more honest than pretending the provider's extensible string contract is a
closed union. Errors without provider refusal identity retain
`OPERATION_UNAVAILABLE`.

The already-specific inactive-legal-entity mapping remains specific. The
provider contract itself is not changed here; its 61-code opening evidence is
filed once in
[provider-operation-refusal-contract.md](provider-operation-refusal-contract.md).

### Unsupported non-mutation slots fail locally

`activity` and `childTables` remain unregistered. Fake registrations would
claim semantics the runtime does not implement and contradict ADR-0054. A
declared unsupported slot still renders `UNSUPPORTED_COMPONENT`; it no longer
participates in mutation-intent support for another registered slot. The
amendment is recorded in
[ADR-0054](../../decisions/ADR-0054-a-record-form-declares-the-anatomy-that-renders-it.md).

The fixture-only Save fallback was removed. Current first-party forms all
declare `commandBar`; an older one-slot fixture now proves that no mutation
control is synthesized when that slot is absent.

## Stop 1 — accepted re-scope

The original charter required exhaustiveness over the provider's operation
refusal vocabulary but did not grant the provider contract, while two live
lanes owned `packages/postgres-provider`. It also omitted `app-server.ts`, the
actual typed runtime-view erasure boundary. Work stopped before a lease or
contract violation. The user granted `app-server.ts`, routed the open provider
contract to its own packet, and retained this packet's slot and web-boundary
halves. Stop count: 1.

## Evidence

The committed controls include:

- a compile-time exhaustive table over all 15
  `RequestRuntimeViewLoadErrorCode` members, with every member observed crossing
  the HTTP mapping as `REQUEST_RUNTIME_VIEW_REFUSED` plus its code;
- a browser journey that distinguishes the complete observable for invalid
  binding, unsupported query, and unavailable runtime view;
- a browser create with an unregistered `activity` slot visibly failed while
  registered `sections` and `commandBar` remain operable;
- an actual provider parser refusal shown as `Operation refused` with
  `MODULE_REQUIRED_FIELD_MISSING`, rather than `Save unavailable`; and
- the no-`commandBar` fixture showing that the removed compatibility Save does
  not return.

### Negative controls — one property varied per claim

The provider-boundary source specimens are committed controls. Production-code
mutants were applied to the otherwise passing working tree, run, and immediately
reverted.

| Claim | One-property mutant | Observed red |
|---|---|---|
| A non-mutation slot cannot veto writes | Restored `surfaceHasUnsupportedComponent(surface) ||` in `surfaceSupportsRuntimeIntent` | `test:contracts` 17/18; `closed registry returns diagnostics for unknown and failing components` received `false` where writable was required |
| An identified provider refusal does not collapse to unavailable | Replaced the open-code residual return with `OPERATION_UNAVAILABLE` | `test:contracts` 17/18; expected `OPERATION_REFUSED` plus `MODULE_REQUIRED_FIELD_MISSING`, received `OPERATION_UNAVAILABLE` |
| The mapper helper preserves its exact typed code | Replaced `subject: error.code` with one erased constant | `test:contracts` 17/18; first table member expected `ACTIVE_POINTER_MISSING`, received `ERASED_RUNTIME_VIEW_CODE`. Round 1 correctly ruled this a helper-level proxy, not HTTP-boundary evidence; it is retained as historical evidence but does not count for the boundary claim. |
| The typed runtime-view table is exhaustive | Deleted only `ACTIVE_POINTER_MISSING` from the 15-code record | `typecheck` exit 2, TS1360: required property `ACTIVE_POINTER_MISSING` is missing |
| Invalid binding remains distinct from unsupported query | Changed only the invalid-binding render code back to `QUERY_UNSUPPORTED` | focused browser control 0/1; complete observable expected `INVALID_SURFACE_BINDING`, received `QUERY_UNSUPPORTED` |
| No fixture-only Save is synthesized | Restored only the conditional compatibility Save branch | focused browser control 0/1; expected zero Save buttons, received one |
| Every typed code traverses the HTTP catch-and-render boundary | Narrowed only the `RequestRuntimeViewLoadError` catch to `UNSUPPORTED_RUNTIME_CAPABILITY`, the one existing browser census member | `test:contracts` 18/19; the first non-browser member, `ACTIVE_POINTER_MISSING`, rendered `REQUEST_RUNTIME_VIEW_UNAVAILABLE` where the HTTP census required `REQUEST_RUNTIME_VIEW_REFUSED` |
| The exact error-class exception is required | Removed only the exact allowed declaration from the actual `app-server.ts` source, leaving no provider reference for the residual predicate to reject | With the exact-occurrence predicate deleted, `test:contracts` 19/20; only `app-server provider boundary red: the required error-class import cannot disappear` failed with `Missing expected exception` |
| No second provider authority may cross the boundary | Preserved the exact allowed declaration once and appended a separate `PostgresRequestRuntimeViewService` import to the actual source | With the residual-provider predicate deleted, `test:contracts` 19/20; only `app-server provider boundary red: a separate provider loader import is refused` failed with `Missing expected exception` |

The focused Playwright mutant invocations intentionally carry a name filter;
the repository's unfiltered reporter therefore also reports the filter as an
unrecognized argument. The attributable red above is the named test's own
failed assertion, not the reporter's filter refusal.

### Candidate gates

All gates below ran against the candidate tree after every production and test
change was complete:

- `pnpm typecheck`: green;
- `pnpm lint`: green;
- `pnpm format`: green;
- `pnpm test:browser`: 92/92 green;
- `pnpm test:integration`: 149/149 green; and
- `pnpm test:contracts`: 18/18 green at round 1, 19/19 green after the
  corrected HTTP-boundary control, and 20/20 green after the provider-boundary
  predicates received separately attributable controls.

The full CI matrix was deferred until review converged, as the packet charter
requires. Its first post-review run is recorded below.

### Full-matrix attempt — RED at narrative descendant `5040a88a193a6cd8109d31e410fbf3f2cfba1d9e`

The executable diff from reviewed candidate
`03860aa85887f41027a42d8f6e40177a871a0d51` to the matrix SHA is empty under
`git-workflow`'s exact narrative exclusions. The matrix acquired the serialized
slot and pinned that SHA. Performance passed at 99.6% idle with a 2570.3 ms
best-of-five CPU sample against the 5000 ms budget. Format, lint, typecheck,
build, dependency boundaries, schema (21/21 migrations), demo/app release
checks, unit 120/120, compiler 150/150, integration 149/149 and agent 3/3 all
passed.

Architecture then reported 140/141. The sole failure was
`apps/web has no PostgreSQL, SQL, provider, or direct database access` in
`test/architecture/surface-data-binding.test.ts`: its pre-packet blanket regex
rejects the reviewed exact `RequestRuntimeViewLoadError` import in
`apps/web/src/app-server.ts`. The run terminated honestly with
`FULL_MATRIX_FAILED rc=1 sha=5040a88a193a6cd8109d31e410fbf3f2cfba1d9e`;
contracts, PostgreSQL, locale, browser, reachability and security did not run in
this matrix attempt.

## Stop 2 — architecture-test bridge required

The packet was explicitly granted `apps/web/src/app-server.ts`, but its owned
paths do not include `test/architecture/surface-data-binding.test.ts`. No
production or admission change can honestly satisfy both the granted typed
error-class boundary and that stale blanket assertion. The smallest bridge is
to keep the existing SQL/direct-database prohibitions, allow exactly the one
literal `RequestRuntimeViewLoadError` declaration in `app-server.ts`, remove it
before applying the provider prohibition to the remainder, and retain the
already committed missing-import, additional-provider and valid-source controls.
That gate change is outside this lane's lease and changes executable evidence,
so this lane stopped without editing it or merging. Stop count: 2.

### Live composed-application observation

`pnpm dev` served the composed application on port 4174. A real Item create
was posted with SKU and name present but its required base unit omitted. The
provider refused the write and the returned complete diagnostic was HTTP 422,
`OPERATION_REFUSED`, sentence `Operation refused`, detail `The provider refused
this operation for a reason this application cannot yet present in plain
language.`, next action `Give the refusal code to an administrator before
trying this operation again.`, and subject
`MODULE_REQUIRED_FIELD_MISSING`. This is the same path that previously told the
operator only `Save unavailable`.

After `pnpm --filter @north-star/api dev:stop` stopped the database container,
the Node listener remained. PID 10066 was resolved as
`node --import tsx src/main.ts`, killed explicitly, and port 4174 was confirmed
clear.

## Checkpoint trigger evaluation

The immediately preceding program review produced finding R3 and explicitly
required this correction before Purchasing and Sales fan-out. This packet
closes the bounded web half of that finding; it does not introduce a new
correctness domain, reach a stage boundary, or accumulate new strategic drift.
A second program review is therefore not due at this pre-review checkpoint.

`bash scripts/check-parked-work.sh` also ran at the checkpoint and surfaced
eight stale pre-existing branches: `packet/proj-disc`, `packet/ps-0`,
`packet/ps-1`, `packet/ps-2`, `packet/pur-1`,
`packet/relation-scoped-enumeration`, `packet/scoped-create-operand`, and
`packet/u5-design`. It exited 1 as designed. Those refs are outside this lane's
ownership and require an orchestrator decision; this packet did not modify or
delete them.

## Review evidence

### Round 1 — `d0fa6410808ea166f198b3c0f6167e9ab8d9e421`

Fresh-naive Codex xhigh returned `REVISE` with two material control findings:

1. the exhaustive 15-code test called `runtimeViewRefusalMessage` directly and
   therefore proved the mapper helper rather than the HTTP boundary named by
   the test; and
2. the source boundary required the provider module path but did not restrict
   that exception to `RequestRuntimeViewLoadError`, so the ambient
   `PostgresRequestRuntimeViewService` loader could join the import without a
   red.

Both findings were accepted. The first correction keeps the compile-time union
record but iterates every member through a real loopback request whose loader
throws `RequestRuntimeViewLoadError`; it observes HTTP status, diagnostic code,
status role, visible sentence, visible subject, visible code, and absence of the
generic-unavailable code. The second removes exactly the one allowed import
declaration before applying the provider prohibition to the remainder of
`app-server.ts`, and carries a committed single-property loader-import red.
Neither correction changes production behavior or enters `packages/**`.

### Round 2 — `5ff6db8a134aca151e523b886c4aa5e25dc038f5`

Fresh-naive Codex xhigh returned `REVISE` with one material evidence finding.
The committed provider-boundary mutant changed the exact allowed declaration by
adding the loader as a second named specifier. That made both the exact-occurrence
predicate and the residual-provider predicate fail, so deleting either predicate
left the control green. The record's single-property and attribution claim was
therefore false.

The finding was accepted. The combined specimen is replaced by two committed
controls over the actual `app-server.ts` source: one removes the exact allowed
declaration while proving no provider reference remains, and the other preserves
that declaration exactly once while appending a separate loader import. Each
predicate was then deleted alone; exactly its corresponding control failed while
the sibling stayed green, as recorded in the negative-control table. The two
predicates also carry distinct failure messages so the committed controls observe
which rule rejected the source.

Round-three continuation is licensed by the convergence rule's subsuming-control
criterion: the confounded specimen was not extended with another adjacent case;
it was decomposed into one-property specimens per predicate, and each predicate
was removed independently. Production remains unchanged, the claimed boundary
has not widened, and another same-class attribution finding would require
narrowing or routing rather than another specimen.

### Round 3 — `03860aa85887f41027a42d8f6e40177a871a0d51`

The last narrow Codex xhigh arm returned `PASS`. Decisive question 6 was closed:
the real-source missing-import specimen can fail only the exact-occurrence
predicate, the separate-loader specimen can fail only the residual-provider
predicate, their messages are distinct, and the positive real-source admission
twin rules out unconditional refusal. The reviewer found no in-scope plain-source
survivor. A comment or string retaining the exact import text after removing the
real declaration was correctly recorded as an out-of-threat-model scanner limit,
not an AST-level guarantee this packet claims.

### Independent Critical confirmation — `03860aa85887f41027a42d8f6e40177a871a0d51`

Fresh Fable max returned `PASS` on the identical SHA with all eight decisive
questions closed. It independently traced the real provider error class through
the operation gateway, the subject-bearing catalog union and escaped renderer,
all 15 runtime-view codes through the HTTP boundary, registered mutation intent
through the slot registry and submit path, unchanged admission/precondition
logic, command-bar Save ownership, the three complete browser observables, and
the separately attributable provider-import controls. No in-scope material
defect survived.

Two non-material next-touch observations are retained without changing reviewed
bytes: a comment in `surface-runtime-contract.test.ts` still describes
`INVALID_SURFACE_BINDING` as unreachable and cites the old real-path driver count,
and `surfaceHasUnsupportedComponent` plus `operationMessageCode` now have no
production callers. The valid out-of-scope finding that query-side interpreter
refusals still collapse to `QUERY_UNAVAILABLE` is routed as
`provider-query-refusal-taxonomy` in `current-plan.md`.
