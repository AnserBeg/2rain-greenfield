# web-refusal-taxonomy — truthful web-boundary refusals and slot-local failure

Date: 2026-08-20

Base: `8136cfaa8caf23a73221cfa2b0feb5c90987556b`

Branch: `packet/web-refusal-taxonomy`

Tier: Critical

Status: evidence_ready — corrected executable candidate awaiting narrow Critical confirmation

## Goal

Remove two traps before Purchasing and Sales fan out:

1. translate the provider's typed runtime-view load refusal into a runtime-owned
   refusal before the web boundary, preserve its reason at HTTP, and stop
   presenting an identified refusal as generic unavailability; and
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

- a runtime-owned closed 15-code refusal contract plus a compile-time
  bidirectional equality check against `RequestRuntimeViewLoadErrorCode`, with
  every real provider error member observed crossing runtime translation and
  the HTTP mapping as `REQUEST_RUNTIME_VIEW_REFUSED` plus its code;
- a browser journey that distinguishes the complete observable for invalid
  binding, unsupported query, and unavailable runtime view;
- browser creates with each unregistered non-mutation slot, `activity` and
  `childTables`, visibly failed while registered `sections` and `commandBar`
  remain operable;
- an actual provider parser refusal shown as `Operation refused` with
  `MODULE_REQUIRED_FIELD_MISSING`, rather than `Save unavailable`; and
- the no-`commandBar` fixture showing that the removed compatibility Save does
  not return.

### Negative controls — one property varied per claim

The provider-boundary source specimens are committed controls. Production-code
mutants were applied to the otherwise passing working tree, run, and immediately
reverted. Those mutants are ad-hoc observations, not a committed mutation
harness; only the checked-in tests count as shipped executable evidence.

