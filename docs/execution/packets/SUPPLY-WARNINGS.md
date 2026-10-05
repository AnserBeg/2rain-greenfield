# SUPPLY-WARNINGS — the Sales orders List says which orders wait for supply, which hold reserved stock to ship, and what each is short

Status: executable on draft PR #26 against `packet/LOCATIONS` (stacked on #22 <- #16 <- #13 <- #11 <- #10 <- #8 <- #7); no merge, no deployment. ORDER-PARITY increment C. Sole LOCAL BUILD under the owner's standing instruction (take the recommended choice, record it, report it).
Tier: outside the Critical set — a canonical List key, the compiler's surface floor and agent presets, the shared List contract, gateway and list statement, the web runtime and domain metadata; no posting-kernel, serializer, materializer, activation, verification, trust, migration or RLS change. Admission to reserve or ship stays in the kernel.
Base: `packet/LOCATIONS` at `be722966`. Reference: PaneFlow `d057daff` (`lib/server/inventory-domain.ts` `salesWorklistFilter`, `salesBlockedSupply`; `lib/domain/sales-availability.ts`); design `design-sales-purchasing-leftovers.md` §1, §2, §3, §9, §10.

## Owner rulings (the recommended choice taken)

- R1: shortage = per order and item, open quantity less the line's own reservations, against free stock now (usable on hand less what reservations hold at usable locations, LOCATIONS), allocated in line order; incoming purchase orders are not counted. One formula for the row, the tab and the page banner.
- S-A: the supply is supplementary, as ORDER-PARITY's progress is (`whenDenied: 'omit'`): a principal without the stock reads keeps the List, its progress and its other tabs.
- S-B: "Post shipment" only links to the order page's Fulfillment section, where its ship Task is; nothing is started from the List.

## Claims

1. `surface.list.progress.supply` (optional v6 key): `coverage` (rows pointing at a progress line through a relation, holding what their related rows hold — a line's reservations and their balances), `item` (the lines' text field naming what a line asks for), `free` (`plus` and `minus` figure sums over rows holding the item's id, with `within` and `related` as List figures have them), `shortIn` (the states shortage is stated in), `outputs` (`covered`, `short`), `whenDenied`. A view's `supply` and a row action's `when.supply` keep rows with something covered or short.
2. The list statement computes the supply in one LATERAL beside the progress, before the count, the page and the export: per active line, open = quantity less its active done rows, coverage = its covering rows' related totals; `covered` = Σ min(coverage, open⁺); `short` (in `shortIn` states, else 0) = Σ per item max(0, uncovered − max(0, free)), which is what allocating free stock in line order leaves short. Every joined row is pinned to tenant, environment, the listed row's company and the issued read scope; every column and relation comes from the pinned compiled storage.
3. The gateway authorizes every supply query under current policy per request for the List's company (`registeredSemanticListSupplyPolicyInput`), refuses a denial by that query's name, checks the item is a field the lines' query selects, and echoes and binds the supply in the cursor as part of the progress; the closed request contract is `list-behavior/supply.ts`.
4. Without a supply read the web runtime reads the List with its progress alone: Short reads "—", one line names what is withheld, the supply tabs refuse with `QUERY_PERMISSION_DENIED` and stay uncounted, the export leaves Short empty, and no row offers "Post shipment"; without the progress, neither is read.
5. Named refusals (`CANON_SCHEMA_INVALID`): supply queries that are not active q0 lists without a read model, company rows under a non-company List, coverage through the wrong relation, related rows not pointing at it, non-decimal or unselected quantities, an item that is not the lines' long-enough text field, a sum match that cannot hold an id, the wrong sum parts, a parent outside its rows, foreign or repeated short states, outputs that repeat or shadow, every view keeping supply when it is omitted, supply views or row-action conditions without a supply, a sortable or formatted supply column. Surface floor 21 (20 is CATALOG-EXTRAS', in parallel); the runtime supports 21; agent presets publish the supply and each view's `supply`.
6. Sales orders: tabs All, To ship, **Blocked by supply** (confirmed and short), **Reserved** (confirmed with reserved stock still to ship), Draft, Released, Closed, Cancelled; **Short** after Open, a positive Short marked "!"; row actions **Post shipment** (confirmed, something covered) → the order's Fulfillment section, then Fulfill, then View. The supply reads the very queries the order page's fulfillment read model reads, and states shortage in the states the page reads from the same list.

## Decisions

