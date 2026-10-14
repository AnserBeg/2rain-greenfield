# ORDER-PARITY — the order Lists show their work, link to it and total purchase orders

Status: increments A (List row actions, supplementary progress, read-model List columns; the Sales and Purchase orders Lists' figures) and B (order-page shortage banner, invoice-to-order link, multi-line receipt Task, receipt reversal, progress panels) executable on draft PR #10 (stacked on #8); increment C (reservation coverage, "Blocked by supply", the List "!") chartered; no merge, no deployment. Sole LOCAL BUILD under the owner's standing instruction (2026-09-30: "dont stop until full parity is reached", "go with recommended choice").
Tier: outside the Critical set — web runtime, runtime list contract, canonical List keys, the commercial read model and metadata; no storage, migration, grant or posting change.
Base: `packet/PURCHASING-PARITY` at `46f723ef` (stacked on draft PR #8, itself on #7). Reference: PaneFlow `d057daff`; design `design-sales-purchasing-leftovers.md` (items 1, 2, 5); inventories `SALES-PARITY-inventory.md` L3, L7 and `PURCHASING-PARITY-inventory.md` P10.

## Owner rulings (2026-09-30, the recommended choice taken)

- OA: progress on the Sales and Purchase orders Lists is supplementary (`whenDenied: 'omit'`): a denied progress query leaves the List serving with its figures blank; Expected receipts keeps refusing, since its figures are its purpose.
- OB: the Purchase orders List's Total cannot be sorted (PaneFlow's can): it is computed after paging.
- OC: "Post shipment" as a row label waits for reservation coverage (increment C); "Fulfill" opens the order's fulfillment section meanwhile.
- OD: shortage is advisory, never blocking: an order line's uncovered open quantity beyond free stock now (on hand at all locations minus live reservations), allocated in line order; incoming purchase orders are not counted.
- OE: a receipt reversal takes every line still reversible (the kernel requires it for kind `reversal`); reversing some lines (kind `correction`) and per-line receipt locations or a received-on date stay out (Critical).

## Claims

1. Row actions (optional v6 `surface.list.rowActions`, at most 3): the first action whose declared condition holds (at most 3 field filters and/or `open`) renders as a keyboard link to the row's record page at a named section; the unconditional last action ("View") otherwise; at phone width the card carries it as a labelled line. The validator refuses duplicate ids, an unconditional action before the last, a condition naming neither a filter nor `open`, duplicate, unselected, label-compared or enum-invalid filter fields, `open` without the List's progress, rows without a record page, and a section that is not a dataset of that page.
2. Supplementary progress (`progress.whenDenied: 'omit'`): when current policy denies a progress query, the page, the tab counts and the export are re-requested without progress; the figures and read-model columns read "—" and one line names what is withheld; a view that needs progress refuses with `QUERY_PERMISSION_DENIED`, stays uncounted and keeps its tab.
3. A List column may name its query's read-model result field when unsorted (a plain value or money); the Purchase orders List reads `commercial_purchase_order_list` and shows each order's Total from the commercial read model after paging; a List read with line read denied states no totals while a single order's page still refuses.
4. Sales orders: Ordered, Shipped and Open to ship (from the order lines and `sales_order_shipped_list`, open only while Released), a "To ship" tab after All, and "Fulfill" to the order's fulfillment section while something is open.
5. Purchase orders: Total, Ordered, Received and Open, "To receive" and "Late" tabs, the Expected date marked "N days late" on late rows, and "Receive" to the order's lines while something is open.
6. A picker over a List whose query declares a read model enumerates the entity's plain active list query with the same selections, filter, permission, tier and company scope (the List's own entry authorization query first), so listing options never runs the read model; which List stands for the entity is unchanged.
7. Surface runtime floor 12 -> 13 for these keys; agent presets publish `whenDenied`.
8. Increment B, `presentation.alerts`: a confirmed or draft sales order's Fulfillment shows Short and Free-stock-now per line (a fulfillment read model over its own clone query, under the order's parent scope; a withheld read states nothing) and a banner while anything is short.
9. A get may name `relationTargets` (1-4 distinct ids, get only; `MODULE_RELATION_TARGET_INVALID` otherwise), read in the record's own statement: an invoice shows its Sales order with "Open sales order", a packing page its order; a denied or missing target reads "—".
10. Multi-row Tasks (`actions[].rows`, `inputs[].perRow`, `steps[].each`, at most 100 rows): "Receive lines with actual cost / cost explicitly absent" posts one receipt of several lines into one location, with a server-side "Fill open quantities" that works without script; the plan is fixed at the first confirm with one request key per run.
11. Receipt reversal: a receiving read model gives each receipt line its movement, reversible quantity and order line; "Reverse receipt" creates a reversal draft through the existing routes and `goods_receipt_post`, which the kernel's compensation rules bound.
12. `presentation.progression`: the PO page shows Draft, Released, Receiving, Closed; the Sales order page Sales order, Fulfillment, Invoicing (attention while anything is uninvoiced), Closed; each with one next action (the first action or command offered), none on a stopped record or while a Task is open. Surface floor 13 -> 14.

## Decisions

