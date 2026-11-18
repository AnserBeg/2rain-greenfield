# LOOK-1 — every screen in the Ledger look the owner chose

Status: round 2 frozen at `e15cda79` (CI green, run 44288078657). Mechanical (no Critical path). Round 1 integrated at
`5d07856a` (its full record: this file at `51b99470`). Round 2 base `51b99470`. Rulings 2026-11-18: `rail` key, per-field
`disclosure: 'more'` and `dateOnly: true` approved; B11 option B (one primary "Save"); Custom group declared by the
customization expansion, never read from ids (lease on `packages/customization/src/apply.ts` for that one change).

## Round 2 claims (round 1: tokens, shell, record parts, lists/forms, the proof `look.composed-application.spec.ts`)

1. A (record pages): one PO lines table, totals under it; empty child sections say "None yet" quietly; no engineering
   prose; long commands and print behind "Record actions"; next-step buttons carry the record's figure ("Receive 10");
   exactly one current step; the document badge takes its declared colour (the CSS never coloured it); eyebrow
   "Purchase order"; Details shows only fields not shown elsewhere; technical details quiet.
2. Right rail: `presentation.rail` on a dataset (PO receipts, receipt lines, bills, approvals; SO shipments, invoices)
   stacks it in one column beside the sheet; a dataset with line progress is refused the rail.
3. B (forms): first fields, then "More details" (`disclosure: 'more'`; a required field is refused it); order dates are
   `dateOnly: true` (a date input, no "(UTC)"; refused on a non-date-time field); one primary "Save".
