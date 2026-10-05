# SALES-EXTRAS — credit limits and hold, price lists, and counter sales, through metadata

Status: slices 1 (credit), 2 (price lists) and 3 (counter sales) executable on draft PR #25 (stacked on #11 `packet/PAYABLES`), CI green at `302000f7`; no merge, no deployment. Sole BUILD under the owner's standing instruction (take the recommended choice, record it, report).
Tier: outside the Critical set — the receivables capability (settlement executor), the commercial read model, Party, Catalog and Sales metadata, the editor and composition runtimes, the compiler's surface floor and legal-entity family map; no posting-kernel, migration, grant, RLS, verification or trust change. Shipping posts through the existing fulfillment route; a counter sale adds no posting path.
Base: `packet/PAYABLES` at `96ac2341`. Reference: PaneFlow `d057daff` (`partners.credit_limit_cents`/`credit_hold`, `price_lists`/`price_list_assignments`/`price_list_entries`, `lib/server/pricing.ts`, the counter flow of `app/inventory-app.tsx`); its Helcim counter checkout is excluded by the charter.

## Rulings (recommended choice taken)

- SE-A exposure = open and partially paid invoice balances + confirmed (released) orders' totals not yet on a live invoice (never below zero), in the order's currency only, across every company of the tenant (a customer is tenant-wide); no FX.
- SE-B the limit is money in the customer's own currency (its default currency, set with the limit); an order in another currency is refused by name (CREDIT_CURRENCY_MISMATCH), as PaneFlow does. Empty or 0 sets no limit.
- SE-C refusals by name: CREDIT_HOLD, CREDIT_LIMIT_EXCEEDED (with the excess), CREDIT_CURRENCY_MISMATCH, CREDIT_EXPOSURE_UNSTATED (a figure that cannot be stated is never counted as zero), RECEIVABLES_ORDER_NOT_CONFIRMABLE.
- SE-D a manager override is not built (it needs approvals): filed.
- SE-E a line takes the largest break at or below its quantity (1 while none is typed) from the highest-priority active list assigned to the customer, in the order's currency, that has one for its item (PaneFlow's order); equal breaks take the lower price; else the item's list price. No per-unit entries (UNITS is its own packet). The price follows a quantity, customer or currency change only while it is not typed by hand.
- SE-F a counter sale is an ordinary sales order with a counter flag, so every List and report shows it; its Task ships every line in full from one location and records payment as cash, cheque or other (no provider).
- SE-G the composed application's advancement and ADR-0047 rollback-edge parents run on the full-replay generator's 1 GB data volume: at lineage entry 7 their installs filled the default 256 MB (sqlstate 53100), as RETURNS' did at entry 6. No assertion, timeout or readiness bound changed.

## Claims

