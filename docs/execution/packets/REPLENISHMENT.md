# REPLENISHMENT — reorder points, stock by item and a buying worklist

Status: executable on draft PR #16 against `packet/INVENTORY-PARITY` (stacked on #13 <- #11 <- #10 <- #8 <- #7); no merge, no deployment. Sole LOCAL BUILD under the owner's standing instruction (2026-09-30: "go with recommended choice"); the mechanism was written on S1 (`2e5de1d1`, never compiled) and finished here.
Tier: outside the Critical set — canonical grammar keys, the compiler's surface manifest and navigation, the shared List runtime and gateway, the module runtime interpreter's list statement, the web runtime and domain metadata; no posting-kernel, serializer, materializer, activation, verification, trust, migration or RLS change.
Base: `packet/INVENTORY-PARITY` at `e3da0a39` (merged at `14c8c74a` in `445d87ae`, then its release-verification round-5/6 fixes in `999804b8`). Reference: PaneFlow `d057daff` (`lib/server/reports.ts` `replenishmentWorklist`, the stock view's Shortage/Reorder/Healthy); design `design-replenishment.md`.

## Owner rulings (the recommended choice taken)

- Reorder point, reorder-up-to level and the worklist are pulled forward; levels are per item now, per location later.
- No value or cost column on the Lists (ADR-0017): Last supplier stands in.
- Projected = on hand + incoming − open demand, not available: open demand already holds the reserved units (PaneFlow `lib/server/reports.ts:175-177`); subtracting both double-counts.
- An item with no reorder point is never on the worklist; a missing Reorder up to leaves Suggested "—"; figures are unsortable.
- A denied figure query refuses the List by that query's name (no `whenDenied`): the figures are the Lists' purpose.
- PC: a purchase order line's Unit cost defaults from the item's standard cost in the order currency (`sourceByHeader`, as a sales line's price).
- Deferred, recorded: incoming/demand on the item page; the company % reorder rule; per-location reorder points.

## Claims

1. `surface.list.figures` (optional v6 key, beside progress): `sums` (1-8) add up rows of declared list queries that hold the listed record's id in a text field — `rows`, `related` rows pointing at them, or what `remains` of each row (never below zero) — optionally only where the rows' parent holds one of `within.values`; `totals` (≤6) sign figures declared before them and exact decimals the List selects, an unstated field leaving the total unstated, `floor: 'zero'` never below zero; `bands` (≤2) name a sum's or total's range, first case that holds; `latest` (≤2) is the record id the newest parent holds, labelled through an unscoped list query. A view's `band` keeps rows whose band holds one of its values.
2. The PostgreSQL list statement computes every figure in FROM (two LATERALs), so the count, the page, the cursor and the export read the same numbers and a kept band filters before count and page. Every joined row is pinned to the tenant, the environment and the issued read scope (the List's one company), a parent or related row also to its own row's company; every column and relation is resolved from the pinned compiled storage.
3. The gateway authorizes every figure query (rows, parent, related, label) under current policy per request, for the List's company (a label without one), refuses a denial by that query's name, requires the figures echoed, and binds them into the cursor; the request contract is closed (`list-behavior/figures.ts`).
4. `workspace.navigationModuleId` places a navigation List in another declared module's group (compiled into the tree only); `surface.form` lets a Record form choose a long-enough text field from an active unscoped q0 list query's records by label, stored as the id, the plain control kept when the list cannot be read whole.
5. Named refusals (`CANON_SCHEMA_INVALID`) for each misuse: unplanned or read-model figure queries, a match that cannot hold an id, non-decimal sums, the wrong parts or relations, foreign parent values, company rows under an unscoped List, totals over later figures or unselected fields, bands over non-numbers or with two thresholds, duplicate values or ids, latest by a non-date, scoped labels, progress and figures together, sortable or mis-roled figure columns, undeclared view bands, a misplaced navigation module, form references over an unread, short or non-text field, from a scoped or label-less list, twice, or off a Record form. Surface floor 17.
6. Catalog's `replenishment` option (the product only): Reorder point, Reorder up to, Preferred location and Standard cost CAD/USD/EUR on every item read; the item page shows them, the item form picks the location by name. Stock by item (On hand, Reserved, Available, Incoming, Open demand, Projected, Reorder point, Status; All, Shortage, Reorder) and the Buying worklist (Available … Reorder up to, Suggested, Last supplier; To buy) are Catalog Lists over clones of `item_list` with one company and an export limit, listed in Inventory, entered like Posted stock, read-only. The item page and form keep the Items List as their owner.

## Decisions

- The item Lists are worklists of `item_list` (`WORKLISTS` gains `inCompany`): cut only where every query their figures read is composed and the source selects every field they name; read-only (no bulk actions).
- Reserved reads `workspace_stock_reservations` with their balances; open demand reads `commercial_lines` (the line list carries the fulfillment read model, which figures may not read).
- The Inventory group lists leaves by surface id: Buying worklist and Stock by item follow Inventory transactions.
- The PO unit-cost default and the form reference apply only where the item's get selects the fields, so other compositions are unchanged.
- A record's own field holding another record's id (the preferred location) reads "—" when that record is gone (archived); a withheld read still fails the record's details, as a Task's context re-check requires (`surface-composition.ts`, a small bridge; dataset rows unchanged). The first, broader version also tolerated a withheld read and reddened "P1 task response rechecks … label reads"; narrowed in `6457222a`.

## Gates

- Merge `445d87ae` (3 conflicts: the floor chain and comment, the runtime's supported version, five postgres pins); mechanism compile fixes `fe116cfc` (two raw newlines in SQL template joins, branded-id keys); tsc, prettier and eslint clean on every changed file.
- Release `74d52afd`: lineage entry 7 rebuilt from INVENTORY-PARITY's six (28.9 -> 34.2 MB), `--check` PASS; demo release `--check` PASS.
- Pins from the compile: surface floor 16 -> 17 (grouped and runtime); flat grammar fixture 11 -> 17 (the item form's location choice); surfaces 101 -> 103; navigation leaves 16 -> 18 (Inventory 6 -> 8); verification 573 -> 579 scenarios (six item search exclusions), executed 496 -> 502, derived 77; numbered fields unchanged (11).
- Coverage re-derived from INVENTORY-PARITY's document: 2673 -> 2721 obligations, 831 -> 878 observed, PASS. Expected-red manifests: 158 entries in 13 still name live text.
- Full-replay schema snapshot regenerated under the lock (15m45s): exactly six nullable item columns.
- Local, one file at a time: unit (every file of the unit list) pass, surface-list + workspace-contract + catalog-definition 29/29; compiler and agent files pass; architecture (grammar, runtime seam, purity, UX, boundaries, reachability and the rest that need no container) pass; integration `surface-data-binding` whole file pass (REPLENISHMENT 2 tests, with negative controls for both bridges); web contract 39/39; the replenishment browser journey 1/1 (2.3m, under the shared lock).
- The generic Record form showed a stored decimal at scale 18 and re-sent it on save, which the write path refuses: every priced item's form refused every save. It now shows the canonical spelling, as the draft editor does (`919eb800`, `398aed56`; the composed sales-order journey reads its line quantity as `10`).
- CI on PR #16: `398aed56` fully green -- quality, both browser jobs (operations 19m22s, with the replenishment journey and the composed journeys), the three PostgreSQL jobs, scans, observability, the compile budget and executed-file reachability. Before it: `4afb02e1` green on all three PostgreSQL jobs (schema and isolation with `replenishment.test.ts`: every figure, tab and suggestion equal the stored-row oracle; composed; commercial), quality, browser, scans and observability; the operations browser reached the item form's save (fixed above). Earlier reds, all fixed: the browser journey's locators (`94552d4e`, `63c5ab9d`), the export-row literal (`4afb02e1`), one composed-job "Connection terminated unexpectedly" (green on the next run, unchanged code), SURF001 on the form's decimal import (`398aed56`).

## Test it yourself

`REPLENISHMENT-test-it-yourself.md`.

## Deferred

- Incoming, open demand and projected on the item page; the company-wide % reorder rule; per-location reorder points.
- A value or cost column on the Lists (ADR-0017).

## Filed

- A CSV cell starting with `-` is guarded as a formula, so a negative Projected exports as `'-4`.
- The generic Record form clears an optional field through "When … is blank" → Clear stored value; choosing None alone leaves the location unchanged on update.
- The generic Record form labels a field from its id ("Standard cost cad", as "Price cad"), not its declared label, and shows a stored decimal at scale 18.

```record-claim
{
  "schemaVersion": "northstar.record-claim/v1",
  "packet": "REPLENISHMENT",
  "base": "e3da0a3918620c5ce3e494eba3fdf1b3f8c91c4a",
  "head": "398aed56ad9cf0efbaabee2c4c20a696c027deca",
  "changedPaths": [
    "apps/web/release/app.authored.json", "apps/web/release/app.compiled.json", "apps/web/src/component-registry.ts",
    "apps/web/src/list-declaration.ts", "apps/web/src/surface-composition.ts", "apps/web/src/surface-contract.ts",
    "apps/web/src/surface-runtime.ts", "apps/web/test/browser/composed-application.spec.ts", "apps/web/test/browser/inventory-replenishment.spec.ts",
    "apps/web/test/browser/sales-order.composed-application.spec.ts", "apps/web/test/surface-runtime-contract.test.ts", "packages/canonical-model/src/index.ts",
    "packages/canonical-model/src/schemas.ts", "packages/canonical-model/src/surface-list.ts", "packages/canonical-model/src/surface-workspace.ts",
    "packages/compiler/src/projections.ts", "packages/domain/src/app/builder.ts", "packages/domain/src/app/list-declarations.ts",
    "packages/domain/src/app/order-entry.ts", "packages/domain/src/catalog/definition.ts", "packages/domain/src/inventory/item-stock-workspace.ts",
    "packages/postgres-provider/src/module-runtime-interpreter.ts", "packages/runtime/src/list-behavior/cursor.ts", "packages/runtime/src/list-behavior/figures.ts",
    "packages/runtime/src/list-behavior/index.ts", "packages/runtime/src/request-runtime-view.ts", "packages/runtime/src/semantic-query-gateway.ts",
    "test/architecture/repository-hygiene.test.ts", "test/architecture/surface-grammar-conformance.test.ts", "test/compiler/g2-module-conformance.test.ts",
    "test/fixtures/g2/language-conformance/coverage-decisions.json", "test/helpers/order-entry-fixture.ts", "test/integration/surface-data-binding.test.ts",
    "test/postgres/composed-application.test.ts", "test/postgres/fresh-tenant-full-replay-schema.snapshot.json", "test/postgres/module-storage-transition.test.ts",
    "test/postgres/replenishment.test.ts", "test/postgres/request-runtime-view.test.ts", "test/unit/canonical-model/surface-list.test.ts",
    "test/unit/workspace-contract.test.ts"
  ],
  "symbols": [
    {"path": "apps/web/src/component-registry.ts", "name": "canonicalStoredDecimal"},
    {"path": "apps/web/src/list-declaration.ts", "name": "figureBandLabel"},
    {"path": "apps/web/src/surface-runtime.ts", "name": "loadFormReferences"},
    {"path": "packages/canonical-model/src/schemas.ts", "name": "SurfaceFormSchema"},
    {"path": "packages/canonical-model/src/surface-list.ts", "name": "validateSurfaceLists"},
    {"path": "packages/canonical-model/src/surface-workspace.ts", "name": "validateSurfaceForms"},
    {"path": "packages/compiler/src/projections.ts", "name": "agentFigures"},
    {"path": "packages/domain/src/app/list-declarations.ts", "name": "itemFigureList"},
    {"path": "packages/domain/src/app/list-declarations.ts", "name": "worklistQueries"},
    {"path": "packages/domain/src/catalog/definition.ts", "name": "catalogModuleDefinition"},
    {"path": "packages/postgres-provider/src/module-runtime-interpreter.ts", "name": "listFiguresPlan"},
    {"path": "packages/postgres-provider/src/module-runtime-interpreter.ts", "name": "listFiguresFromSql"},
    {"path": "packages/runtime/src/list-behavior/figures.ts", "name": "parseSharedListFigures"}
  ]
}
```

Review: not owed — outside the Critical set.