4. C: the proof enters an Equipment record (name, serial, date, status) and shows its page: eyebrow, title, the
   lifecycle badge, one Details grid with values by field kind (a choice's label, a date as a date), identity in
   technical details. Customization declares a "Custom" module (`custom_record-types`) and lists each record type
   there through `navigationModuleId`; the group keeps its heading over a placed single destination, which keeps its
   own name. Lists show no selection bar until a row is ticked.
5. D: the sidebar does not repeat Today; Companies list under Contacts, Inventory value under Stock; a group's several
   occasional destinations wait under its own "Other" (Stock: movements, period locks, inventory transactions, counts);
   the distributor seed and order-entry fixture name the company "Foothills Industrial Supply" (ids unchanged); Today's
   Open sits beside the find box.

## Decisions

- "Other", not "More", for a group's occasional destinations: the compiler's top-level More keeps its one meaning.
- Inventory transactions is `setup` membership: placement only, never authorization (ADR-0030).
- The seed renames the provisioned company by one update at revision 1, replayed by its key on restart.
- Customized release roots change (the expansion adds the Custom module): pre-tenant re-baseline, ADR-0066.
- Today keeps tiles and the find box: no "To receive" table or activity query exists (the page budget forbids one per widget).
- The proof also refuses canonical ids and raw instants on every screen.
- Next-step buttons are the action's label plus the record's figure ("Receive 10", "Ship 4"); "Receive 10 remaining"
  would need a per-action template, a language key not taken here.

## Gates

CI run 44288078657 green at `e15cda79` (every job, the proof). Local: format, lint, scoped typecheck, touched unit tests, the
web contract and integration files, `check:app-release`, coverage decisions re-derived. Shots: `docs/execution/evidence/look-1/`.

## Test it yourself

`pnpm --filter @north-star/api dev:reset`, `pnpm dev`, <http://127.0.0.1:4174/>: the bar names Foothills Industrial
Supply; open a purchase order: one lines table, "Receive N" button, linked records in the right column, other commands
under Record actions; New purchase order: four fields then More details, a date-only order date, one Save; Customize an
Equipment type, add one record: it is under Custom with labelled values.

## Filed

- SO lines stay two tables: fulfillment and commercial read models are separate queries and read models do not nest.
- Rail activity, stepper captions, "created by": no event source. Create-form running total: no declared draft formula.
- `saveThen` (option A, "Save and place") for phase 3, with its partial-failure notes (save committed, place refused).
- To invoice queue; totals' currency code. Tenant record pages: the badge is the lifecycle ("Active · revision 1", pinned by specs), not the record's own Status
  choice (a patch declares no status role); activity has no source; the breadcrumb reads "Equipment / Equipment".
- The assistant panel (AGENT-3) restyle follows once it lands.

```record-claim
{
  "schemaVersion": "northstar.record-claim/v1", "packet": "LOOK-1",
  "base": "51b99470d1b9e29af733943f979d2598967426b8", "head": "e15cda79c78e2a9f7288aa498aedc6c5a64b43b5",
  "changedPaths": [
    "apps/api/src/composition-root.ts", "apps/web/release/app.authored.json", "apps/web/release/app.compiled.json", "apps/web/src/component-registry.ts", "apps/web/src/document-editor.ts", "apps/web/src/editor-controls.ts", "apps/web/src/ledger-styles.ts", "apps/web/src/message-catalog.ts",
    "apps/web/src/surface-composition.ts", "apps/web/src/surface-runtime.ts", "apps/web/test/browser/composed-application.spec.ts", "apps/web/test/browser/customer-defaults.spec.ts", "apps/web/test/browser/inventory-documents.spec.ts", "apps/web/test/browser/inventory-valuation.spec.ts", "apps/web/test/browser/inventory-warehouse-mode.spec.ts", "apps/web/test/browser/location-runtime.spec.ts",
    "apps/web/test/browser/look.composed-application.spec.ts", "apps/web/test/browser/loop-scorecard.ts", "apps/web/test/browser/message-catalog.spec.ts", "apps/web/test/browser/order-entry.spec.ts", "apps/web/test/browser/order-pages.spec.ts", "apps/web/test/browser/order-pricing.spec.ts", "apps/web/test/browser/payables.spec.ts", "apps/web/test/browser/price-list-pricing.spec.ts",
    "apps/web/test/browser/purchase-pricing.spec.ts", "apps/web/test/browser/receivables.spec.ts", "apps/web/test/browser/receiving.composed-application.spec.ts", "apps/web/test/browser/sale-fulfillment.composed-application.spec.ts", "apps/web/test/browser/sales-order.composed-application.spec.ts", "apps/web/test/browser/surface-data-binding.spec.ts", "packages/canonical-model/src/schemas.ts", "packages/canonical-model/src/surface-composition.ts",
    "packages/canonical-model/src/surface-workspace.ts", "packages/customization/src/apply.ts", "packages/domain/src/app/builder.ts", "packages/domain/src/app/order-entry.ts", "packages/domain/src/app/seed.ts", "packages/domain/src/purchasing/approval-workspace.ts", "packages/domain/src/purchasing/workspace.ts", "packages/domain/src/sales/workspace.ts",
    "test/architecture/surface-grammar-conformance.test.ts", "test/fixtures/g2/language-conformance/coverage-decisions.json", "test/helpers/assert-composed-inventory.ts", "test/helpers/order-entry-fixture.ts", "test/integration/location-runtime.test.ts", "test/integration/surface-data-binding.test.ts", "test/performance/page-budget.test.ts", "test/postgres/inventory-posting.test.ts",
    "test/postgres/order-pages.test.ts", "test/unit/canonical-model/surface-composition.test.ts", "test/unit/canonical-model/surface-launcher.test.ts", "test/unit/customization.test.ts", "test/unit/purchasing-definition.test.ts", "test/unit/workspace-contract.test.ts"
  ],
  "symbols": [
    {"path": "packages/domain/src/app/builder.ts", "name": "composedDestinationPlacement"}, {"path": "packages/domain/src/app/seed.ts", "name": "DISTRIBUTOR_COMPANY_NAME"},
    {"path": "apps/web/src/surface-runtime.ts", "name": "sidebarNavigation"}, {"path": "apps/web/src/component-registry.ts", "name": "recordFieldValue"}
  ]
}
```