- Supply rides inside `progress` rather than beside it: it needs the progress lines and their done rows, and figures cannot be declared with progress.
- Free stock reuses the figures' sum grammar (`rows`, `within`, `related`); the figure planner and SQL builders are shared, unchanged in what they emit.
- Short per order is computed by item totals; the PostgreSQL test proves it equals the line-order allocation the page shows, line by line.
- Covered counts each line at most for what it has open, so "Reserved" means reserved stock still to ship (PaneFlow's "active reservation with quantity").
- The List shows Short but no reserved-quantity column: 11 of 12 columns; reserved work shows through the tab and "Post shipment".
- Blocked by supply keeps confirmed orders only (PaneFlow); "!" also marks a short draft, as its page's banner does.
- Tabs follow PaneFlow's order: Blocked by supply, then Reserved, after To ship.
- One list of shortage states (`SALES_SHORTAGE_STATES`, draft and confirmed) feeds both the order page's read model and the List's `shortIn`, so the two cannot judge different orders.

## Gates

- Local (no container; Windows free memory 1.0 GB, under the 1.2 GB bound): typecheck, prettier and eslint clean on every changed file; unit 218/218; compiler 175/175; web contract 40/40; architecture and agent (grammar, purity, seam, press law, UX, runtime-view boundary, surface data binding, hermeticity, activation and persistence boundaries, evidence, record fidelity, hygiene, reachability) 153/153; integration surface-data-binding 130/130.
- The executor's statement and the PostgreSQL test's independent oracle were run against a throwaway local PostgreSQL 16 holding just the tables they read (outside the test harness): the statement's covered and short equal the hand-worked scenario and the oracle's line-order allocation.
- Release: lineage entry 9 rebuilt from LOCATIONS' eight (39.6 -> 45.0 MB), `--check` PASS; storage target, query catalog and verification plan unchanged, so no schema snapshot and no scenario pins move.
- Pins from the compile: surface floor 19 -> 21 (grouped and runtime; the flat fixture holds no Sales List and stays 19).
- Coverage re-derived from LOCATIONS' document: 2725 -> 2774 obligations, 886 -> 921 observed, PASS.
- CI: pending on PR #26.

## Test it yourself

`SUPPLY-WARNINGS-test-it-yourself.md`.

## Deferred

- Incoming purchase orders in the shortage (R1: until purchase orders can be marked ordered).
- Refusing to ship from an unusable location in the kernel (LOCATIONS L-C, Critical): a reservation in quarantine still covers its line and offers "Post shipment".

## Filed

- Each supply tab's count computes free stock per order and item in a correlated subquery; on the distributor seed (about 1,300 orders) measure the Blocked by supply count.
- The surface floor 21 may meet CATALOG-EXTRAS' 20 on merge: whichever lands second keeps both lines in the floor chain.

```record-claim
{
  "schemaVersion": "northstar.record-claim/v1",
  "packet": "SUPPLY-WARNINGS",
  "base": "be722966960ee3a4acde76b0474dc4ef9ac05755",
  "head": "577d2c7f11181d16605f1cbb8cbcc13273897ca6",
  "changedPaths": [
    "apps/web/release/app.authored.json", "apps/web/release/app.compiled.json", "apps/web/src/component-registry.ts",
    "apps/web/src/list-declaration.ts", "apps/web/src/surface-runtime.ts", "apps/web/test/browser/declared-list.spec.ts",
    "apps/web/test/browser/order-lists-supply.spec.ts", "apps/web/test/browser/order-lists.spec.ts", "apps/web/test/surface-runtime-contract.test.ts",
    "package.json", "packages/canonical-model/src/index.ts", "packages/canonical-model/src/schemas.ts",
    "packages/canonical-model/src/surface-list.ts", "packages/compiler/src/projections.ts", "packages/domain/src/app/list-declarations.ts",
    "packages/domain/src/sales/workspace.ts", "packages/postgres-provider/src/fulfillment-read-model.ts", "packages/postgres-provider/src/module-runtime-interpreter.ts",
    "packages/runtime/src/list-behavior/figures.ts", "packages/runtime/src/list-behavior/index.ts", "packages/runtime/src/list-behavior/supply.ts",
    "packages/runtime/src/request-runtime-view.ts", "packages/runtime/src/semantic-query-gateway.ts", "test/architecture/repository-hygiene.test.ts",
    "test/architecture/surface-grammar-conformance.test.ts", "test/fixtures/g2/language-conformance/coverage-decisions.json", "test/helpers/order-entry-fixture.ts",
    "test/helpers/reachability-producers.ts", "test/integration/surface-data-binding.test.ts", "test/postgres/declared-list.test.ts",
    "test/postgres/order-lists-supply.test.ts", "test/postgres/order-lists.test.ts", "test/postgres/request-runtime-view.test.ts",
    "test/unit/canonical-model/surface-list.test.ts"
  ],
  "symbols": [
    {"path": "apps/web/src/component-registry.ts", "name": "withheldFiguresNote"},
    {"path": "apps/web/src/list-declaration.ts", "name": "shortMarked"},
    {"path": "apps/web/src/list-declaration.ts", "name": "viewNeedsSupply"},
    {"path": "apps/web/src/list-declaration.ts", "name": "withheldSupplyQuery"},
    {"path": "apps/web/src/surface-runtime.ts", "name": "withholding"},
    {"path": "packages/canonical-model/src/surface-list.ts", "name": "validateSurfaceLists"},
    {"path": "packages/compiler/src/projections.ts", "name": "agentSupply"},
    {"path": "packages/domain/src/app/list-declarations.ts", "name": "salesSupply"},
    {"path": "packages/domain/src/app/list-declarations.ts", "name": "lowerSupply"},
    {"path": "packages/domain/src/sales/workspace.ts", "name": "SALES_SHORTAGE_STATES"},
    {"path": "packages/postgres-provider/src/fulfillment-read-model.ts", "name": "fulfillmentReadModel"},
    {"path": "packages/postgres-provider/src/module-runtime-interpreter.ts", "name": "figurePartsPlanner"},
    {"path": "packages/postgres-provider/src/module-runtime-interpreter.ts", "name": "figureSumSql"},
    {"path": "packages/postgres-provider/src/module-runtime-interpreter.ts", "name": "listSupplyPlan"},
    {"path": "packages/postgres-provider/src/module-runtime-interpreter.ts", "name": "listSupplyFromSql"},
    {"path": "packages/runtime/src/list-behavior/supply.ts", "name": "parseSharedListSupply"},
    {"path": "packages/runtime/src/list-behavior/supply.ts", "name": "sharedListSupplyReads"},
    {"path": "packages/runtime/src/semantic-query-gateway.ts", "name": "authorizeSharedListProjection"}
  ]
}
```

Review: not owed — outside the Critical set.
