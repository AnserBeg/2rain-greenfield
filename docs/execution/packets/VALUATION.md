# VALUATION — derived moving average, shipment cost and landed cost

Status: active — resumed by the owner. Slice 1 CI green; slice 2 implemented, validation in progress. Slice 3 awaits slice 2 CI. [Draft PR #12](https://github.com/AnserBeg/2rain-greenfield/pull/12) open; no integration or deployment.
Critical paths touched: none. Review: not owed — outside the Critical set.
Base: `681f4675` on `packet/VALUATION`, stacked on `packet/PAYABLES`.

## Claims

1. A registered canonical read capability computes item/company/currency moving averages from posted quantity movements and immutable actual receipt costs; there is no monetary storage or posting change.
2. Unknown inflows remain unvalued; each currency relieves proportionately at the effective-time average, exact rational arithmetic rounds only for display, and compensations invert original effects.
3. Complete transfers preserve company value; missing lineage, malformed paging and incomplete transfers refuse; negative coverage or residual value without covered quantity withholds monetary figures.
4. The Inventory value List and item page use compiled metadata and shared runtimes; every input is read through declared plain queries under current company and permission authority; a denied item cost read refuses, while document cost/margin are explicitly withheld without suppressing authorized document facts.

5. Posted shipment-line relief includes original-effect corrections; orders sum it and show shipped product margin; live partial invoices take proportional net-shipment coverage, withholding excess/unknown/foreign-currency margin. Internal figures stay off the customer invoice print.

## Decisions

- Owner rulings are recorded in ADR-0067: derived moving average, unvalued quantities, no FX, separate currencies, landed cost after payables; it amends the plan's reserved valuation seam and ADR-0017, retaining quantity-only movements and the accounting exclusion.
- Inventory value lives beside Items in Catalog because the existing canonical grammar keeps a surface, query and source entity in one module; one item/company row labels each currency's independent figures.
- Known value is labelled as such; unknown stock never receives the PO or selling price, and no cross-currency total is claimed. Existing selling prices remain visible beside item costs; the fixture deliberately uses a PO estimate of 99 against actual costs of 5 and 15.
- Costed document queries retain dedicated plain stored gets for release admission; existing public document query identities and links remain valid.
- Shared item storage remains tenant-level; valuation adds a company query operand for its company-owned dependencies, without adding a column or changing identity.

## Slices

1. Item cost, Inventory value and item facts: [checkpoint](VALUATION-test-it-yourself.md#1-stock-value).
2. Shipment relief, order/invoice cost and read-only margin: [checkpoint](VALUATION-test-it-yourself.md#2-shipment-cost-and-margin), CI pending.
3. Bill charges allocated by actual billed receipt value: pending slice 2 CI.

## Controls

None owed: no Critical-set path changes.

## Gates

- Focused moving-average/shipment/invoice unit cases 9/9; scoped/paged/current-policy and shipment lineage integration 4/4; web metadata/print contracts 2/2; release freshness `--check` PASS.
- Compiled from the PAYABLES base envelope: one added lineage entry (6 total), 102 surfaces, 17 navigation destinations, 573 verification scenarios; coverage re-derived: 2654 obligations / 811 observed, unchanged.
- Local typecheck, lint and formatting PASS after merging `681f4675`; focused unit/workspace/surface grammar 44/44, compiler/integration/web contracts 237/237, List 6/6, numbering PostgreSQL 2/2, item contract 1/1 and suite inventory 1/1 pass. Stored-row oracle and valuation browser passed locally and in hosted CI.
- Slice 1 full CI [36801057149](https://github.com/AnserBeg/2rain-greenfield/actions/runs/36801057149) green at `45b03f7f62103c5824b099c16dd4a2409de991a3`, all ten jobs including reachability. Slice 2 CI [36841431777](https://github.com/AnserBeg/2rain-greenfield/actions/runs/36841431777) passed quality/security/performance but refused release admission because costing replaced the only plain shipment/invoice gets. Canonical stored gets and a compiled-artifact contract correct this; refreshed full CI pending.
- Slice 2 local typecheck, lint, format and surface grammar (25/25) PASS. Its independent stored-row oracle and browser journey are registered for hosted PostgreSQL/operations jobs. The earlier local PostgreSQL attempt exited 75 before launch because the lock stayed busy; Docker is now unavailable in WSL, so those gates run in hosted CI. Standalone coverage check lacks a reachability run token; the full CI run supplies it. No readiness bound or timeout changed.
- Small bridges: PAYABLES numbering and composed navigation inventories measured from compilation; fixtures that remove Inventory also remove composed Catalog cost reads; navigation/composed counts are pinned to the compiled output, and the new unit/PostgreSQL files enter the suite inventories.

## Test it yourself

[VALUATION-test-it-yourself.md](VALUATION-test-it-yourself.md); isolated fixture, two known receipts and explicitly unvalued opening stock; under ten minutes.

## Filed

- Each dependency is a separately authorized read; a concurrent history change can cause a refused/incomplete read. This is an operational derived view, not a posting snapshot or financial ledger.

```record-claim
{
  "schemaVersion": "northstar.record-claim/v1",
  "packet": "VALUATION",
  "base": "681f46751b2a4c3cc9027956534b741c35dd4a03",
  "head": "1a0f73c0c93f6aa5df2d0eaaa65e3ab89e6feeee",
  "changedPaths": [
    "apps/web/release/app.authored.json",
    "apps/web/release/app.compiled.json",
    "apps/web/test/browser/composed-application.spec.ts",
    "apps/web/test/browser/inventory-valuation.spec.ts",
    "apps/web/test/surface-runtime-contract.test.ts",
    "package.json",
    "packages/compiler/src/conformance.ts",
    "packages/domain/src/app/builder.ts",
    "packages/domain/src/app/list-declarations.ts",
    "packages/domain/src/app/order-entry.ts",
    "packages/domain/src/inventory/contracts.ts",
    "packages/domain/src/inventory/valuation.ts",
    "packages/postgres-provider/src/composed-application-runtime.ts",
    "packages/postgres-provider/src/inventory-shipment-cost.ts",
    "packages/postgres-provider/src/inventory-valuation-read-model.ts",
    "packages/postgres-provider/src/inventory-valuation.ts",
    "test/architecture/repository-hygiene.test.ts",
    "test/architecture/surface-grammar-conformance.test.ts",
    "test/compiler/inventory-contract.release.golden.json",
    "test/helpers/inventory-valuation-fixture.ts",
    "test/helpers/order-entry-fixture.ts",
    "test/helpers/reachability-producers.ts",
    "test/helpers/without-inventory-valuation.ts",
    "test/integration/surface-data-binding.test.ts",
    "test/postgres/composed-application.test.ts",
    "test/postgres/inventory-valuation.test.ts",
    "test/postgres/module-storage-transition.test.ts",
    "test/unit/canonical-model/surface-list.test.ts",
    "test/unit/inventory-valuation.test.ts"
  ],
  "symbols": [
    {
      "path": "packages/postgres-provider/src/inventory-valuation.ts",
      "name": "replayInventoryValue"
    },
    {
      "path": "packages/postgres-provider/src/inventory-valuation-read-model.ts",
      "name": "inventoryValuationReadModel"
    },
    {
      "path": "packages/domain/src/inventory/valuation.ts",
      "name": "valuationQueries"
    },
    {
      "path": "packages/postgres-provider/src/inventory-shipment-cost.ts",
      "name": "deriveShipmentCosts"
    }
  ]
}
```
