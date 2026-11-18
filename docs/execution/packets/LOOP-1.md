# LOOP-1 — the purchase order → inventory → sales order loop completes and makes sense

Status: frozen; slices 1 `02725446`, 2 `0cad5e5f`, memo `18155602`, 3-5 `e20ff129`, launcher fix `58ae4c3b`. Mechanical (no
Critical path). Base `689b0117`; claim block from main `c58e46e3`. Stops, each ruled: missing total, trim, time zone, budget.

## Claims

1. The scorecard walks PO → receive → stock → SO → ship → invoice → payment (fresh `distributor` seed), asserts each end state.
2. A sales line is never saved without its price; a shipped, invoiced order's next action pays each open invoice's whole
   balance; the payment reference is optional; the invoice form keeps no `sections` slot (no raw "New"/"Edit").
3. A warm request parses no operation catalog or surface manifest (`catalogParseCount()`, asserted); no auth or SQL change.
4. "Ship" reserves and ships the lines with nothing reserved in one rows Task (one location, one shipment); carrier and
   tracking are optional; order dates default to today; the create screens lead with the job's fields.
5. No catalog code or developer sentence in a page's text; any date-time at exactly midnight UTC reads as a plain date; the
   server validates and a refused save links to each field; one next-action button; a Task's result shows only what was written.
6. With no page asked for, a person lands on Today (to receive, to ship, not yet paid, to reorder, find by number); the menu
   groups read Stock and Customers and suppliers; navigation icons are inline SVG; the demo strip is a quiet bar.

## Decisions (one line each)

- Scorecard in `apps/web/test/browser/`; journey: from where the last step left off, menu and page controls, type only what is
  needed, accept defaults, a priced item. DB columns: a client count with RESETs (~405 vs 148 pairs), then Server-Timing (no
  second meter). Page budget: home and SO detail re-pinned at measured work (ruled); SPEED-1 brings them down.
- Rulings: confirm on a missing total filed (provider); whole-balance payment (part and defaults: phase 3); test bridges priced
  unpriced lines in `test/postgres/{fulfillment,order-lists,packing-retrieval}.test.ts` and `test/helpers/order-entry-fixture.ts`,
  `customer-credit.test.ts` keeps its case by an unstated tax rate; pins moved in `g2-module-conformance`, the grammar debt
  baseline (95 → 97), the reader-22 floor and the regenerated snapshot; invoice form without sections; disclosure carrier filed
  (LANGUAGE); plain dates, "(UTC)" kept on times of day, the tenant calendar zone (ADR-0018) filed for the renderer.
- Re-baselines (ADR-0066): slice 2 (price retypes a column), slices 3-5 (one entry, as main and AGENT-3's view read it): `dev:reset`.
- Next actions: invoice → ship → payment (ORDER-PARITY kept); meta-sales' lines-on-first-screen pin moved 650 → 800 (the Ship
  panel above them; on the distributor seed they start at 928 of 800). Landing = the first launcher (`inventory_today`).

## Slices (clicks / loads / typed / invented; raw codes)

1. [Baseline](../evidence/2026-11-17-loop-scorecard.md): PO 11/7/6/0, 3; sales side 18/14/8/2, 3; invoice and pay 9/9/2/1 via
   the invoice page. Targets restated: PO ≤ 8, sales side ≤ 11.
2. [After](../evidence/2026-11-17-loop-scorecard-slice-2.md): invoice and pay 8/8/0/0, from the order.
3. Memo [after](../evidence/2026-11-17-loop-scorecard-memo.md): PO detail wall ~1.7 s → 0.59 s, CPU 1.5 s → 0.2 s (two GitHub
   runners); 0 operation / 0 manifest parses per warm request.
4. Slices 3-5 [after](../evidence/2026-11-18-loop-scorecard-slices-3-5.md): PO 11/7/5/0, 1; sales side 13/9/3/0, 1; invoice and
   pay 8/8/0/0; developer sentences 0; create screens 17 (PO), 24 (SO). Not met: PO ≤ 8; sales ≤ 11; zero raw codes ("(UTC)").
   DB columns here are Server-Timing's, not comparable with the earlier tables' client counts. Seen on the app afterwards: the
   launcher tiles collapsed into one grid column and a launcher marked "Inventory movement" current; fixed `58ae4c3b`.

