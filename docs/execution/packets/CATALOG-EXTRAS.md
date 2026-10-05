# CATALOG-EXTRAS — item aliases, stocked or not, merging duplicates and a company reorder rule

Status: executable, CI green at `7a91e321`, on draft PR #24 against `packet/REPLENISHMENT` (#16, stacked on #13 <- #11 <- #10 <- #8 <- #7); no merge, no deployment. BUILD under the owner's standing instruction (take the recommended choice, record it, report).
Tier: outside the Critical set — canonical grammar keys, the compiler's surface manifest and agent presets, the shared List runtime and gateway, the module runtime interpreter's list statement, the web runtime and domain metadata; no posting-kernel, serializer, materializer, activation, verification, trust, migration or RLS change.
Base: `packet/REPLENISHMENT` at `85bca8d0`. Reference: PaneFlow `d057daff` (`lib/server/advanced-domain.ts` aliases, merge and the company % rule; `app/inventory-app.tsx`); design `design-structural-gaps.md` §5 (I28) and §4; audit rows I5 and I28.

## Owner rulings (the recommended choice taken)

- Aliases and the inventory policy are per item; merge = archive the duplicate and add its SKU as an alias of the survivor; pictures are OUT (file storage); the company % rule is derived at read time, nothing rewritten.
- "Unique per company" is the SKU's own scope — unique across the business (tenant and environment): an item is shared by every company, so an alias that names one item names it everywhere.
- The company setting is the legal entity's own optional "Reorder point % of reorder up to"; unset, the company has no rule and an item following it has no reorder point there (never due). Not range-checked (the language has no decimal bounds).
- The derived point is up-to x % / 100, rounded half away from zero to the 18 places a level is kept at.
- Policy and rule are optional with declared defaults (Stocked, Manual), so every existing create path is unchanged; an unset policy reads as stocked.
- A non-stocked item's band names it "Not stocked" first, so no Shortage, Reorder or To buy tab keeps it; All still lists it.
- `item_alias_item` is `restrict`: an item is archived only once no active alias names it. A duplicate with aliases of its own is refused at the merge's archive until they are removed.
- The merge starts on the duplicate's page ("Merge into another item"): alias first, then archive, so a refused step leaves nothing lost; the survivor list never offers the duplicate (`excludeRecord`). A merged SKU is not removed from the page.
- Merge refusing a duplicate with open documents: inventory documents already refuse it. The item's inventory references (movements, stock-document lines, count lines) are `restrict`, so a duplicate with any of them — open or posted — is refused at the merge's archive by name (`MODULE_ARCHIVE_RESTRICTED`); its merged alias is still written and no movement is re-pointed. Sales and purchase lines hold the item as plain text, so no declared relation lets the archive see them: that half is DEFERRED (a cross-entity archive guard is new operation grammar the release verification, Critical, reads).
- Composed tests 9 and 10 run on a 1 GB data volume, as the full-replay generator does (28461658): their deployments (two compiled successors and four verifications; two tenants' lineages) passed the default 256 MB tmpfs at lineage entry 8 — CI: `could not extend file ...: No space left on device` (53100), surfaced by the verification's `finally` as "semantic operation execution failed". A capacity, not a check: no assertion, timeout or bound under test changes.
- The Items List is declared (SKU, Item, Unit, Inventory policy, Price CAD; All, Stocked, Non-stocked) to carry the alias search.

## Claims

1. Catalog, with `catalogExtras` (the product only): `item_alias` (Alias, a tenant-environment business key; Kind: alternate SKU, barcode, supplier code, merged SKU) under `item_alias_item` (parentScopedChild, required, restrict), its operations, queries, permissions (bound in `current-policy-bindings.json`), storage and contextual surfaces owned by the Items List; the item's Inventory policy and Reorder rule. Inventory, with `companyReorderRule`: the legal entity's `reorder_point_percent`, read by every legal entity query. The inventory contract and the compiler's pinned copy classify `item_alias` tenant-shared, its relation cross-entity.
2. `surface.list.searchChildren` and a draft editor `reference.searchChildren` (optional v6 keys, 1-2): a row also matches the search through an active child, through the child's parentScopedChild relation, holding the text in a text field the child's active unscoped q0 list query selects. The gateway authorizes each child query per request only when there is search text; the list statement adds an EXISTS beside the folded match before the count and the page, pinned to the row's tenant and environment and the read scope; the cursor binds it and the echo is required.
3. List figure `choices` (optional v6 key, ≤2), computed after the sums and before the totals: by the row's own enumeration, a selected exact decimal, a figure declared before it, or a percentage of one by the List's company's own exact decimal — read from the legal-entity master the issued read scope names (exactly one company), through an unscoped list query the gateway authorizes like a label; a missing value is unstated. Band cases `when` (the row's own enumeration holds one of the values) and band thresholds naming a figure declared before the band.
4. A composition reference input's `excludeRecord` (optional v6 key): over the record's own entity, the Task never offers the record; a forged choice of it never runs. A shared record's Task reads its company under the authorization List's operand, as its page does (`surface-composition.ts`, a bridge: without it every item page Task was unavailable).
5. Named refusals (`CANON_SCHEMA_INVALID`): a search child that is not an active unscoped q0 list, not a parentScopedChild relation to the searched entity, not a selected text field, or twice; a choice by a non-enumeration, values not its options or repeated, a value naming a later figure or an unselected decimal, a company percentage under an unscoped List or not an exact decimal of an unscoped q0 list; a band case with two tests, `when` values not options of a selected enumeration, a threshold figure not declared before; `excludeRecord` off a reference over the record's entity. Surface floor 20 (18 and 19 are WAREHOUSE-MODE's and LOCATIONS').
6. The product: the Items List and every product picker (sales, purchase and stock-document lines) find an item by an alias; the item page shows its policy and rule, its Aliases with Add alias, Remove alias and Merge into another item; Stock by item and the Buying worklist show the derived reorder point and never judge a non-stocked item.

