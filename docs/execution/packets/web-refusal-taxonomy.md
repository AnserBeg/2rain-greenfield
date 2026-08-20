# web-refusal-taxonomy — truthful web-boundary refusals and slot-local failure

Date: 2026-08-20

Base: `8136cfaa8caf23a73221cfa2b0feb5c90987556b`

Branch: `packet/web-refusal-taxonomy`

Tier: Critical

Status: frozen for fresh Critical review after round 1 corrections

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

All mutants were applied to the otherwise passing working tree, run, and
immediately reverted.

| Claim | One-property mutant | Observed red |
|---|---|---|
| A non-mutation slot cannot veto writes | Restored `surfaceHasUnsupportedComponent(surface) ||` in `surfaceSupportsRuntimeIntent` | `test:contracts` 17/18; `closed registry returns diagnostics for unknown and failing components` received `false` where writable was required |
| An identified provider refusal does not collapse to unavailable | Replaced the open-code residual return with `OPERATION_UNAVAILABLE` | `test:contracts` 17/18; expected `OPERATION_REFUSED` plus `MODULE_REQUIRED_FIELD_MISSING`, received `OPERATION_UNAVAILABLE` |
| The mapper helper preserves its exact typed code | Replaced `subject: error.code` with one erased constant | `test:contracts` 17/18; first table member expected `ACTIVE_POINTER_MISSING`, received `ERASED_RUNTIME_VIEW_CODE`. Round 1 correctly ruled this a helper-level proxy, not HTTP-boundary evidence; it is retained as historical evidence but does not count for the boundary claim. |
| The typed runtime-view table is exhaustive | Deleted only `ACTIVE_POINTER_MISSING` from the 15-code record | `typecheck` exit 2, TS1360: required property `ACTIVE_POINTER_MISSING` is missing |
| Invalid binding remains distinct from unsupported query | Changed only the invalid-binding render code back to `QUERY_UNSUPPORTED` | focused browser control 0/1; complete observable expected `INVALID_SURFACE_BINDING`, received `QUERY_UNSUPPORTED` |
| No fixture-only Save is synthesized | Restored only the conditional compatibility Save branch | focused browser control 0/1; expected zero Save buttons, received one |
| Every typed code traverses the HTTP catch-and-render boundary | Narrowed only the `RequestRuntimeViewLoadError` catch to `UNSUPPORTED_RUNTIME_CAPABILITY`, the one existing browser census member | `test:contracts` 18/19; the first non-browser member, `ACTIVE_POINTER_MISSING`, rendered `REQUEST_RUNTIME_VIEW_UNAVAILABLE` where the HTTP census required `REQUEST_RUNTIME_VIEW_REFUSED` |
| Only the refusal class crosses the app-server provider boundary | Added only `PostgresRequestRuntimeViewService` as a second named specifier on the allowed import | `test:contracts` 18/19; `renderer accepts one issued view and has no ambient release access` failed with `only RequestRuntimeViewLoadError may cross the app-server provider boundary` |

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
- `pnpm test:contracts`: 18/18 green at round 1 and 19/19 green after the
  corrected HTTP-boundary and exact-import controls landed.

The full CI matrix is deliberately deferred until review converges, as the
packet charter requires.

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