| Claim | One-property mutant | Observed red |
|---|---|---|
| A non-mutation slot cannot veto writes | Restored `surfaceHasUnsupportedComponent(surface) ||` in `surfaceSupportsRuntimeIntent` | `test:contracts` 17/18; `closed registry returns diagnostics for unknown and failing components` received `false` where writable was required |
| An identified provider refusal does not collapse to unavailable | Replaced the open-code residual return with `OPERATION_UNAVAILABLE` | `test:contracts` 17/18; expected `OPERATION_REFUSED` plus `MODULE_REQUIRED_FIELD_MISSING`, received `OPERATION_UNAVAILABLE` |
| The mapper helper preserves its exact typed code | Replaced `subject: error.code` with one erased constant | `test:contracts` 17/18; first table member expected `ACTIVE_POINTER_MISSING`, received `ERASED_RUNTIME_VIEW_CODE`. Round 1 correctly ruled this a helper-level proxy, not HTTP-boundary evidence; it is retained as historical evidence but does not count for the boundary claim. |
| The provider and runtime refusal vocabularies cannot drift | Deleted only `ACTIVE_POINTER_MISSING` from the runtime-owned 15-code record | `typecheck` exit 2, TS1360: `Readonly<{}>` does not satisfy `Record<"ACTIVE_POINTER_MISSING", never>` |
| Runtime-only vocabulary drift cannot hide behind the provider-to-runtime check | Added only `RUNTIME_ONLY_REFUSAL_SENTINEL` to the runtime-owned record | `typecheck` exit 2, TS1360 at `RUNTIME_CODES_MISSING_FROM_PROVIDER`: `Readonly<{}>` does not satisfy `Record<"RUNTIME_ONLY_REFUSAL_SENTINEL", never>` (the executed HTTP loop also rejected the sentinel as not assignable to the provider union) |
| Invalid binding remains distinct from unsupported query | Changed only the invalid-binding render code back to `QUERY_UNSUPPORTED` | focused browser control 0/1; complete observable expected `INVALID_SURFACE_BINDING`, received `QUERY_UNSUPPORTED` |
| No fixture-only Save is synthesized | Restored only the conditional compatibility Save branch | focused browser control 0/1; expected zero Save buttons, received one |
| Runtime entry preserves an identified loader refusal | Re-threw the recognized provider error instead of translating it to `RequestRuntimeViewRefusalError` | `test:contracts` 20/21; `ACTIVE_POINTER_MISSING` rendered `REQUEST_RUNTIME_VIEW_UNAVAILABLE` where the HTTP census required `REQUEST_RUNTIME_VIEW_REFUSED` |
| Translation is confined to the loader call | Applied the same translation around `unitOfWork(view)` | `test:contracts` 20/21; the untouched-failure control received `RequestRuntimeViewRefusalError` instead of the exact original `RequestRuntimeViewLoadError` object |
| Translation preserves synchronous evaluation and immediate rejection precedence | Made only `startRuntimeDefinitionLoad` `async` and awaited the loader | `test:contracts` 21/24; the synchronous-loader control observed one policy call instead of zero, the immediate dual rejection returned the policy error, and synchronous near-miss loaders also called policy |
| Synchronous policy evaluation is not deferred behind an already-rejected loader | Wrapped only `readCurrentVersion(subject)` in `Promise.resolve().then(...)` | `test:contracts` 28/29; `a synchronous policy throw wins before an already-rejected loader is joined` received translated loader code `ACTIVE_RELEASE_NOT_VISIBLE` instead of the exact raw policy error `ACTIVE_RELEASE_NOT_ADMITTED` |
| Either pending input settles the join without waiting for its sibling | Replaced only the two-input join with `Promise.allSettled`, still preferring the loader when both reject | `test:contracts` 27/29; both controlled first-rejection specimens remained `pending` across the observed event-loop turn while their sibling stayed unresolved |
| A provider-shaped policy failure is outside loader translation | Sent only the policy rejection handler through `runtimeDefinitionFailure` | `test:contracts` 23/24; `runtime entry translation is confined to loader failures` received `RequestRuntimeViewRefusalError` instead of the exact policy error object; the unit-of-work arm remained green |
| An asynchronously rejected unit of work remains outside loader translation | Invoked `unitOfWork(view)` before a `try`, then translated only rejection from awaiting its returned promise | `test:contracts` 27/29; the adapter identity control received `RequestRuntimeViewRefusalError`, and the loopback response rendered `REQUEST_RUNTIME_VIEW_REFUSED` instead of `REQUEST_RUNTIME_VIEW_UNAVAILABLE` |
| Only real `Error` instances can carry the provider refusal shape | Replaced only the `instanceof Error` predicate with a structural non-null-object predicate | `test:contracts` 23/24; the plain-object specimen was translated instead of remaining the exact original object and rendering the unavailable fallback |
| The provider refusal name must be exact | Deleted only the exact-name predicate | `test:contracts` 23/24; the wrong-name `Error` specimen was translated instead of remaining the exact original object and rendering the unavailable fallback |
| A string code must belong to the runtime-owned closed map | Deleted only the `Object.hasOwn` membership predicate | `test:contracts` 23/24; the unknown-string specimen was translated instead of remaining the exact original object and rendering the unavailable fallback. Missing and numeric code specimens are committed adjacent one-property controls. |
| Every translated code traverses the HTTP catch-and-render boundary | Narrowed only the `RequestRuntimeViewRefusalError` catch to `UNSUPPORTED_RUNTIME_CAPABILITY`, the existing browser census member | `test:contracts` 20/21; the first other member, `ACTIVE_POINTER_MISSING`, rendered `REQUEST_RUNTIME_VIEW_UNAVAILABLE` where the HTTP census required `REQUEST_RUNTIME_VIEW_REFUSED` |
| `childTables` cannot independently re-arm the slot veto | Added only a `childTables` early refusal to `surfaceSupportsRuntimeIntent` | `test:contracts` 23/24; the `activity` iteration passed and the same contract failed at `childTables`, receiving `false` where writable was required |
| The exact runtime-owned error import is required | Removed only the exact runtime declaration from the actual `app-server.ts` source, leaving no provider reference for the residual predicate to reject | With the exact-occurrence predicate deleted, `test:contracts` 20/21; only `app-server runtime refusal boundary red: the required runtime-owned import cannot disappear` failed with `Missing expected exception`; the provider-import sibling stayed green |
| No provider authority may cross the web boundary | Preserved the exact runtime declaration once and appended a separate `PostgresRequestRuntimeViewService` import to the actual source | With the residual-provider predicate deleted, `test:contracts` 20/21; only `app-server runtime refusal boundary red: a provider loader import is refused` failed with `Missing expected exception`; the required-import sibling stayed green |

