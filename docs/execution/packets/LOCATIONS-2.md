# LOCATIONS-2 — governed location changes and warehouse scope (blocked checkpoint)

Status: blocked draft checkpoint, branch `packet/LOCATIONS-2`, based on LOCATIONS `be722966`.
Review: not owed — changes must stay outside AGENTS.md section 4. Draft PR only; no merge or deployment.

## Design before implementation

1. Declare a per-operation writable-field contract. Generic location create/update exclude status, reason and changed-at; a dedicated Change status update requires all three and a nonblank reason. The same compiled contract governs agents, integrations and Tasks.
2. Permit an explicitly declared List column to label a relation through its authorized target query; the Location List shows the containing warehouse without copying its name into a field.
3. Opt a declared relation into update inputs and an acyclic constraint. The module interpreter serializes mutations of that tenant/environment/relation graph, then checks the proposed parent's ancestors in the write transaction before changing the edge. Existing relation contracts retain their create-only default; amend ADR-0052 for this opt-in.
4. Declare a List warehouse selector and hierarchy scope. Its authorized choice is request state; Stock by item's and Buying's location-based stock figures traverse location containment, while Incoming and open demand remain company-wide. The Location List uses the same scope to show the selected warehouse and its descendants. No selected warehouse supplies a mutation operand.
5. Add a transfer-routing runtime capability over ordinary transfer documents. Within one warehouse Post remains one transfer; across warehouses dispatch posts into an active source-warehouse in-transit location and retains the intended destination for Receive transfer, which posts a second ordinary transfer. Both legs use the existing posting route; retries must return the same documents and effects. If existing kernel contracts cannot support this, stop only this slice and record its separate Critical prerequisite.
6. Extend reference Task defaults with a declared lookup through selected rows: Receive into wins, otherwise the item's preferred location is offered and remains editable. A multi-line Task defaults only when all included rows resolve the same preferred location; differing or absent preferences require an explicit choice.

## Rulings

- L-A and ADR-0069 stand: status and bins are location attributes; stock dimensions and ledger identities do not change.
- L-C stands: the kernel's quarantine reserve/ship refusal remains deferred.
- L-2A: relation updates are explicit opt-in; serialized ancestor checks refuse self-parenting and indirect/concurrent cycles.
- L-2B: moving a location changes its warehouse membership, including existing stock, without changing quantities or restating movements.
- L-2C: warehouse scope includes the selected root and descendants; incoming and demand remain company-wide because orders carry no warehouse.
- L-2D: inter-warehouse dispatch needs a source-warehouse location with both in-transit type and status; no location is silently invented.
- L-2E: receiving prefers the order's Receive into, then a common item preference; conflicting preferences are never guessed.
- Optional v6 surface extensions will reserve runtime surface floor 22; parallel floors 20 and 21 are not reused.

## Claims authored (PostgreSQL/browser execution pending)

1. Only the dedicated status update accepts status, reason and changed-at; each is required, and a whitespace-only reason is refused. Generic create/update cannot write them.
2. A List relation label finds the containing warehouse through authorized live ancestors; the Location List adds it without copying names.
3. Explicit relation updates serialize their graph before ancestor checking and the source revision lock; self, indirect and competing cycles are refused. Moving a bin reclassifies existing stock without restating movements.
4. Declared hierarchy scope applies before figures/count/page/export and binds cursors and executor echoes. Stock and Buying scope location-based stock; incoming and demand stay company-wide; Location scopes rows.
5. Reference Task defaults use current governed reads: order Receive into, then the selected/common item preference. Missing, denied or conflicting preferences remain blank and editable.

## Slices

1. Status gateway fix and ancestor warehouse labels — authored; unit/integration gates pass; real installation blocked by the Critical verifier.
2. Cycle-checked relation updates and warehouse scopes — authored; web contracts pass; registered PostgreSQL and operations browser witnesses await CI.
3. Preferred receiving defaults — authored; single and multi-line integration gates pass. Inter-warehouse dispatch/Receive transfer remains designed, not implemented; installation is blocked before beginning its storage slice.

## Critical prerequisite and limits

`LOCATIONS-2-VERIFICATION.md` splits the status verifier change into a separate Critical packet, with three bounded claims, one proposed expected-red control per claim and an OWNER review prompt. Current enum probes choose the first generic update; search exclusions read create-input sentinels. Neither can verify these Task-only fields. The status probes remain planned: none is removed, skipped or given a fabricated bypass. No Critical file is changed here.
The transfer kernel was not found incapable of two ordinary transfers; its workflow is pending, not a claimed kernel refusal. L-C remains deferred. This checkpoint is not acceptance or a completed packet.

## Gates

