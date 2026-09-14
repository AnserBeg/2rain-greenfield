# RAIN-META-SALES — metadata-composed fulfillment workspace

Status: active; implementation checkpoint, validation continuing. Stops taken: 1, resolved.
Owner: sole local BUILD; independent review online only; no local review, merge or deployment.
Base: `fe97b63baedf8bdd42146318bb89d4be1aa948f6`; branch: `packet/RAIN-META-SALES`.
Draft PR: https://github.com/AnserBeg/2rain-greenfield/pull/5
Worktree: `/home/rvham/2rain-greenfield-rain-meta-sales`.
Reference: `AnserBeg/temp_inventory@d057daffd17a199309675a6b0a31c8bdbca05282`.
Reference checkout has local edits; source inspection used `git show` at the pin only.

## Charter

Outcome: open a released stocked order; read customer/item/location labels and line
progress; reserve 8 of stock 10, ship 5, release 3, and open complete packing.
Slices: metadata-rendered order/lines; contextual fulfillment tasks; parity and usability.
Owned paths: canonical-model/compiler/domain/runtime/provider, web runtime/release,
affected tests/inventories and execution records. Existing posting kernel remains authoritative.
Gates: focused tests, generators, affected suites including PostgreSQL, real-gateway
fixture, two compiled presentation variants, renamed-ID reuse and browser checks.
No receiving redevelopment, whole-order authoring, pricing, finance or integrations.
Live customization and actual AI execution remain the next milestone before ERP expansion.

## Claims under validation

1. v6 canonical composition declares fields, exact child queries, contextual inputs and operation steps; shared SurfaceRuntime renders it without Sales dispatch.
2. Registered fulfillment read models use declared policy-governed dependency queries, exact relation/field restrictions and existing persisted projections; UI performs no stock arithmetic.
3. Tasks invoke existing operations through current authorization, confirmation, revision checks and idempotency; retries retain per-step inputs/keys and stop on withheld read-back.
4. Historical releases reproduce; new composition/read-model output has capability floors; two metadata revisions and a renamed non-Sales fixture share the same runtime.
5. Browser and agent-channel acceptance evidence is in progress; no completed browser, AI-model execution or full-matrix claim yet.

## Decisions

- User approved the bounded versioned composition recommendation on 2026-09-14: “yes go ahead with recomendation”. This resolves the only decision stop.
- Carrier: v6 `surfaceComposition`; existing five archetypes; each child binding resolves independently; failure suppresses that binding's rows and dependent actions.
- Surface payload v2 / runtime capability 4; query read-model capability 2. Historical envelope readers remain strict.
- The v6 physical dispatch retains v5 scalar-default representation: a language stamp alone must not request a storage retype. No database reset or lineage deletion.
- Task plans are bounded sequential registered operations, not an atomic transaction. Earlier drafts may persist after refusal; they remain visible.
- Task tokens are bound to principal/environment/tenant/release and held in memory for one hour measured monotonically. Process loss requires inspecting the record before a new task.
- Read-model summaries are gateway-authorized reads, not a claimed cross-query transaction snapshot; posting rechecks authoritative stock.
- Reference only: PaneFlow connected order actions, readable selections, explicit effect preview and responsive controls. No quarry code copied.

## Slices and evidence

- Order/lines: isolated real PostgreSQL demo showed Alpine Office Supply and Field notebook, with exact child scope and quantity progress.
- Actions: manual reserve observed 10/8/2. Browser subsequently observed ship 5/3/2 and release 5/0/5; final compact packing navigation timed out and is being corrected.
- First shipment probe exposed missing reason narrative; accepted posting refused with `INVENTORY_ADJUSTMENT_REASON_REQUIRED`. Mapping fixed; later browser shipment committed.
- Renamed non-Sales composition and two compiled presentation revisions: focused integration tests pass, including missing scope-receipt and invalid-binding controls.
- No local reviewer or whole-program review ran. This is an implementation checkpoint, not a stage boundary.

## Gates

- Historical lineage generation passed; typecheck/lint and affected suites are being completed.
- Browser `meta-sales.spec.ts`: current run pending; previous run timed out after stock assertions, before complete packing.
- Hosted CI: pending publication of implementation checkpoint. Full acceptance is not claimed.

## Test it yourself

From `/home/rvham/2rain-greenfield-rain-meta-sales` in Ubuntu/WSL:

```sh
corepack pnpm install --offline --frozen-lockfile
node scripts/run-with-test-lock.mjs shared -- node --import tsx test/helpers/meta-sales-fixture.ts --serve
```

Open the printed `META_SALES_URL`. The fixture owns a new disposable container; Ctrl-C
closes only that fixture. Existing worktrees, databases and demos are preserved.
Select the order line, Reserve stock, quantity 8, Calgary warehouse, Review, Confirm.
Return to the order: on hand/reserved/available = 10/8/2.
Select its reservation; Ship reserved stock, quantity 5, Review, Confirm; return: 5/3/2.
Release remainder, Review, Confirm; return: 5/0/5. Select the posted shipment and Open packing.
Packing must show its location and every exact shipment line; Back returns to the same order.
Repeat at 390 px. No customer/item/location/line identifier must be typed or pasted.

## Review handoff

Publication remains one draft PR. Final SHA, complete gates and bounded online review
prompt will replace this checkpoint after the outstanding checks are complete.

```record-claim
{
  "schemaVersion": "northstar.record-claim/v1",
  "packet": "RAIN-META-SALES",
  "base": "fe97b63baedf8bdd42146318bb89d4be1aa948f6",
  "head": "67f6109e4ed56fc814be9a2cefd7bbd069e163c7",
  "changedPaths": [
    "apps/web/release/app.authored.json",
    "apps/web/release/app.compiled.json",
    "apps/web/src/component-registry.ts",
    "apps/web/src/message-catalog.ts",
    "apps/web/src/surface-composition.ts",
    "apps/web/src/surface-contract.ts",
    "apps/web/src/surface-runtime.ts",
    "apps/web/test/browser/meta-sales.spec.ts",
    "packages/canonical-model/src/constants.ts",
    "packages/canonical-model/src/index.ts",
    "packages/canonical-model/src/normalize.ts",
    "packages/canonical-model/src/schemas.ts",
    "packages/canonical-model/src/surface-composition.ts",
    "packages/compiler/src/compiler.ts",
    "packages/compiler/src/projections.ts",
    "packages/compiler/src/protocol.ts",
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
    "test/helpers/meta-sales-fixture.ts",
    "test/integration/surface-data-binding.test.ts"
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