The focused Playwright mutant invocations intentionally carry a name filter;
the repository's unfiltered reporter therefore also reports the filter as an
unrecognized argument. The attributable red above is the named test's own
failed assertion, not the reporter's filter refusal.

### Superseded candidate gates — provider-import design

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

## Stop 2 — accepted; the requested architecture bridge was refused

The packet was explicitly granted `apps/web/src/app-server.ts`, but its owned
paths did not include `test/architecture/surface-data-binding.test.ts`. The
matrix proved the conflict and the lane stopped rather than weaken an
out-of-lease gate. The user accepted the stop and refused the proposed bridge:
the blanket rule is a real architecture boundary, `apps/web` imports no provider
on main, and admitting the packet's own first provider import would have made
the gate ratify the defect it was meant to detect. Stop count belonged to the
superseded charter and reset to zero on the re-scope.

## Architecture ruling and runtime-translation re-scope

The provider's `RequestRuntimeViewLoadError` is now translated inside
`AuthenticatedRequestRuntimeEntryAdapter`, at the runtime-owned loader port,
into `RequestRuntimeViewRefusalError`. Translation is deliberately confined to
`loader.load(context)`: authentication, current-policy, view construction and
unit-of-work errors retain their existing identities. Unknown loader failures
also retain their identity and therefore remain the web's honest
`REQUEST_RUNTIME_VIEW_UNAVAILABLE` fallback.

`apps/web/src/app-server.ts` imports only the runtime error. The unchanged
architecture suite is green 141/141 and independently observes that no web
production source imports PostgreSQL or a provider. The contract suite retains
the two separately attributable source predicates from the prior correction,
but their positive declaration is now the exact runtime-owned error import and
their residual predicate forbids every provider reference rather than admitting
one exception.

Production cannot import the provider merely to compare its union, so the
compile-time equality check lives in the contract test, which is allowed to
import both sides. `Exclude` in each direction makes a member present in only
one union require a property in an otherwise empty record and fail typecheck.
The runtime record is the executed census: each of its 15 keys constructs the
real provider error, crosses the entry translation, reaches the HTTP catch and
renders the exact subject. No `packages/postgres-provider/**` byte changes.

The earlier Codex and Fable PASSes remain historical evidence about
`03860aa`, but they do not apply to this redesign. Fresh Critical Codex and
Fable arms are owed on the new frozen SHA.

### First re-scoped candidate gates — `e8e2e014c7e3502f9bd2ae230fc2b151eb756959`

The redesigned executable tree completed the charter's pre-review gates:

- `pnpm typecheck`: green, including the provider/runtime union-equality gate;
- `pnpm lint`: green;
- `pnpm format`: green;
- `pnpm test:contracts`: 21/21 green;
- `pnpm test:integration`: 149/149 green;
- `pnpm test:browser`: 92/92 green; and
- `pnpm test:architecture`: 141/141 green, including the unchanged
  `apps/web has no PostgreSQL, SQL, provider, or direct database access` rule
  and the existing provider-neutral runtime-package rule.

The full matrix remains deferred until the fresh Critical review arms converge,
per `git-workflow` and the packet charter.

### Corrected executable candidate gates — `fa4139e96fec14602bdafa1e7aa0dab043e50273`

After reverting every recorded mutant, the corrected executable tree passed:

- `pnpm typecheck`: green;
- `pnpm lint`: green;
- `pnpm format`: green, with `git diff --check` also clean;
- `pnpm test:browser`: 93/93 green, including separate real saves beside
  visibly failed `activity` and `childTables` slots;
- `pnpm test:integration`: 149/149 green;
- `pnpm test:contracts`: 24/24 green, including synchronous evaluation,
  immediate rejection precedence, five classifier near misses, policy and
  unit-of-work confinement, and the 15-code real HTTP census; and