- Only an `open` view counts as needing progress; a before-only view reads none (every before view here is also open).
- A refused progress view reuses `QUERY_PERMISSION_DENIED` rather than a new catalog code; the work tabs sit directly after All.
- A row action's section must be a dataset of every record page over the entity; at runtime a missing section shows no link. Row links read "Fulfill SO-…", "Receive PO-…".
- The receiving page's "View order progress" link carries the new List's company parameter.
- Increment B: next-step controls are named "Next action: X" so no exact-name selector collides; shortage only for draft and confirmed orders; a related-record link carries no `returnTo`; the order-pages browser spec runs in the operations browser job.

## Gates

- Increment A (agent, on `2e5ede3e`, then merged onto the re-baselined PR #8 as `66aa7aa2`/`f699cecb`): tsc clean; eslint clean on the 25 changed files; unit `surface-list` 6/6; web contract 32/32; integration (the ORDER-PARITY and PURCHASING-PARITY binding tests, and the picker test) 5/5; compiler 47/47 across 12 files; architecture `surface-grammar-conformance` 25/25, the other five permitted files 82/83 (the matrix-lock timing test under load ~17-20); after the merges `test-reachability` + `repository-hygiene` 22/22.
- Release: rebuilt on PURCHASING-PARITY's one-entry lineage as entry 2 (9,057,803 B), `--check` PASS. Language coverage 2517 -> 2531 obligations, 757 -> 769 observed, PASS.
- Not run locally (the host is out of memory; container starts time out): PostgreSQL `order-lists` (new), `declared-list`, `expected-receipts`, `request-runtime-view`; browser `order-lists` (new), `declared-list`. CI on the PR is their first run.

- Increment B (agent, `6e192e4b`, merged onto `065f3c56`): unit 72/72 (new `surface-composition` 5/5); web contract 34/34; integration 29/29 (final-tree ORDER-PARITY run 6/6); architecture 103/103 (grammar, hygiene, reachability, press law, surface-data-binding, purity); tsc and eslint clean; release entry 3 (13,540,616 B) `--check` PASS; coverage 2531 -> 2654 obligations, 769 -> 811 observed. No storage change (two clone queries join the reader query ids), so no snapshot regeneration. Not run locally: PostgreSQL `order-pages` (new) and browser `order-pages` (new); CI is their first run. CI at `065f3c56`: every job green but the composed Sales journey, a one-in-sixty flake (a datetime-local typed to the second at the top of a minute) fixed on SALES-PARITY `b08e9941`.

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
  "base": "7ab138b3abb1bd1a022fdeab78fbc861f200bf3e",
  "head": "5b4e21f080e3ddd4ddaa7beb4a3ef4cadd04da23",
  "changedPaths": [
    "apps/web/playwright.shared.ts", "apps/web/release/app.authored.json", "apps/web/release/app.compiled.json",
    "apps/web/src/component-registry.ts", "apps/web/src/list-declaration.ts", "apps/web/src/receiving-section.ts",
    "apps/web/src/surface-composition.ts", "apps/web/src/surface-contract.ts", "apps/web/src/surface-runtime.ts",
    "apps/web/test/browser/declared-list.spec.ts", "apps/web/test/browser/order-lists.spec.ts", "apps/web/test/browser/order-pages.spec.ts",
    "apps/web/test/surface-runtime-contract.test.ts", "package.json", "packages/canonical-model/src/index.ts",
    "packages/canonical-model/src/schemas.ts", "packages/canonical-model/src/surface-composition.ts", "packages/canonical-model/src/surface-list.ts",
    "packages/compiler/src/projections.ts", "packages/domain/src/app/builder.ts", "packages/domain/src/app/list-declarations.ts",
    "packages/domain/src/purchasing/workspace.ts", "packages/domain/src/sales/workspace.ts", "packages/postgres-provider/src/commercial-read-model.ts",
    "packages/postgres-provider/src/composed-application-runtime.ts", "packages/postgres-provider/src/fulfillment-read-model.ts", "packages/postgres-provider/src/module-runtime-interpreter.ts",
    "packages/postgres-provider/src/receiving-read-model.ts", "packages/runtime/src/request-runtime-view.ts", "packages/runtime/src/semantic-query-gateway.ts",
    "test/architecture/repository-hygiene.test.ts", "test/architecture/surface-grammar-conformance.test.ts", "test/architecture/test-reachability.test.ts",
    "test/fixtures/g2/language-conformance/coverage-decisions.json", "test/helpers/order-entry-fixture.ts", "test/integration/surface-data-binding.test.ts",
    "test/postgres/declared-list.test.ts", "test/postgres/expected-receipts.test.ts", "test/postgres/order-lists.test.ts",
    "test/postgres/order-pages.test.ts", "test/postgres/request-runtime-view.test.ts", "test/unit/canonical-model/surface-composition.test.ts",
    "test/unit/canonical-model/surface-list.test.ts"
  ],
  "symbols": [
    {"path": "packages/canonical-model/src/surface-list.ts", "name": "validateSurfaceLists"},
    {"path": "apps/web/src/list-declaration.ts", "name": "declaredListArguments"},
    {"path": "apps/web/src/surface-contract.ts", "name": "pickerEnumerationQuery"}
  ]
}
```

Review: not owed — outside the Critical set.
