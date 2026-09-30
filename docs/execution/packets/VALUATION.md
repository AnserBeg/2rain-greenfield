# VALUATION — derived moving average, shipment cost and landed cost

Status: unfinished — stopped by the owner. Slice 1 implemented; selected local checks passed, latest lint red. No push, PR, merge or deploy.
Critical paths touched: none. Review: not owed — outside the Critical set.
Base: `fe32bc04` on `packet/VALUATION`, stacked on `packet/PAYABLES`.

## Claims

1. A registered canonical read capability computes item/company/currency moving averages from posted quantity movements and immutable actual receipt costs; there is no monetary storage or posting change.
2. Unknown inflows remain unvalued; each currency relieves proportionately at the effective-time average, exact rational arithmetic rounds only for display, and compensations invert original effects.
3. Complete transfers preserve company value; missing lineage, malformed paging and incomplete transfers refuse; negative cost coverage withholds monetary figures.
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

- Focused moving-average unit cases 5/5; scoped/paged/current-policy integration 1/1; release freshness `--check` PASS.
- Compiled from the PAYABLES base envelope: one added lineage entry (6 total), 102 surfaces, 17 navigation destinations, 573 verification scenarios; coverage re-derived: 2654 obligations / 811 observed, unchanged.
- Typecheck and formatting PASS; latest lint fails on two unused destructured variables in `test/helpers/without-inventory-valuation.ts` (not fixed before the stop); broader unit/compiler/integration/web contracts 257/257; PostgreSQL stored-row oracle 1/1; operations browser 1/1 (one worker, ~2 min); architecture 71 checks with one fixture drift corrected, surface grammar recheck 25/25. Hosted CI was never started.
- Small bridges: fixtures that remove Inventory also remove composed Catalog cost reads; navigation/composed counts are pinned to the compiled output, and the new unit/PostgreSQL files enter the suite inventories.

## Test it yourself

[VALUATION-test-it-yourself.md](VALUATION-test-it-yourself.md); isolated fixture, two known receipts and explicitly unvalued opening stock; under ten minutes.

## Filed

- Each dependency is a separately authorized read; a concurrent history change can cause a refused/incomplete read. This is an operational derived view, not a posting snapshot or financial ledger.