- `pnpm test:architecture`: 141/141 green, including the unchanged no-provider
  web boundary and provider-neutral runtime-package boundary.

`apps/web/src/**` is byte-identical to the first provider-neutral redesign at
`e8e2e014`; `packages/postgres-provider/**` is also unchanged. The only
production correction after that review is the bounded runtime entry seam in
`packages/runtime/src/request-runtime-view.ts`. The full matrix remains deferred
until the corrected Critical reviews converge.

### Evidence-only correction gates — `b852ffc05482d0ea710881e417e08ac9869d8611`

Production is byte-identical to `fa4139e96fec14602bdafa1e7aa0dab043e50273`.
The only executable correction is
`apps/web/test/surface-runtime-contract.test.ts`, which passed:

- `pnpm typecheck`: green;
- `pnpm lint`: green;
- `pnpm format`: green; and
- `pnpm --filter @north-star/web test:contracts`: 29/29 green.

Three ad-hoc reviewer-selected mutants were then applied separately and
immediately reverted. Deferred policy invocation produced 28/29, with only the
synchronous policy specimen red. The `Promise.allSettled` join produced 27/29,
with both pending first-rejection specimens still pending while their siblings
were held. Translating an awaited unit-of-work rejection produced 27/29, with the
exact adapter identity and loopback unavailable diagnostic both red. A final
restored run returned 29/29. These observations do not constitute three shipped
negative gates or exhaustive promise-ordering evidence. Browser, integration and
architecture were not rerun because their production inputs are unchanged; the
full matrix remains deferred until fresh Critical review converges.

### Measured settlement classes and declared limit

The committed controls establish only these timing classes:

- a synchronous loader throw is translated before policy is invoked;
- a synchronous policy throw after the loader returns wins before the join;
- two already-rejected inputs retain loader-first attachment precedence;
- either single pending rejection settles without waiting for its held sibling;
  and
- synchronous and asynchronous unit-of-work failures remain outside loader
  translation.

They do not establish every relative ordering of two pending rejections. The
independent reviewer named an ordinary survivor: wrap the already-invoked policy
promise in `.then((evidence) => evidence)`, then reject policy and loader in that
order during one resumed turn. The wrapper delays only the join's policy handler,
so the loader can overtake it even though policy rejected first. The lane applied
that exact mutation and observed `test:contracts` remain 29/29.

Production behavior is correct and remains unchanged. After repeated
evidence-only rounds, `review-tiers` requires the claim to narrow rather than grow
another adjacent timing table. Same-turn staggered precedence through a
post-invocation policy wrapper is therefore explicitly unproved here and routed
as `runtime-refusal-same-turn-precedence` in `current-plan.md`. This packet makes
no claim of exhaustive original-promise settlement evidence.

The orchestrator ruled that routed case non-gating for this packet; the lane did
not infer the disposition. The narrowing depends on the current reachability
fact: the composed production request path uses `AllowAllLocalPolicy`, release
verification and demo wiring are also allow-only, and all three
`readCurrentVersion()` implementations return fixed successful evidence without
a fallible read, adapter, validator, normalizer, or wrapper. No
production-reachable policy-side promise supplied to the join can therefore
reject, so same-turn precedence is not contested. The routing is a hard trigger
rather than an indefinite deferral: before any production-reachable policy-side
promise supplied to `joinRuntimeDefinitionAndPolicy` can reject — including
through a deny-capable gateway, version-read failure, validator, normalizer,
adapter, or post-invocation wrapper — the owning packet must ship the subsuming
two-pending, policy-then-loader, exact-identity control first. The row fires on
policy-side rejectability, not only on authorization denial.

The source comment on `joinRuntimeDefinitionAndPolicy` is narrowed to the same
five measured classes and names the unproved routed case. Its prior statement
that an immediate loader rejection retained its original precedence claimed
more than the committed controls observed.

### Live composed-application observation