1. Party (behind `salesMasterData`) has an optional credit limit (exact decimal) and an optional "On credit hold"; the customer page sets the limit with its currency and holds or releases the customer through the governed Party update.
2. Confirm (`sales_order_release`) is the receivables capability's, keeping its id, permission, label, declared precondition and immediate answer; it re-checks the draft state and the complete ship-to and, under a transaction lock on the customer taken before the order row, refuses per SE-B/SE-C, so two confirmations of one customer cannot both fit under the same headroom.
3. The commercial read model states the customer's credit limit, open balance, confirmed-not-invoiced total, available credit and status on the order page (order currency) and the customer page (`party_credit_get`, the customer's currency), read company by company under current policy; a withheld read states none of it.
4. Catalog (behind `sellingPrices`) declares `price_list` (code, name, currency, priority, status), `price_list_entry` (item, minimum quantity, unit price) and `price_list_assignment` (customer), the children owned by the list; the price list page adds and removes prices and customers and activates or deactivates the list.
5. An editor default or derived value may declare `tiers` (optional v6 key, surface floor 15): ranked tables a header party is assigned to, matched by header or fixed values, and their owned rows for the reference's selection at or below a row quantity; `pick: 'table'` states the table, named through its get. The validator refuses an unowned or unassigned table, a match or rank outside the tables, a non-decimal quantity, a value the field cannot hold, and a default that picks its table.
6. The sales line's unit price (default), list price and price list (derived) read the customer's price lists (SE-E); a customer, currency or quantity change re-prices a line still at its automatic price; a typed price stays and reads "Manual price"; a line at its list's price reads "Price list", with the list's code.
7. A sales order has an optional "Counter sale" flag, shown on its page and as the Sales orders List's "Counter sales" tab. A draft offers "Counter sale: take payment" (ship from, paid by, reference) and "Counter sale: on account" (ship from): one confirmed plan of the order's own operations — mark the flag, Confirm (credit checked as for any order), per line create and reserve a reservation of its ordered quantity at that location, one shipment (carrier "Counter", the order's ship-to) with a line per order line from that line's own reservation, post it, create and post the invoice and, when paid, create and post a payment of the invoice's whole balance.
8. A Task holds up to twelve steps (was five), and a per-row step may read an earlier per-row step's read-back of its own row; a once-only step still never reads a per-row read-back. Either raises the surface floor to 15; the runtime keeps each row's read-backs apart.
9. The distributor seed adds the walk-in customer "Counter (walk-in)" (`P-COUNTER`, CAD, due on receipt, default ship-to "Store counter").

## Decisions

- Confirm moved to the receivables capability as Reopen did (ruling F): it is the one reader of the customer's invoices and orders under a lock. The state machine's transition stays; the capability writes it.
- Credit figures read through Party: test fixtures that strip Sales drop a read model whose dependencies are gone (`dropDanglingReadModels`).
- Price lists live in Catalog behind `sellingPrices` (beside item prices and tax codes); their families are tenant-shared, their children cross-entity-allowed, in both the compiler's and the inventory contract's maps (golden re-derived).
- The price list currency is an enumeration matched to the order's text currency by its label; the editor matches enumerations by label for every tiered match.
- The flat navigation fixture of the grammar test drops Location: with price lists Party, Catalog and Location reach six setup Lists, past the flat budget, which groups them (the product's own navigation is grouped).
- A counter sale's steps commit one by one, as every Task's do: a refused step (Confirm on hold, a line short at the location) stops the Task with the earlier steps kept and Retry replaying the same request keys; a refused Confirm leaves a draft marked as a counter sale.
- The policy bindings for price lists sit before Stock count's, so the policy-unbound-refusal manifest's victim (the application package's last binding) is unchanged.

## Slices

1. Credit `69f53c68`, CI fixes `201b9c8e`. 2. Price lists `c65a767f`, CI fixes `2d4ed685`, `c2fdb077`. 3. Counter sales `6ce112fe`, snapshot and spec fixes `eda36e1d`, `302000f7`.

## Gates

- Slice 1 (`201b9c8e`): CI green, every job (run 37299296518), the operations browser credit spec and the commercial `customer-credit` test included; snapshot from evidence run 37295762374. Locally: unit 204/204, compiler 175/175, web contracts 35/35, agent 3/3, architecture subset 102/103 (the matrix-lock timing test under load), coverage 2654 obligations, 811 -> 813 observed.
- Slice 2 (`c65a767f`): pins from a compile — surfaces 101 -> 110, navigation 16 -> 17, surface floor 14 -> 15, verification scenarios 575 -> 610 (executed 498 -> 533), Sales fields 98 -> 99; coverage 2654 -> 2716 obligations, 813 -> 837 observed; release entry 7 `--check` PASS. CI run 37304604236: the commercial `price-lists` test and the operations browser `price-list-pricing` spec green; red only on test-side pins, fixed in `2d4ed685` (snapshot from evidence run 37304604106; Catalog's navigation leaf; the policy manifest's victim kept) and `c2fdb077` (the supported floor 15; the Sales partition 29 + 17; SE-G).
- Slice 3 (`6ce112fe`): locally unit 210/210, compiler 175/175, web contracts 35/35, agent 3/3, grammar and hygiene 36/36 (each half of floor 15 holds it alone; a control dropping the counter condition reds 15 -> 14, restored from a copy), integration 240/242 then its two pins fixed (tab counts 2 x 8; the counter flag seeded) 4/4, PostgreSQL `counter-sale` 1/1 (real PostgreSQL), operations browser `receivables-counter-sale` 1/1 at `302000f7`; release entry 8 `--check` PASS; coverage unchanged (2716/837); static expected-red OK (162). Pins: scenarios 610 -> 611 (executed 533 -> 534), sales_order 29 -> 30, the Sales partition 46 -> 47, Sales fields 99 -> 100, Sales orders List views 6 -> 7; surfaces, navigation and floor unchanged. Snapshot from evidence run 37310789373 (one boolean column and its UPDATE grant).
- Head `302000f7` (slices 1-3): CI green, every job (run 37312203740) — quality, schema and isolation, composed application, commercial workflows (`customer-credit`, `price-lists`, `counter-sale`), the main, composed and operations browser runners (`receivables-credit`, `price-list-pricing`, `receivables-counter-sale`), the compiler budget, scans, observability and executed-file reachability; the regenerated snapshot is identical (evidence run 37312203706). `c2fdb077`'s own run was cancelled by the slice 3 push; its fixes are in that green head.

## Test it yourself

`SALES-EXTRAS-test-it-yourself.md`.

## Filed

- SE-D the manager override of a credit refusal (needs approvals). Reopen of a closed order adds its uninvoiced part to exposure without a check. A paid-now counter sale is credit-checked at Confirm, before its payment.
- A counter sale ships every line in full from one location; a partial or split counter sale is the order page's own Reserve and Ship Tasks. A paid counter sale of a zero total has nothing to pay: its payment step is refused after the invoice posts (use "on account").
- The surface floor 15 may collide with a parallel packet's; whichever lands second takes 16. Each order page reads the customer's credit company by company (one read per confirmed order): measure a large customer.

```record-claim
{
  "schemaVersion": "northstar.record-claim/v1",
  "packet": "SALES-EXTRAS",
  "base": "96ac234122322b2cbe18349299664f56c8f5190a",
  "head": "302000f79863087089d5aab9bed0ca925448dbc1",
  "changedPaths": [
    "apps/web/playwright.shared.ts", "apps/web/release/app.authored.json", "apps/web/release/app.compiled.json",
    "apps/web/release/current-policy-bindings.json", "apps/web/src/document-editor.ts", "apps/web/src/editor-controls.ts",
    "apps/web/src/surface-composition.ts", "apps/web/src/workspace-entry.ts", "apps/web/test/browser/composed-application.spec.ts",
    "apps/web/test/browser/customer-defaults.spec.ts", "apps/web/test/browser/price-list-pricing.spec.ts", "apps/web/test/browser/receivables-counter-sale.spec.ts",
    "apps/web/test/browser/receivables-credit.spec.ts", "package.json", "packages/canonical-model/src/schemas.ts",
    "packages/canonical-model/src/surface-composition.ts", "packages/canonical-model/src/surface-workspace.ts", "packages/compiler/src/conformance.ts",
    "packages/compiler/src/projections.ts", "packages/domain/src/app/builder.ts", "packages/domain/src/app/list-declarations.ts",
    "packages/domain/src/app/order-entry.ts", "packages/domain/src/app/seed.ts", "packages/domain/src/catalog/definition.ts",
    "packages/domain/src/catalog/workspace.ts", "packages/domain/src/inventory/contracts.ts", "packages/domain/src/party/definition.ts",
    "packages/domain/src/party/workspace.ts", "packages/domain/src/sales/definition.ts", "packages/domain/src/sales/workspace.ts",
    "packages/postgres-provider/src/commercial-amounts.ts", "packages/postgres-provider/src/commercial-read-model.ts", "packages/postgres-provider/src/credit-read-model.ts",
    "packages/postgres-provider/src/inventory-posting-error.ts", "packages/postgres-provider/src/receivables-capability-executor.ts", "packages/postgres-provider/src/settlement-capability-executor.ts",
    "packages/runtime/src/request-runtime-view.ts", "test/architecture/repository-hygiene.test.ts", "test/architecture/surface-grammar-conformance.test.ts",
    "test/compiler/g2-module-conformance.test.ts", "test/compiler/inventory-contract.release.golden.json", "test/fixtures/g2/language-conformance/coverage-decisions.json",
    "test/helpers/drop-dangling-read-models.ts", "test/helpers/order-entry-fixture.ts", "test/helpers/reachability-producers.ts",
    "test/integration/surface-data-binding.test.ts", "test/postgres/composed-application.test.ts", "test/postgres/counter-sale.test.ts",
    "test/postgres/customer-credit.test.ts", "test/postgres/declared-list.test.ts", "test/postgres/fresh-tenant-full-replay-schema.snapshot.json",
    "test/postgres/module-storage-transition.test.ts", "test/postgres/order-lists.test.ts", "test/postgres/price-lists.test.ts",
    "test/postgres/request-runtime-view.test.ts", "test/unit/canonical-model/surface-composition.test.ts", "test/unit/catalog-definition.test.ts",
    "test/unit/commercial-amounts.test.ts", "test/unit/party-definition.test.ts", "test/unit/sales-definition.test.ts",
    "test/unit/workspace-contract.test.ts"
  ],
  "symbols": [
    {"path": "packages/postgres-provider/src/settlement-capability-executor.ts", "name": "settlementCapabilityExecutorFactory"},
    {"path": "packages/postgres-provider/src/commercial-amounts.ts", "name": "creditPosition"},
    {"path": "packages/postgres-provider/src/commercial-amounts.ts", "name": "orderTotalCents"},
    {"path": "packages/postgres-provider/src/credit-read-model.ts", "name": "readCreditPosition"},
    {"path": "packages/domain/src/catalog/workspace.ts", "name": "priceListWorkspace"},
    {"path": "apps/web/src/workspace-entry.ts", "name": "workspaceRestricted"},
    {"path": "packages/canonical-model/src/surface-composition.ts", "name": "validateSurfaceCompositions"},
    {"path": "apps/web/src/surface-composition.ts", "name": "displayFieldValue"}
  ]
}
```

Review: not owed — outside the Critical set.
