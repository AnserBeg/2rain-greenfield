# VALUATION — derived moving average, shipment cost and landed cost

Status: active — resumed by the owner. Slice 1 implemented; checks refreshed after merging the PAYABLES dependency. Slices 2–3 await slice 1 CI. [Draft PR #12](https://github.com/AnserBeg/2rain-greenfield/pull/12) open; no integration or deployment.
Critical paths touched: none. Review: not owed — outside the Critical set.
Base: `a3b104db` on `packet/VALUATION`, stacked on `packet/PAYABLES`.

## Claims

1. A registered canonical read capability computes item/company/currency moving averages from posted quantity movements and immutable actual receipt costs; there is no monetary storage or posting change.
2. Unknown inflows remain unvalued; each currency relieves proportionately at the effective-time average, exact rational arithmetic rounds only for display, and compensations invert original effects.
3. Complete transfers preserve company value; missing lineage, malformed paging and incomplete transfers refuse; negative coverage or residual value without covered quantity withholds monetary figures.
4. The Inventory value List and item page use compiled metadata and shared runtimes; every input is read through declared plain queries under current company and permission authority; a denied cost read refuses rather than returning zero.

## Decisions

- Owner rulings are recorded in ADR-0067: derived moving average, unvalued quantities, no FX, separate currencies, landed cost after payables; it amends the plan's reserved valuation seam and ADR-0017, retaining quantity-only movements and the accounting exclusion.
- Inventory value lives beside Items in Catalog because the existing canonical grammar keeps a surface, query and source entity in one module; one item/company row labels each currency's independent figures.
- Known value is labelled as such; unknown stock never receives the PO or selling price, and no cross-currency total is claimed.
- Shared item storage remains tenant-level; valuation adds a company query operand for its company-owned dependencies, without adding a column or changing identity.

## Slices

1. Item cost, Inventory value and item facts: [checkpoint](VALUATION-test-it-yourself.md#1-stock-value).
2. Shipment relief, order/invoice cost and read-only margin: pending slice 1 CI.
3. Bill charges allocated by actual billed receipt value: pending slice 2 CI.

## Controls

None owed: no Critical-set path changes.

## Gates

- Focused moving-average unit cases 6/6; scoped/paged/current-policy integration 1/1; release freshness `--check` PASS.
- Compiled from the PAYABLES base envelope: one added lineage entry (6 total), 102 surfaces, 17 navigation destinations, 573 verification scenarios; coverage re-derived: 2654 obligations / 811 observed, unchanged.
- Lint, typecheck and formatting PASS after the dependency merge; focused unit/workspace/surface grammar 44/44; broader unit/compiler/integration/web contracts 257/257; PostgreSQL stored-row oracle 1/1; operations browser 1/1 (one worker, ~2 min); architecture 71 checks with one fixture drift corrected, surface grammar recheck 25/25. First CI [36783423844](https://github.com/AnserBeg/2rain-greenfield/actions/runs/36783423844): quality 208/209, PostgreSQL 224/225, operations browser 30/31; three stale inventories corrected (Lists, PAYABLES numbering, navigation). New stored-row oracle and valuation browser passed; composed replay, commercial PostgreSQL, standard browser, performance and security green. Local List 6/6, numbering 2/2, refreshed compiler/integration/web contracts 237/237; navigation browser queued under the exclusive lock. Full green matrix remains pending.
- Small bridges: PAYABLES numbering and composed navigation inventories measured from compilation; fixtures that remove Inventory also remove composed Catalog cost reads; navigation/composed counts are pinned to the compiled output, and the new unit/PostgreSQL files enter the suite inventories.

## Test it yourself

[VALUATION-test-it-yourself.md](VALUATION-test-it-yourself.md); isolated fixture, two known receipts and explicitly unvalued opening stock; under ten minutes.

## Filed

- Each dependency is a separately authorized read; a concurrent history change can cause a refused/incomplete read. This is an operational derived view, not a posting snapshot or financial ledger.

```record-claim
{
  "schemaVersion": "northstar.record-claim/v1",
  "packet": "VALUATION",
  "base": "a3b104db44b58382db48ad67687ec159d8c31bba",
  "head": "75cb4a9da46988294eb39fc91e178fe1694e54ae",
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
    "test/postgres/document-numbering.test.ts",
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
    }
  ]
}
```