## Gates

CI green: 1 44179517091; 2 44187720302 (main 44193434122); memo 44189274091 (main 44200314898); 3-5 44214966721 (main
44219726449); fix 44221940167. Local: format, typecheck, lint, unit, compiler, integration, agent, contracts, release and coverage.

## Test it yourself

`pnpm --filter @north-star/api dev:reset`, `pnpm dev`, <http://127.0.0.1:4174/>: you land on Today. Purchasing → Purchase orders
→ New: Cascade Fastener Works, Calgary warehouse, FST-0120 × 10 at 12.00, Save draft, Place order; Receive → Fill, cost 12.00,
Review, Confirm. Stock → Stock by item: FST-0120 10. Sales → Sales orders → New: Lethbridge Millwork, FST-0120 × 4, Save draft,
Confirm; Ship (Calgary warehouse, Fill, Review, Confirm); Invoice shipped quantities; Record payment — each the next action.

## Filed

- Confirm refusing a missing total under no credit limit (provider); part payment and amount defaults (phase 3).
- Disclosure carrier (LANGUAGE); tenant time zone (ADR-0018); query catalog and binding memo; module icons (groups share one);
  "Not yet paid" counts open invoices only, not part-paid; AGENT-3's eval not run on Stock, Today or Ship (not in CI).
- Destinations neither regrouped nor renamed (Inventory movement, Legal entity, Party role); "Reserve stock" as a rows Task;
  Ship skips a line already partly reserved; the plan's rule 2 tenant-type repeat.

```record-claim
{
  "schemaVersion": "northstar.record-claim/v1", "packet": "LOOP-1",
  "base": "c58e46e359c7e05505d8bab8b46327d3de8ce91e", "head": "722365f08f2edf14c7d27920f232adf0d36b844f",
  "changedPaths": [
    "apps/web/release/app.authored.json", "apps/web/release/app.compiled.json", "apps/web/src/component-registry.ts", "apps/web/src/document-editor.ts", "apps/web/src/editor-controls.ts", "apps/web/src/message-catalog.ts", "apps/web/src/message-render.ts", "apps/web/src/surface-composition.ts", "apps/web/src/surface-runtime.ts", "apps/web/test/browser/composed-application.spec.ts",
    "apps/web/test/browser/inventory-catalog-aliases.spec.ts", "apps/web/test/browser/inventory-documents.spec.ts", "apps/web/test/browser/inventory-locations.spec.ts", "apps/web/test/browser/inventory-replenishment.spec.ts", "apps/web/test/browser/inventory-warehouse-mode.spec.ts", "apps/web/test/browser/item-stock.spec.ts", "apps/web/test/browser/loop-scorecard.composed-application.spec.ts", "apps/web/test/browser/loop-scorecard.ts", "apps/web/test/browser/meta-sales.spec.ts", "apps/web/test/browser/order-entry.spec.ts",
    "apps/web/test/browser/payables.spec.ts", "apps/web/test/browser/purchase-approvals.spec.ts", "apps/web/test/browser/purchase-pricing.spec.ts", "apps/web/test/browser/receivables.spec.ts", "apps/web/test/browser/receiving.composed-application.spec.ts", "apps/web/test/surface-runtime-contract.test.ts", "packages/domain/src/app/builder.ts", "packages/domain/src/app/order-entry.ts", "packages/domain/src/app/today.ts", "packages/domain/src/sales/workspace.ts",
    "test/architecture/surface-grammar-conformance.test.ts", "test/fixtures/g2/language-conformance/coverage-decisions.json", "test/integration/surface-data-binding.test.ts", "test/performance/page-budgets.ts", "test/postgres/composed-application.test.ts", "test/postgres/declared-list.test.ts", "test/unit/purchasing-definition.test.ts", "test/unit/sales-definition.test.ts"
  ],
  "symbols": [
    {"path": "apps/web/test/browser/loop-scorecard.ts", "name": "LoopScorecard"}, {"path": "apps/web/test/browser/loop-scorecard.ts", "name": "DatabaseStatistics"},
    {"path": "packages/domain/src/app/today.ts", "name": "todaySurface"}, {"path": "apps/web/src/surface-runtime.ts", "name": "landingSurface"}
  ]
}
```