- Local: typecheck; changed-path prettier and eslint; changed-file unit 37/37; surface grammar architecture 25/25; web contracts 42/42; suite-registration witness 1/1; LOCATIONS integration 2/2; single receiving and multi-line receiving integration witnesses pass.
- Release: rebuilt entry 9 from LOCATIONS' eight-entry base, `--check` PASS. Measured surfaces 103, navigation leaves 18, floor 22, planned verification 584 (77 derived obligations / 507 execution obligations), numbered fields and uniqueness probes 11. Existing count and navigation pins remain unchanged; runtime-floor pins use 22.
- Coverage re-derived from the composed and platform definitions: 2782 obligations, 927 observed; all decision digests re-derived. Declaration inventory, not per-obligation execution evidence.
- Physical storage columns/relations are unchanged; the storage projection adds the location query/operation consumer roots. Schema snapshot was not regenerated locally; request GitHub evidence with `regen-snapshot`.
- Registered `test/postgres/locations-2.test.ts` in the main PostgreSQL suite: independent stored parent/movement oracle, scope/move totals, cycle race and status write refusals. Operations browser: `inventory-locations-2.spec.ts`. Neither ran locally; no container or browser was started. Full CI and executed-file evidence are pending and expected to expose the Critical verification dependency.
- The full repository-hygiene file initially found a registration sort mismatch (fixed, witness green) and a matrix-harness probe refused another lane's running container; that environment result remains red locally, with no threshold or harness change.
- No expected-red mutation was run; no `run-controls` label is owed by this non-Critical diff. The prerequisite's prospective controls belong to its own packet.

## Test it yourself

[LOCATIONS-2-test-it-yourself.md](LOCATIONS-2-test-it-yourself.md): status, warehouse labels/scopes, moving a nested bin and preferred receiving; runnable after the Critical prerequisite lands. Transfer receipt is explicitly pending.

## Review

Not owed — LOCATIONS-2 changes stay outside the Critical set. No stage boundary or stabilized new correctness domain is claimed; no program review is run against this blocked working checkpoint.

## Docker pause checkpoint — 2026-10-05

Implementation saved at `574a93a95cb6e307b44d9a06386460ccf7d232e4`; branch is unpublished, no PR or CI run started. No lane-owned container, dev server or test process remains. No expected-red mutation needs restoration.
Resume here only: finish record-claim and frozen-manifest checks, then push a draft against `packet/LOCATIONS` with `regen-snapshot`. The Critical verification prerequisite remains required; inter-warehouse Receive transfer is still pending. Do not rerun local PostgreSQL/browser work while Docker is paused.

```record-claim
{
  "schemaVersion": "northstar.record-claim/v1",
  "packet": "LOCATIONS-2",
  "base": "be722966960ee3a4acde76b0474dc4ef9ac05755",
  "head": "574a93a95cb6e307b44d9a06386460ccf7d232e4",
  "changedPaths": [
    "apps/web/release/app.authored.json", "apps/web/release/app.compiled.json",
    "apps/web/src/component-registry.ts", "apps/web/src/list-declaration.ts",
    "apps/web/src/surface-composition.ts", "apps/web/src/surface-contract.ts",
    "apps/web/src/surface-runtime.ts", "apps/web/test/browser/inventory-locations-2.spec.ts",
    "apps/web/test/surface-runtime-contract.test.ts", "packages/canonical-model/src/normalize.ts",
    "packages/canonical-model/src/operation-writes.ts", "packages/canonical-model/src/schemas.ts",
    "packages/canonical-model/src/surface-composition.ts", "packages/canonical-model/src/surface-list.ts",
    "packages/compiler/src/projections.ts", "packages/domain/src/app/builder.ts",
    "packages/domain/src/app/list-declarations.ts", "packages/domain/src/location/definition.ts",
    "packages/domain/src/location/workspace.ts", "packages/domain/src/purchasing/workspace.ts",
    "packages/postgres-provider/src/module-runtime-interpreter.ts", "packages/runtime/src/list-behavior/cursor.ts",
    "packages/runtime/src/list-behavior/hierarchy.ts", "packages/runtime/src/list-behavior/index.ts",
    "packages/runtime/src/request-runtime-view.ts", "packages/runtime/src/semantic-operation-gateway.ts",
    "packages/runtime/src/semantic-query-gateway.ts", "test/architecture/repository-hygiene.test.ts",
    "test/architecture/surface-grammar-conformance.test.ts", "test/fixtures/g2/language-conformance/coverage-decisions.json",
    "test/helpers/order-entry-fixture.ts", "test/integration/surface-data-binding.test.ts",
    "test/postgres/locations-2.test.ts", "test/postgres/request-runtime-view.test.ts",
    "test/unit/canonical-model/surface-list.test.ts", "test/unit/location-definition.test.ts",
    "test/unit/workspace-contract.test.ts"
  ],
  "symbols": [
    {"path": "packages/canonical-model/src/operation-writes.ts", "name": "validateOperationWrites"},
    {"path": "packages/runtime/src/list-behavior/hierarchy.ts", "name": "parseSharedListHierarchy"},
    {"path": "packages/postgres-provider/src/module-runtime-interpreter.ts", "name": "enforceRelationUpdateGraph"},
    {"path": "packages/postgres-provider/src/module-runtime-interpreter.ts", "name": "listHierarchyPlan"},
    {"path": "apps/web/src/surface-composition.ts", "name": "referenceDefault"}
  ]
}
```