The re-scoped candidate was exercised with `pnpm dev` on application port 4174.
The default dev container held another lineage, so its first invocation refused
before listening with `the active pointer names a release outside this composed
application lineage`. Because other lanes were live, the shared default was not
reset. The replay used the resolver's supported isolated identity
`dev-composed-app-postgres-refusal` and database port 55434 while retaining the
chartered application port 4174. Its first cold-container connection reset is
the already-routed published-endpoint readiness class; a retry against the same
isolated container started successfully with 176 seeded records.

A real Item create was posted with the complete form contract except for its
required base unit. The provider refused the write and the returned complete
diagnostic was HTTP 422, `OPERATION_REFUSED`, sentence `Operation refused`,
detail `The provider refused this operation for a reason this application
cannot yet present in plain language.`, next action `Give the refusal code to an
administrator before trying this operation again.`, and subject
`MODULE_REQUIRED_FIELD_MISSING`. This is the same path that previously told the
operator only `Save unavailable`.

`pnpm --filter @north-star/api dev:stop` stopped the isolated database container
and, as chartered, left the Node listener on port 4174. `ss` resolved PID 19056;
it was killed explicitly and the port was confirmed clear. The exact isolated
container and its test-only volume were then removed with `dev:reset`; that
ephemeral data is not recoverable and no shared dev container was touched.

The corrected runtime-evaluation tree repeated this observation with `pnpm dev`
on port 4174, the same isolated container name and database port, and 176 seeded
records. A headless browser read the real Item form's `FormData`, supplied SKU
and name, removed only the base-unit value, and posted through the live server.
The response was HTTP 422 with role `blocked`, code `OPERATION_REFUSED`, subject
`MODULE_REQUIRED_FIELD_MISSING`, and the complete code-bearing residual copy
above. `dev:stop` again left the listener (PID 72119); it was explicitly killed,
port 4174 was confirmed clear, and `dev:reset` removed only the isolated
container and `dev-composed-app-postgres-refusal-data` volume.

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

### First runtime-translation review — `e8e2e014c7e3502f9bd2ae230fc2b151eb756959`

Fresh Codex xhigh returned `REVISE`. The provider-neutral architecture passed:
production web code imported only the runtime seam, the unchanged no-provider
architecture boundary remained intact, and all 15 real provider refusals
crossed runtime translation and HTTP with their code. Six corrections remained:

1. the `async` loader helper turned a synchronous loader throw into a rejected
   promise, so current policy was called when the base implementation would
   have stopped before it; immediate rejection precedence could change too;
2. the structural classifier had no one-property controls for a non-`Error`,
   wrong name, absent code, non-string code, or unknown string code, and the
   loader-only claim lacked an unaffected provider-shaped policy twin;
3. only provider-minus-runtime union drift had a recorded red, although the
   equality construction has two authored directions;
4. the slot-local contract and browser journey exercised `activity` but not
   the equally named `childTables` invariant;
5. ADR-0054's new amendment inherited the accepted status of the original
   decision before this packet was accepted; and
6. the active current-plan row still classified the correction Behavioral
   while this packet and its operator-truth consequence are Critical.

The production correction keeps the original loader and policy promises rather
than wrapping the loader with another async promise. A two-input join attaches
handlers directly to those originals in `Promise.all` order and translates only
the loader rejection handler. A synchronous loader throw is translated before
policy is invoked; a synchronous policy throw still occurs before handlers are
attached; and already-rejected loader and policy promises retain loader-first
precedence. Committed controls cover those cases, all five classifier near
misses through exact-object identity and the generic HTTP fallback, and
provider-shaped policy and unit-of-work failures outside translation.

The contract and real browser write journey now each enumerate `activity` and
`childTables`. The inverse type-drift red is recorded separately above. The ADR
amendment is explicitly proposed pending packet acceptance, and the active-plan
row is Critical. No `packages/postgres-provider/**` byte changed and the runtime
seam design remains unchanged.

### Second runtime-translation review — `347685c570ed3c9fe9cf875e649698333006cbf7`

Fresh Codex xhigh returned `REVISE` with no production or architecture finding.
The corrected runtime join preserves the base evaluation and settlement
semantics, the five structural near misses are discriminating, both vocabulary
drift directions fail typecheck, and both unsupported non-mutation slots remain
locally failed without vetoing a write.