## Decisions

- The Reorder point column of Stock by item and the Buying worklist became a figure (unsortable): the point the bands judge.
- An unsearched List reads no alias, so a withheld alias read refuses a search, never the List.
- The integration and PostgreSQL witnesses compute choices and `when` bands from stored rows.
- The composed browser fixture's direct legal-entity insert names every column, so it names the new percentage (null).

## Gates

- Release: lineage entry 8 rebuilt from REPLENISHMENT's 7 (34.2 -> 39.7 MB), `--check` PASS.
- Pins from the compile: surface floor 17 -> 20 (grouped, flat, runtime, the five PostgreSQL pins); surfaces 103 -> 106 (flat fixture 18 -> 21); navigation unchanged (18); verification 579 -> 596 scenarios (item +4, alias 12, legal entity +1), executed 502 -> 519, derived 77; numbered fields unchanged; the inventory-contract golden gains the alias family and relation.
- Coverage re-derived: 2721 -> 2744 obligations, 878 -> 899 observed. Expected-red manifests: 162 entries in 13 name live text.
- Full-replay schema snapshot from CI (`regen-snapshot`, run 37295568865 at `3fb74ed6`): 411 added lines, none removed; committed at `73c15209`, whose run (37305577274) found it IDENTICAL. Label removed.
- Local: typecheck, eslint, prettier; unit, compiler, agent, integration (246/246), web contracts; `check-records` OK.
  This laptop runs the PostgreSQL and composed witnesses past their 300 s budgets, so CI is their gate. Diagnostics
  here (a second verification of the head under a new release id; a rollback from a synthetic successor) both
  passed, which pointed at the environment: CI then named it (`No space left on device`).
- CI green at `7a91e321` (run 37308400566), every job: quality 9m53s of 15 (unit, compiler, integration, agent,
  architecture, release freshness, web contracts, language coverage); PostgreSQL 236/236, the witness 72.6 s, job
  16m54s of 30; composed PostgreSQL 21/21, tests 9 and 10 on the 1 GB volume; operations browser 12/12,
  `inventory-catalog-aliases` 1.6 min, job 9m21s of 20; composed browser, browser, commercial, scans, performance,
  observability, executed-file reachability. Earlier runs named the integration fakes, the snapshot and the composed
  disk (37295554381 at `3fb74ed6`); the unit producer, the witnesses' archive subject and Task selects, the composed
  browser fixture's every-column insert (37305577209 at `73c15209`).

## Test it yourself

`CATALOG-EXTRAS-test-it-yourself.md`.

## Deferred

