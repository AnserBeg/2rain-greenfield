# LOCATIONS — a location's inventory status and widened types; only usable stock is usable or available

Status: slice 1 executable and CI-green at `86b5537f` on draft PR #22 against `packet/REPLENISHMENT` (stacked on #16 <- #13 <- #11 <- #10 <- #8 <- #7); no merge, no deployment. Slice 2 waits on RELATION-INSTALL (below). Sole LOCAL BUILD under the owner's standing instruction (take the recommended choice, record it, report it).
Tier: outside the Critical set — canonical grammar keys, the compiler's surface floor, the shared List contract, gateway and list statement, the fulfillment read model, the web runtime and domain metadata; no posting-kernel, serializer, materializer, activation, verification, trust, migration or RLS change.
Base: `packet/REPLENISHMENT` at `85bca8d0` (REPLENISHMENT `3e40506c` plus INVENTORY-PARITY `8b4c8290`'s CI jobs; release envelope unchanged). Reference: PaneFlow `d057daff` (`db/schema.ts` locations; `lib/server/advanced-domain.ts` `saveLocation`, `moveInventory`; `lib/server/reports.ts` `replenishmentWorklist`); design `design-structural-gaps.md` §4; audit I2, I9, I10, I11, I24.

## Owner rulings (the recommended choice taken)

- L-A: inventory status and bins are location attributes, not stock dimensions; dimension set v1 stays. ADR-0069 records how plan §12.6 reads.
- L-B: the location type widens through `widenEnumDomain` (ADR-0064), no re-baseline.
- L-C: refusing to reserve or ship from an unusable location inside the posting kernel is Critical and deferred; display and exclusion ship first.

## Claims

1. Location (product mount, option `inventoryStatus`): `location_status` — usable, quarantine, damaged, in transit, return pending — optional with the declared default usable, so a location released before it, and every location a create does not give one (the form never does), reads usable; `location_status_reason` (1000) and `location_status_changed_at` (UTC instant), optional; every location query selects them. The type appends storage, receiving, shipping, quarantine, in transit, scrap and yard after warehouse and store. The standalone harness keeps its three fields.
2. The location page is a workspace (`locationWorkspace`): name, code and status in its header, type, reason and time among its facts, and "Change status" — a Task whose status choice starts from the record's and whose reason is required — writing status, reason and the instant in one governed `location_update`.
3. `surface.form.omit` (optional v6 key): a Record form leaves out fields a declared Task of its record's page sets; it neither renders nor reads them (`formFieldIds`). Refused (`CANON_SCHEMA_INVALID`): a field the form does not read, a required field without a declared default, a field no Task of the record's page sets, a field omitted twice or also chosen by a reference, a form declaring neither references nor omissions. The location form omits the three status fields.
4. `within.reference` (optional v6 key): a figure's parent may be the record whose id its rows hold in a text field of 36+ characters their query selects; refused for a short field, another entity's field, both or neither of relation and reference. The gateway authorizes the field on the rows' query; the statement joins the parent on that id as text, pinned to tenant and environment, archived parents excluded, scoped parents to the rows' company and the issued read scope.
5. Stock by item and the Buying worklist: Usable sums posted stock at usable locations; Available = Usable − what reservations hold at usable locations; Projected = Usable + Incoming − Open demand (PaneFlow's formula); Reserved stays every reservation's remainder. Stock by item reaches the 12-column limit.
6. The fulfillment read model reads each location's status through a declared `locations` dependency (`location_get`, unscoped, under current policy) on the item page's stock, the reservation figures and the order lines' shortage: nothing is available at an unusable, gone or archived location; an order line's free stock now counts usable locations only. Without the dependency every location is usable, as before.
7. The Location List: Code, Name, Type, Inventory status (a status: usable success, quarantine and return pending attention, damaged blocked, in transit in progress) and Status reason, filtered by status or type; setup, no export.
8. The item page names each location's status beside its stock; a referenced enumeration reads by its option's label.
9. Surface floor 19 (18 is WAREHOUSE-MODE's, in parallel); the runtime supports 19.

## Decisions

- Status changes go through a page Task (one update, atomic) rather than a state machine: a transition takes no reason, and a machine would offer every status change as a reason-less command.
- The status is optional with its declared default, not required: an operation's input contract makes a create state every required field whatever its column defaults to, which refused every location create on CI's first run (`MODULE_REQUIRED_FIELD_MISSING`). The physical column is the same nullable text defaulting to usable.
- A status change reclassifies what the location holds, in place; moving part of it is a transfer into a location of that status (PaneFlow's status change). PaneFlow refuses status changes on non-empty locations because it keys serial units by status; Rain keys nothing by status (ADR-0069).
- Available follows PaneFlow literally: usable on hand less what reservations hold at usable locations; a reservation at a quarantined location is shown under Reserved but reduces no usable figure.
- The item page states Available 0 (not "—") at an unusable location: nothing is available there, which is known, not missing.
- The Location List declares no export: the location query declares no export limit.
- The composed browser journey reads the location workspace; the generic record page's compact sections are read in the standalone Location journey, the one plain record page with seeded data left.
- The order-entry fixture gains a `locations` phase: a quarantined QA-HOLD, a transfer of 4 notebooks into it and a confirmed sale of 8.
- The focus-ring journey's plain record state saves one tax code through its generic form (a fixed record id and request key, replayed on every later visit) and reads its page: with the location page a workspace, no seeded plain page renders field sections; the known-absent set stays `.list-page-link` alone.
- Two composed PostgreSQL tests that install the whole lineage and then a successor or a reverse edge run on a 1 GB data tmpfs, as the full-replay generator does (SALES-PARITY `28461658`): the eighth entry (39.6 MB) overflowed the default 256 MB twice on CI ("No space left on device"); lanes at seven entries pass. Room for the data, not a bound.

## Slice 2 — waiting on RELATION-INSTALL

A location parent (warehouses containing locations, cycle-checked), a warehouse scope on the stock Lists (I2), transfers between warehouses through an in-transit location with "Receive transfer" (I11) and the receive Task defaulting to the item's preferred location (I24). The parent is a relation column on the released location table, which the materializer refuses (`ELEMENT_TARGET_MISSING`) until RELATION-INSTALL (draft PR #20, Critical, review owed) lands; no plain-text parent id is used meanwhile (owner ruling).
Found while planning it, for slice 2's charter: an operation's relation inputs exist on create only (`relationInputs`), so moving a location under another warehouse needs relation inputs on update; "cycle-checked" needs a declared acyclic self-relation the interpreter enforces; a warehouse scope needs a figure parent value chosen per request.

## Gates

- Merge: fast-forward to `85bca8d0` (the coordinator's REPLENISHMENT head) before the first push.
- Release: lineage entry 8 rebuilt from REPLENISHMENT's seven (34.2 -> 39.6 MB), `--check` PASS; demo release `--check` PASS.
- Pins from the compile: surface floor 17 -> 19 (grouped, flat and runtime); verification 579 -> 583 scenarios (the status's enum rejection and three search exclusions), executed 502 -> 506, derived 77; surfaces 103, navigation leaves 18, numbered fields and composed navigation names unchanged.
- Coverage re-derived from REPLENISHMENT's document: 2721 -> 2725 obligations, 878 -> 886 observed, PASS.
- Local, no container: typecheck, prettier and eslint clean on every changed file; unit (every file of the unit list), compiler, agent, web contract 39/39; architecture grammar, seam, purity, press law, UX and runtime-view boundary 94/94; integration surface-data-binding's LOCATIONS, REPLENISHMENT and INVENTORY-PARITY tests (CI ran the rest). No container test ran locally: Windows free memory stayed under 1.2 GB.
- CI on PR #22: `86b5537f` fully green ([run 37293967602](https://github.com/AnserBeg/2rain-greenfield/actions/runs/37293967602)) -- quality, the three browser jobs (with `inventory-locations.spec.ts`), the three PostgreSQL jobs (with `locations.test.ts`), scans, observability, the compile budget and executed-file reachability. The full-replay schema snapshot is GitHub's regeneration (`evidence.yml` at `173e2737`), confirmed IDENTICAL at `917fc19c`.
- Earlier reds, all fixed: every location create refused while the status was required (`68c947e7`); the focus-ring state lost its field-section subject with the location workspace (`257a8365`, `6355b053`); the item-stock journey, the runtime-view refusal and the description sentence (`b9704de9`); the eighth entry overflowing the composed tests' 256 MB data tmpfs (`86b5537f`).

## Test it yourself

`LOCATIONS-test-it-yourself.md`.

## Deferred

- Refusing to reserve or ship from an unusable location in the posting kernel (L-C, Critical).
- Usable and Available totals in the item page's header; per-location reorder points.

## Filed

- The generic `location_update` still admits a status patch through the operation gateway (an agent or integration), without the Task's reason, and may clear it (a cleared status counts as not usable); only the page's Task and the form are governed by metadata. A per-operation writable-field contract would close it.
- An in-transit location type does not require an in-transit status (PaneFlow pairs the two).
- The item page's stock fails whole when a balance sits at an archived location: its Location column reads live locations only (pre-existing).

```record-claim
{
  "schemaVersion": "northstar.record-claim/v1",
  "packet": "LOCATIONS",
  "base": "85bca8d0bc1d7442f2f25081e5f08e6ce227f9ad",
  "head": "86b5537ffd7a19f08607968edd1a0af62196e668",
  "changedPaths": [
    "apps/web/release/app.authored.json", "apps/web/release/app.compiled.json", "apps/web/src/component-registry.ts",
    "apps/web/src/list-declaration.ts", "apps/web/src/surface-composition.ts", "apps/web/src/surface-contract.ts",
    "apps/web/src/surface-runtime.ts", "apps/web/test/browser/composed-application.spec.ts", "apps/web/test/browser/inventory-locations.spec.ts",
    "apps/web/test/browser/item-stock.spec.ts", "apps/web/test/browser/location-runtime.spec.ts", "apps/web/test/surface-runtime-contract.test.ts",
    "packages/canonical-model/src/schemas.ts", "packages/canonical-model/src/surface-list.ts", "packages/canonical-model/src/surface-workspace.ts",
    "packages/compiler/src/projections.ts", "packages/domain/src/app/builder.ts", "packages/domain/src/app/list-declarations.ts",
    "packages/domain/src/app/order-entry.ts", "packages/domain/src/inventory/item-stock-workspace.ts", "packages/domain/src/location/definition.ts",
    "packages/domain/src/location/workspace.ts", "packages/domain/src/sales/workspace.ts", "packages/postgres-provider/src/fulfillment-read-model.ts",
    "packages/postgres-provider/src/module-runtime-interpreter.ts", "packages/runtime/src/list-behavior/figures.ts", "packages/runtime/src/request-runtime-view.ts",
    "packages/runtime/src/semantic-query-gateway.ts", "test/architecture/repository-hygiene.test.ts", "test/architecture/surface-grammar-conformance.test.ts",
    "test/fixtures/g2/language-conformance/coverage-decisions.json", "test/helpers/order-entry-fixture.ts", "test/integration/surface-data-binding.test.ts",
    "test/postgres/composed-application.test.ts", "test/postgres/fresh-tenant-full-replay-schema.snapshot.json", "test/postgres/locations.test.ts",
    "test/postgres/replenishment.test.ts", "test/postgres/request-runtime-view.test.ts", "test/unit/canonical-model/surface-list.test.ts",
    "test/unit/location-definition.test.ts", "test/unit/workspace-contract.test.ts"
  ],
  "symbols": [
    {"path": "apps/web/src/surface-composition.ts", "name": "referenceLabel"},
    {"path": "apps/web/src/surface-contract.ts", "name": "formFieldIds"},
    {"path": "packages/canonical-model/src/schemas.ts", "name": "SurfaceFormSchema"},
    {"path": "packages/canonical-model/src/surface-list.ts", "name": "validateSurfaceLists"},
    {"path": "packages/canonical-model/src/surface-workspace.ts", "name": "validateSurfaceForms"},
    {"path": "packages/compiler/src/projections.ts", "name": "agentFigures"},
    {"path": "packages/domain/src/app/list-declarations.ts", "name": "itemFigureList"},
    {"path": "packages/domain/src/app/list-declarations.ts", "name": "locationList"},
    {"path": "packages/domain/src/location/definition.ts", "name": "locationModuleDefinition"},
    {"path": "packages/domain/src/location/workspace.ts", "name": "locationWorkspace"},
    {"path": "packages/domain/src/sales/workspace.ts", "name": "salesWorkspaceQueries"},
    {"path": "packages/postgres-provider/src/fulfillment-read-model.ts", "name": "fulfillmentReadModel"},
    {"path": "packages/postgres-provider/src/module-runtime-interpreter.ts", "name": "listFiguresPlan"},
    {"path": "packages/postgres-provider/src/module-runtime-interpreter.ts", "name": "listFiguresFromSql"},
    {"path": "packages/runtime/src/list-behavior/figures.ts", "name": "parseWithin"}
  ]
}
```

Review: not owed — outside the Critical set.