Three evidence gaps remained. The committed controls did not execute a
synchronous policy throw after an already-rejected loader, either first pending
rejection while its sibling remained unresolved, or an asynchronously rejected
unit of work. Consequently, a deferred policy invocation, an `allSettled` join
that waited for both inputs before preferring the loader, and a catch around the
awaited unit-of-work result were cheap broken implementations that remained
green. The packet's statement that all original ordering cases were committed
therefore exceeded its measurements.

The correction is test- and record-only. Controlled promises now reject policy
and loader first in separate specimens, keep the sibling pending across an
event-loop turn, and require the adapter result to have settled before releasing
that sibling. A synchronous policy specimen starts from an already-rejected
loader and requires the exact raw policy error. The asynchronous unit-of-work
twin requires exact object identity at the adapter and the generic unavailable
diagnostic through a loopback HTTP server. Production remains byte-identical to
`fa4139e96fec14602bdafa1e7aa0dab043e50273`.

### Third runtime-translation review — `29ef493c6554d8c9f2d5c94493d737eeb5e18900`

Fresh Codex xhigh returned `REVISE` with no production or architecture finding.
It closed synchronous policy evaluation, held-sibling no-wait settlement,
asynchronous unit-of-work identity and HTTP classification, the recorded mutant
attribution, and record accuracy. One ordinary survivor remained: a
post-invocation `.then(...)` wrapper on the policy promise preserved all 29
controls while allowing a loader rejection to overtake a policy rejection issued
first in the same resumed turn.

The lane reproduced that exact survivor at 29/29 and did not add a sixth timing
specimen. This is the same control class for a third evidence-only round while
production remains unchanged; the previous correction added cases beside the
existing timing cases rather than subsuming promise ordering. Under
`review-tiers`, no convergence criterion licenses another adjacent case. The one
narrowing round therefore writes the claim from the measurements, records the
ad-hoc survivor, routes same-turn staggered precedence to its own row, and stops.

### Superseded trigger wording — `c86dede458ea8199d4056719937e7fcadb5059b4`

The orchestrator ruled `runtime-refusal-same-turn-precedence` non-gating for this
packet because every current production wiring returns fixed successful policy
version evidence. This first recording keyed that fact too narrowly to whether a
production `CurrentPolicyGateway` was deny-capable. The review of `5c9e1cb`
correctly distinguished authorization denial from rejection of the
`readCurrentVersion()` promise actually supplied to the join; the corrected
trigger below supersedes the denial-based wording.

The source comment was still correctly narrowed to the five committed timing
classes and named the unproved routed case. Runtime behavior remained unchanged
from `fa4139e96fec14602bdafa1e7aa0dab043e50273`; the only runtime-source
difference was that comment. The trigger remains a plan-level admission
obligation, not an executable detector of new policy-side rejectability.

The correction tree passed:

- `pnpm format`: green;
- `pnpm typecheck`: green;
- `pnpm lint`: green; and
- `pnpm --filter @north-star/web test:contracts`: 29/29 green.

No browser, integration, architecture or full-matrix suite was rerun for this
comment-and-record-only correction. The full matrix remains deferred until the
fresh Critical arms converge.

### Fourth narrow review — `5c9e1cb02554a44a5c4126057ad5bc4497e0f314`

Fresh Codex xhigh returned `REVISE` with no present production or architecture
finding. It confirmed that the composed request path, release verification and
demo wiring all return fixed successful policy-version evidence, that the five
source-comment observations match committed controls, and that the routed row's
denial-based wording was non-deferrable for the event it named.

One material claim defect remained: `AuthenticatedRequestRuntimeEntryAdapter`
joins `readCurrentVersion()`, not `authorize()`. A validator, normalizer, adapter
or post-invocation wrapper can make that policy-side promise reject while the
gateway remains allow-only, making the recorded same-turn survivor reachable
before row 7 without firing the denial-based trigger. The correction therefore
keys the obligation to the load-bearing predicate: the subsuming control must
ship before any production-reachable policy-side promise supplied to the join
can reject, regardless of which layer introduces that rejectability. Production
logic and the routed-control scope remain unchanged.