- Refusing a merge while the duplicate has open sales or purchase documents (above); moving a duplicate's own aliases
  to the survivor; merging a duplicate that has stock history (its movements keep it active: re-point or retire with
  history is the owner's call — never re-pointed here).
- The Warehouse scan box resolving an alias: WAREHOUSE-MODE (#18, a sibling) opens "the item a SKU names" through
  the item's resolve query; at integration that resolve gains the alias search (`searchChildren` on a resolve), which
  the agent's resolve-by-name wants too. Nothing here touches its scan box.
- The derived reorder point on the item page (it shows the stored point and the rule).

## Filed

- The merge's survivor choice lists every item (a Task reference input has no search); over 1,000 items it refuses as incomplete.
- After a merge the Task reads "Task complete": the duplicate it archived can no longer be shown.
- An item whose Inventory policy is cleared (it is optional) is still judged stocked, but the Items List shows it only
  under All: the Stocked tab filters on the stored value.

```record-claim
{
  "schemaVersion": "northstar.record-claim/v1",
  "packet": "CATALOG-EXTRAS",
  "base": "85bca8d0bc1d7442f2f25081e5f08e6ce227f9ad",
  "head": "7a91e321e99e8cd8bd380d577687c76edc69fc5b",
  "changedPaths": [
    "apps/web/release/app.authored.json", "apps/web/release/app.compiled.json", "apps/web/release/current-policy-bindings.json",
    "apps/web/src/document-editor.ts", "apps/web/src/list-declaration.ts", "apps/web/src/surface-composition.ts",
    "apps/web/src/workspace-entry.ts", "apps/web/test/browser/composed-application.spec.ts", "apps/web/test/browser/inventory-catalog-aliases.spec.ts",
    "apps/web/test/surface-runtime-contract.test.ts", "package.json", "packages/canonical-model/src/picker-eligibility.ts",
    "packages/canonical-model/src/schemas.ts", "packages/canonical-model/src/surface-composition.ts", "packages/canonical-model/src/surface-list.ts",
    "packages/canonical-model/src/surface-workspace.ts", "packages/compiler/src/conformance.ts", "packages/compiler/src/projections.ts",
    "packages/domain/src/app/builder.ts", "packages/domain/src/app/list-declarations.ts", "packages/domain/src/app/order-entry.ts",
    "packages/domain/src/catalog/definition.ts", "packages/domain/src/inventory/contracts.ts", "packages/domain/src/inventory/definition.ts",
    "packages/domain/src/inventory/item-stock-workspace.ts", "packages/postgres-provider/src/module-runtime-interpreter.ts", "packages/runtime/src/list-behavior/cursor.ts",
    "packages/runtime/src/list-behavior/figures.ts", "packages/runtime/src/list-behavior/index.ts", "packages/runtime/src/request-runtime-view.ts",
    "packages/runtime/src/semantic-query-gateway.ts", "test/architecture/repository-hygiene.test.ts", "test/architecture/surface-grammar-conformance.test.ts",
    "test/compiler/inventory-contract.release.golden.json", "test/fixtures/g2/language-conformance/coverage-decisions.json", "test/helpers/order-entry-fixture.ts",
    "test/helpers/reachability-producers.ts", "test/integration/surface-data-binding.test.ts", "test/postgres/catalog-extras.test.ts",
    "test/postgres/composed-application.test.ts", "test/postgres/fresh-tenant-full-replay-schema.snapshot.json", "test/postgres/inventory-posting.test.ts",
    "test/postgres/inventory-stock-count.test.ts", "test/postgres/inventory-terminal-state.test.ts", "test/postgres/module-runtime.test.ts",
    "test/postgres/module-storage-transition.test.ts", "test/postgres/request-runtime-view.test.ts", "test/postgres/stock-serializer.test.ts",
    "test/unit/canonical-model/surface-list.test.ts", "test/unit/catalog-extras.test.ts", "test/unit/workspace-contract.test.ts"
  ],
  "symbols": [
    {"path": "apps/web/src/workspace-entry.ts", "name": "ReferenceSearchChild"},
    {"path": "packages/canonical-model/src/picker-eligibility.ts", "name": "searchChildProblem"},
    {"path": "packages/canonical-model/src/schemas.ts", "name": "listSearchChild"},
    {"path": "packages/canonical-model/src/schemas.ts", "name": "listFigureChoice"},
    {"path": "packages/domain/src/app/list-declarations.ts", "name": "itemList"},
    {"path": "packages/domain/src/app/list-declarations.ts", "name": "choiceValues"},
    {"path": "packages/domain/src/catalog/definition.ts", "name": "enumField"},
    {"path": "packages/postgres-provider/src/module-runtime-interpreter.ts", "name": "searchChildrenPlan"},
    {"path": "packages/postgres-provider/src/module-runtime-interpreter.ts", "name": "SearchChildPlan"},
    {"path": "packages/postgres-provider/src/module-runtime-interpreter.ts", "name": "FigureChoiceValuePlan"},
    {"path": "packages/runtime/src/list-behavior/figures.ts", "name": "parseChoiceValue"},
    {"path": "packages/runtime/src/list-behavior/figures.ts", "name": "parseWhen"},
    {"path": "packages/runtime/src/list-behavior/index.ts", "name": "parseSearchChildren"},
    {"path": "packages/runtime/src/list-behavior/index.ts", "name": "SharedListSearchChild"},
    {"path": "packages/runtime/src/list-behavior/index.ts", "name": "AuthorizedSharedListSearchChild"}
  ]
}
```

Review: not owed — outside the Critical set.
