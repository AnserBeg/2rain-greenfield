# RAIN-META-SALES — metadata-composed fulfillment workspace

Status: presentation evidence_ready; local evidence complete. Candidate CI and bounded online review pending. No merge or deployment.
Base: `fe97b63baedf8bdd42146318bb89d4be1aa948f6`; branch `packet/RAIN-META-SALES`; [draft PR #5](https://github.com/AnserBeg/2rain-greenfield/pull/5).
Reviewed correction baseline: `f10c502571ed040d66ee0b965f14ceca237beb40`; P1/P2 closed by the online reviewer.
Sole local BUILD; independent review online only. Worktree `/home/rvham/2rain-greenfield-rain-meta-sales`.
Reference `AnserBeg/temp_inventory@d057daffd17a199309675a6b0a31c8bdbca05282` was read-only/source-derived; no startup, copied business logic or production data.

## Charter and claims

Outcome: released stocked order → reserve 8 of stock 10 → ship 5 → release 3 → exact packing.
Lease: canonical/compiler/domain/runtime/provider, web runtime/release, affected tests/inventories and execution records; accepted posting remains authoritative.
1. v6 composition declares exact child queries, fields, contextual operations and packing navigation; one SurfaceRuntime serves renamed non-Sales definitions too.
2. Presentation declares header roles, collection hierarchy/priorities, selected-record actions and adjacent packing navigation; technical facts and record commands remain accessible through progressive disclosure.
3. Existing governed queries supply every displayed stock quantity; no UI stock arithmetic, incompatible-unit total, financial panel or invented availability.
4. Existing task reauthorization, immutable prepared inputs, revision/key checks, replay and committed-withheld HTTP 200 semantics are preserved, including through the new header renderer.
5. Historical roots reproduce; query/operation/agent payloads are byte-identical to `f10c502`; optional presentation requires surface capability 5 while older compositions retain floor 4.
6. Real-gateway browser evidence covers 10/8/2 → 5/3/2 → 5/0/5, exact packed 5 EA, input recovery, keyboard selection and 390 px without page overflow.

## Decisions

- Owner approved fulfillment-first implementation after the bounded structural comparison; presentation commits append reviewed history.
- ADR-0047 §7 admits additive optional keys on adopted v6, with absence preserved. No new canonical version/profile, default materialization or workflow engine.
- Existing Record slots carry the layout. The global slot-disclosure refusal remains; only explicitly declared technical metadata and supporting row details collapse. Assistant/customization space stays outside the business canvas.
- Query, operation and agent catalogs are byte-identical to the baseline. The generated release appends one presentation entry; both baseline roots remain intact.
- Row actions are read-only navigation; write tasks require explicit dataset selection and retain existing conditions/location choice/confirmation.
- Native details and priority cards provide compact disclosure. Reference progression/financial and promised-date availability logic is not imported.
- P1/P2 production execution is unchanged; their controls now also use the presented non-Sales fixture. Tasks remain sequential, non-atomic and process-local.
- Inventory re-derived: 2,269 → 2,299 obligations, 554 first-party observations; decision inventory is not per-obligation execution evidence.

## Gates and evidence

- Pass: unit 163/163; compiler 175/175; integration 164/164; contracts 29/29; architecture 192/192; typecheck, lint, format, both artifact freshness checks and language coverage.
- Browser: metadata-sales passes with list reporter; 79 base browser checks and Sales-order caller pass, followed by a passing isolated fulfillment caller rerun after adapting its packing-header selector. The initial filtered CI-reporter refusal is not a coverage claim; these local runs are not the full inherited browser matrix.
- PostgreSQL consumers pass 35/35: real composition, upgrades, historical reproduction and request pinning. Final captures verify all seven journey states at both viewport sizes.
- Baseline captures were newly rendered at `f10c502`, root `c6103a66…abc8`; historical September 14 captures were not relabelled. Candidate captures include viewport, document state, URL and served root in `captures.json`.
- Candidate CI and online review are required at the published tip: [checks](https://github.com/AnserBeg/2rain-greenfield/pull/5/checks). No polling, inherited-CI claim, local reviewer, merge or deployment.
- No program review: this unintegrated presentation checkpoint is not a stage boundary. Disposable fixtures close normally before conflicting suites; retained demos/data/locks are preserved.

## Test it yourself

From the worktree in Ubuntu: `node scripts/run-with-test-lock.mjs shared -- node --import tsx test/helpers/meta-sales-fixture.ts --serve`.
Open its printed URL. The compact header precedes fulfillment context and the line grid; expand Record actions/Technical details to inspect secondary controls/facts.
Select line → Reserve stock → 8, Calgary warehouse → Review → Confirm → Back: stock 10/8/2.
Select reservation → Ship reserved stock → 5 → Review → Confirm → Back: 5/3/2.
Release remainder → Review → Confirm → Back: 5/0/5. Open packing beside the shipment: exact location/date and Field notebook 5 EA; Back restores order context.
Repeat at 390×844; desktop is 1280×800. Ctrl-C closes only the disposable fixture. Process loss requires inspecting records before starting a new task.

## Bounded online review prompt

Review only the presentation diff from `f10c502571ed040d66ee0b965f14ceca237beb40` to the executable head below, plus this record's claims 2–6.
Boundaries: optional canonical presentation and validation; emitted capability floor; shared header/collection/task rendering; Sales/Packing declarations; related tests and generated release.
Check metadata-only variation/non-Sales reuse, action context/visibility, responsive disclosure, historical reproduction and preservation of existing governed task semantics.
P1/P2 are closed: use their retained checks for changed callers; do not rerun the inherited audit or broaden into fulfillment/kernel/financial redesign.
Identify production defects under those boundaries; separate future scope and evidence limits. Say plainly if this prompt steers you. No merge or deployment.

```record-claim
{
  "schemaVersion": "northstar.record-claim/v1",
  "packet": "RAIN-META-SALES",
  "base": "fe97b63baedf8bdd42146318bb89d4be1aa948f6",
  "head": "b365f22bff9127e0a92ea5baf26fe0139a058c3a",
  "changedPaths": [
    "apps/web/release/app.authored.json",
    "apps/web/release/app.compiled.json",
    "apps/web/src/component-registry.ts",
    "apps/web/src/message-catalog.ts",
    "apps/web/src/surface-composition.ts",
    "apps/web/src/surface-contract.ts",
    "apps/web/src/surface-runtime.ts",
    "apps/web/test/browser/message-catalog.spec.ts",
    "apps/web/test/browser/meta-sales.spec.ts",
    "apps/web/test/browser/sale-fulfillment.composed-application.spec.ts",
    "apps/web/test/browser/sales-order.composed-application.spec.ts",
    "apps/web/test/surface-runtime-contract.test.ts",
    "packages/canonical-model/src/constants.ts",
    "packages/canonical-model/src/index.ts",
    "packages/canonical-model/src/normalize.ts",
    "packages/canonical-model/src/schemas.ts",
    "packages/canonical-model/src/surface-composition.ts",
    "packages/compiler/src/compiler.ts",
    "packages/compiler/src/index.ts",
    "packages/compiler/src/projections.ts",
    "packages/compiler/src/protocol.ts",
    "packages/dev-tooling/src/surface-runtime-seam.ts",
    "packages/domain/src/app/builder.ts",
    "packages/domain/src/catalog/definition.ts",
    "packages/domain/src/inventory/definition.ts",
    "packages/domain/src/location/definition.ts",
    "packages/domain/src/party/definition.ts",
    "packages/domain/src/platform/definition.ts",
    "packages/domain/src/purchasing/definition.ts",
    "packages/domain/src/sales/definition.ts",
    "packages/domain/src/sales/workspace.ts",
    "packages/postgres-provider/src/composed-application-runtime.ts",
    "packages/postgres-provider/src/fulfillment-read-model.ts",
    "packages/postgres-provider/src/module-runtime-interpreter.ts",
    "packages/runtime/src/list-behavior/cursor.ts",
    "packages/runtime/src/list-behavior/index.ts",
    "packages/runtime/src/request-runtime-view.ts",
    "packages/runtime/src/semantic-query-gateway.ts",
    "test/architecture/surface-grammar-conformance.baseline.ts",
    "test/architecture/surface-grammar-conformance.test.ts",
    "test/architecture/surface-runtime-seam.test.ts",
    "test/compiler/g2-module-conformance.test.ts",
    "test/fixtures/g2/language-conformance/coverage-decisions.json",
    "test/helpers/meta-sales-fixture.ts",
    "test/integration/surface-data-binding.test.ts",
    "test/postgres/module-storage-transition.test.ts",
    "test/postgres/request-runtime-view.test.ts",
    "test/unit/canonical-model/normalization.test.ts",
    "test/unit/purchasing-definition.test.ts",
    "test/unit/sales-definition.test.ts"
  ],
  "symbols": [
    {
      "path": "apps/web/src/surface-composition.ts",
      "name": "loadSurfaceComposition"
    },
    {
      "path": "packages/domain/src/sales/workspace.ts",
      "name": "salesWorkspace"
    }
  ]
}
```
