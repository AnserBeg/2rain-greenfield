# ORDER-PARITY — the order Lists show their work, link to it and total purchase orders

Status: increment A (List row actions, supplementary progress, read-model List columns; the Sales and Purchase orders Lists' figures) executable; draft PR on `packet/PURCHASING-PARITY`; increments B (order-page shortage banner, invoice-to-order link, multi-line receipt Task, receipt reversal, progress panel) and C (reservation coverage, "Blocked by supply", the List "!") chartered; no merge, no deployment. Sole LOCAL BUILD under the owner's standing instruction (2026-09-30: "dont stop until full parity is reached", "go with recommended choice").
Tier: outside the Critical set — web runtime, runtime list contract, canonical List keys, the commercial read model and metadata; no storage, migration, grant or posting change.
Base: `packet/PURCHASING-PARITY` at `46f723ef` (stacked on draft PR #8, itself on #7). Reference: PaneFlow `d057daff`; design `design-sales-purchasing-leftovers.md` (items 1, 2, 5); inventories `SALES-PARITY-inventory.md` L3, L7 and `PURCHASING-PARITY-inventory.md` P10.

## Owner rulings (2026-09-30, the recommended choice taken)

- OA: progress on the Sales and Purchase orders Lists is supplementary (`whenDenied: 'omit'`): a denied progress query leaves the List serving with its figures blank; Expected receipts keeps refusing, since its figures are its purpose.
- OB: the Purchase orders List's Total cannot be sorted (PaneFlow's can): it is computed after paging.
- OC: "Post shipment" as a row label waits for reservation coverage (increment C); "Fulfill" opens the order's fulfillment section meanwhile.

## Claims

1. Row actions (optional v6 `surface.list.rowActions`, at most 3): the first action whose declared condition holds (at most 3 field filters and/or `open`) renders as a keyboard link to the row's record page at a named section; the unconditional last action ("View") otherwise; at phone width the card carries it as a labelled line. The validator refuses duplicate ids, an unconditional action before the last, a condition naming neither a filter nor `open`, duplicate, unselected, label-compared or enum-invalid filter fields, `open` without the List's progress, rows without a record page, and a section that is not a dataset of that page.
2. Supplementary progress (`progress.whenDenied: 'omit'`): when current policy denies a progress query, the page, the tab counts and the export are re-requested without progress; the figures and read-model columns read "—" and one line names what is withheld; a view that needs progress refuses with `QUERY_PERMISSION_DENIED`, stays uncounted and keeps its tab.
3. A List column may name its query's read-model result field when unsorted (a plain value or money); the Purchase orders List reads `commercial_purchase_order_list` and shows each order's Total from the commercial read model after paging; a List read with line read denied states no totals while a single order's page still refuses.
4. Sales orders: Ordered, Shipped and Open to ship (from the order lines and `sales_order_shipped_list`, open only while Released), a "To ship" tab after All, and "Fulfill" to the order's fulfillment section while something is open.
5. Purchase orders: Total, Ordered, Received and Open, "To receive" and "Late" tabs, the Expected date marked "N days late" on late rows, and "Receive" to the order's lines while something is open.
6. A picker over a List whose query declares a read model enumerates the entity's plain active list query with the same selections, filter, permission, tier and company scope (the List's own entry authorization query first), so listing options never runs the read model; which List stands for the entity is unchanged.
7. Surface runtime floor 12 -> 13 for these keys; agent presets publish `whenDenied`.

## Decisions

- Only an `open` view counts as needing progress; a before-only view reads none (every before view here is also open).
- A refused progress view reuses `QUERY_PERMISSION_DENIED` rather than a new catalog code; the work tabs sit directly after All.
- A row action's section must be a dataset of every record page over the entity; at runtime a missing section shows no link. Row links read "Fulfill SO-…", "Receive PO-…".
- The receiving page's "View order progress" link carries the new List's company parameter.

## Gates

- Increment A (agent, on `2e5ede3e`, then merged onto the re-baselined PR #8 as `66aa7aa2`/`f699cecb`): tsc clean; eslint clean on the 25 changed files; unit `surface-list` 6/6; web contract 32/32; integration (the ORDER-PARITY and PURCHASING-PARITY binding tests, and the picker test) 5/5; compiler 47/47 across 12 files; architecture `surface-grammar-conformance` 25/25, the other five permitted files 82/83 (the matrix-lock timing test under load ~17-20); after the merges `test-reachability` + `repository-hygiene` 22/22.
- Release: rebuilt on PURCHASING-PARITY's one-entry lineage as entry 2 (9,057,803 B), `--check` PASS. Language coverage 2517 -> 2531 obligations, 757 -> 769 observed, PASS.
- Not run locally (the host is out of memory; container starts time out): PostgreSQL `order-lists` (new), `declared-list`, `expected-receipts`, `request-runtime-view`; browser `order-lists` (new), `declared-list`. CI on the PR is their first run.

## Test it yourself

`ORDER-PARITY-test-it-yourself.md`.

## Filed

- Every List row still reads its order's lines once for the Total and the figures (one read per row, per tab count and per exported row, export limit 5,000): measure the export.
- No test covers netting of shipment corrections in the Sales figures.
- The surface floor 13 may collide with INVENTORY-PARITY's `fieldScope`; whichever lands second takes 14.

```record-claim
{
  "schemaVersion": "northstar.record-claim/v1",
  "packet": "ORDER-PARITY",
  "base": "46f723ef5945e5536b42461e2caeb7b7f6ad366a",
  "head": "f699cecbc7492bea222d088d0918d71ab2927da0",
  "changedPaths": [
    "apps/web/release/app.authored.json", "apps/web/release/app.compiled.json", "apps/web/src/component-registry.ts",
    "apps/web/src/list-declaration.ts", "apps/web/src/receiving-section.ts", "apps/web/src/surface-contract.ts",
    "apps/web/src/surface-runtime.ts", "apps/web/test/browser/declared-list.spec.ts", "apps/web/test/browser/order-lists.spec.ts",
    "apps/web/test/surface-runtime-contract.test.ts", "packages/canonical-model/src/index.ts", "packages/canonical-model/src/schemas.ts",
    "packages/canonical-model/src/surface-list.ts", "packages/compiler/src/projections.ts", "packages/domain/src/app/builder.ts",
    "packages/domain/src/app/list-declarations.ts", "packages/domain/src/sales/workspace.ts", "packages/postgres-provider/src/commercial-read-model.ts",
    "packages/runtime/src/request-runtime-view.ts", "test/architecture/repository-hygiene.test.ts", "test/architecture/surface-grammar-conformance.test.ts",
    "test/fixtures/g2/language-conformance/coverage-decisions.json", "test/helpers/order-entry-fixture.ts", "test/integration/surface-data-binding.test.ts",
    "test/postgres/declared-list.test.ts", "test/postgres/expected-receipts.test.ts", "test/postgres/order-lists.test.ts",
    "test/postgres/request-runtime-view.test.ts", "test/unit/canonical-model/surface-list.test.ts"
  ],
  "symbols": [
    {"path": "packages/canonical-model/src/surface-list.ts", "name": "validateSurfaceLists"},
    {"path": "apps/web/src/list-declaration.ts", "name": "declaredListArguments"},
    {"path": "apps/web/src/surface-contract.ts", "name": "pickerEnumerationQuery"}
  ]
}
```

Review: not owed — outside the Critical set.
