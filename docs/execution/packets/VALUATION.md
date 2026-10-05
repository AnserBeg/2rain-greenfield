# VALUATION — derived moving average, shipment cost and landed cost

Status: evidence_ready — all three slices implemented and full CI green. [Draft PR #12](https://github.com/AnserBeg/2rain-greenfield/pull/12) open; no integration or deployment.
Critical paths touched: none. Review: not owed — outside the Critical set.
Base: `681f4675` on `packet/VALUATION`, stacked on `packet/PAYABLES`.

## Claims

1. A registered canonical read capability computes item/company/currency moving averages from posted quantity movements and immutable actual receipt costs; there is no monetary storage or posting change.
2. Unknown inflows remain unvalued; each currency relieves proportionately at the effective-time average, exact rational arithmetic rounds only for display, and compensations invert original effects.
3. Complete transfers preserve company value; missing lineage, malformed paging and incomplete transfers refuse; negative coverage or residual value without covered quantity withholds monetary figures.
4. The Inventory value List and item page use compiled metadata and shared runtimes; every input is read through declared plain queries under current company and permission authority; a denied item cost read refuses, while document cost/margin are explicitly withheld without suppressing authorized document facts.

5. Posted shipment-line relief includes original-effect corrections; orders sum it and show shipped product margin; live partial invoices take proportional net-shipment coverage, withholding excess/unknown/foreign-currency margin. Internal figures stay off the customer invoice print.

6. Live vendor bill freight and fees allocate by actual billed receipt value; exact shares re-derive stock and shipment cost. Missing/foreign/zero allocation bases withhold money and state landed coverage; zero-charge bills still consume quantity provenance.

## Decisions

- Owner rulings are recorded in ADR-0067: derived moving average, unvalued quantities, no FX, separate currencies, landed cost after payables; it amends the plan's reserved valuation seam and ADR-0017, retaining quantity-only movements and the accounting exclusion.
- Inventory value lives beside Items in Catalog because the existing canonical grammar keeps a surface, query and source entity in one module; one item/company row labels each currency's independent figures.
- Known value is labelled as such; unknown stock never receives the PO or selling price, and no cross-currency total is claimed. Existing selling prices remain visible beside item costs; the fixture deliberately uses a PO estimate of 99 against actual costs of 5 and 15.
- Original shipment/invoice gets remain plain for release admission and its named probes; separate valuation gets serve documents using the existing company URL operands.
- Replay groups native transfer source lines by their shared origin before `:in`/`:out`, requiring opposite signed sides; the unit fixture now matches retained kernel facts.
- Bill quantities match net receipt portions by PO-line lineage; receipt compensations retain exactly the surviving allocation. Taxes, payments and credits do not become landed product cost.
- Shared item storage remains tenant-level; valuation adds a company query operand for its company-owned dependencies, without adding a column or changing identity.

## Slices

1. Item cost, Inventory value and item facts: [checkpoint](VALUATION-test-it-yourself.md#1-stock-value).
2. Shipment relief, order/invoice cost and read-only margin: [checkpoint](VALUATION-test-it-yourself.md#2-shipment-cost-and-margin).
3. Bill charges allocated by actual billed receipt value: [checkpoint](VALUATION-test-it-yourself.md#3-vendor-landed-cost).

## Controls

None owed: no Critical-set path changes.

## Gates

- Local slice 3 unit cases 12/12, declared-lineage/current-policy integration 3/3, compiled web contracts 2/2, surface grammar 25/25, typecheck, lint, format and release freshness `--check` PASS.
- Independent stored-row PostgreSQL landed-cost oracle 1/1 PASS under the exclusive lock. Focused browser journey 1/1 PASS with one worker; its reporter correctly rejects filtered execution as full-suite reachability evidence. Full CI supplies unfiltered evidence. Both local fixture containers were removed.
- Compiled from PAYABLES `681f4675`: one added lineage entry (6 total), 102 surfaces, 17 destinations, 573 scenarios, 10 numbered fields / 10 uniqueness probes. Coverage re-derived: 2654 obligations / 811 observed. No storage was added.
- Slice 1 full CI [36801057149](https://github.com/AnserBeg/2rain-greenfield/actions/runs/36801057149) green at `45b03f7f62103c5824b099c16dd4a2409de991a3`; slice 2 [37256436112](https://github.com/AnserBeg/2rain-greenfield/actions/runs/37256436112) green at `ea3898d6b0660ccb196a7e820f00ba81ec762c9b`; slice 3 [37258437674](https://github.com/AnserBeg/2rain-greenfield/actions/runs/37258437674) green at `c1f08c739d78fc61a5800bdbeeac35e97e0553f8`. All ten jobs passed per slice, including reachability, before subsequent slice work.
- Earlier slice 2 runs exposed admission dependencies on original plain get IDs and a stale display-query assertion; both corrected. One performance run was indeterminate at 74.2% CPU idle versus required 90%, then passed with no bound change. Earlier local attempts lacked Docker or exited 75 on a busy lock; Docker recovered and the exclusive-lock gates ran. No timeout, readiness or performance bound changed.
- `scripts/check-records.sh` PASS; no Critical arm or expected-red control owed. Program-review triggers evaluated: this unintegrated draft meets the anti-trigger; none launched.
- Small bridges: PAYABLES numbering and composed navigation inventories measured from compilation; fixtures that remove Inventory also remove composed Catalog cost reads; navigation/composed counts are pinned to the compiled output, and the new unit/PostgreSQL files enter the suite inventories.

## Test it yourself

[VALUATION-test-it-yourself.md](VALUATION-test-it-yourself.md); isolated fixtures for stock value, shipment cost and vendor charges; under ten minutes per slice.

## Filed

- Each dependency is a separately authorized read; a concurrent history change can cause a refused/incomplete read. This is an operational derived view, not a posting snapshot or financial ledger.

```record-claim
{
  "schemaVersion": "northstar.record-claim/v1",
  "packet": "VALUATION",
  "base": "681f46751b2a4c3cc9027956534b741c35dd4a03",
  "head": "2b6ab6ea8179caded5f87b2171e1e26df6ff499c",
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
    "packages/postgres-provider/src/inventory-landed-cost.ts",
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
    },
    {
      "path": "packages/postgres-provider/src/inventory-landed-cost.ts",
      "name": "allocateLandedCharges"
    }
  ]
}
```
