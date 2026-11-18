# LOOK-1 — every screen in the Ledger look the owner chose

Status: round 3 frozen at `bfae71f0` (CI green, run 44325476363). Mechanical (no Critical path). Round 3 answers Fable
review 1 (`2rain-missions/look-1-fable-review-1.md`), merged in groups: (a) `fb3f95ee`, (b) `eed94293`, (c)–(e) together
(ruled: they share render files; the deviation from one merge per group is accepted). Earlier rounds: round 2 `d0d3baf7`,
round 1 `5d07856a` (their records: this file at `c3ab7ab1` and `51b99470`). Claim base: main `1156974b`, merged in.

## Round 3 claims

1. (a) Chrome: the top bar is the search and an initials avatar whose menu holds the principal, the demo's person
   switch and Diagnostics; the sidebar's head is the page's company (the same Company links); queues and areas scroll
   between a fixed head and a foot naming the person and role; one Settings disclosure holds the groups' occasional
   destinations; a record's identity and revision live in its "…" or Record actions menu. Queue counts on every page
   are SPEED-1's (PR #72), styled once. The proof refuses raw ids anywhere on the page.
2. (b) Stock: optional List key `compact: 'scrollTable'` keeps a table scrolling in its panel on a phone; declared
   Lists name themselves once, count plainly, keep a one-line toolbar, read zeros faint (`data-zero`), badge only
   exceptions.
3. (c) Record bodies: the badge names the stepper's current step from the declared progression (the SO's first step
   is "Draft"); one Linked documents panel; one document sheet; Details lists what the record holds (eight, the rest
   under More details); empty charge rows hidden; `print.currency` reads "Total CAD"; PO lines' three-way match in
   their details; breadcrumbs area / List / record; Record actions is "…"; generic records: serif title, badge beside
   it, revision for screen readers, Edit secondary, one Details heading.
4. (d) Receive: rows start with what is open (the declared fill, at open); header fields three to a row; the declared
   consequence as "After you post"; Cancel beside the one primary; the review step stays (contract). New PO: eyebrow and
   serif title, neutral Draft badge, a line's discount and tax behind its More (`disclosure: 'more'` on line fields),
   × to remove, one primary "Save draft" (ruling).
5. (e) Today: no find box (searched from the top bar, on a phone too), tile icons, a centred line under the tiles.

## Decisions

- The badge and stepper agree by construction: the badge reads the progression's current step, its last when all are
  complete, the record's state when no step applies (cancelled). A closed PO with goods to bill reads "Billing".
- ux-grammar wins: pager targets stay 44px; the save note keeps its row above Save (pinned layout).
- PO lines keep Ordered and Received (line progress names two quantity columns) and Line (it names the receive input).
- New optional keys: List `compact`, `print.currency`; each with compiler accept/refuse tests, coverage re-derived,
  release re-baselined (pre-tenant, ADR-0066).
- A sortable heading's screen-reader text is contained by its scrolling table (it widened the phone page).

## Gates

CI run 44325476363 green at `bfae71f0` (every job, the proof). Local: format, lint, scoped typecheck, touched unit tests,
the web contract and integration files, `check:app-release`. Shots: `docs/execution/evidence/look-1/` (56, from the run).

## Test it yourself

`pnpm --filter @north-star/api dev:reset`, `pnpm dev`: the avatar menu holds Switch person and Diagnostics; Stock by item
on a phone scrolls sideways in its panel; a purchase order's badge reads its step, Linked documents sit right, "Total
CAD" under the lines; Receive opens with the open quantities filled; New purchase order hides discount and tax per line.

## Filed

- Today's "To receive" rows: a row read on the landing page is SPEED-1's loader and page budget, not the look's.
- "+ Purchase order / + Sales order" on Today: a launcher declares no create actions.
- Parties block: grouping Vendor and Receive into would repeat the subtitle and a fact; no addresses exist.
- Step dates, "placed … by", the date and location subtitle, activity, bell: no source.
- Tenant record pages: the badge is the lifecycle; a patch declares no status role. Native date input kept.
- Assistant panel restyle follows AGENT-3.

```record-claim
{
  "schemaVersion": "northstar.record-claim/v1", "packet": "LOOK-1",
  "base": "1156974be082eca82ecb05135036c588502a8306", "head": "bfae71f09c22a6c84e50f1a20857a5729c4789aa",
  "changedPaths": [
    "apps/web/release/app.authored.json", "apps/web/release/app.compiled.json", "apps/web/src/component-registry.ts", "apps/web/src/document-editor.ts", "apps/web/src/ledger-styles.ts", "apps/web/src/navigation-icons.ts", "apps/web/src/surface-composition.ts", "apps/web/src/surface-launcher.ts",
    "apps/web/src/surface-runtime.ts", "apps/web/test/browser/composed-application.spec.ts", "apps/web/test/browser/customer-defaults.spec.ts", "apps/web/test/browser/inventory-documents.spec.ts", "apps/web/test/browser/inventory-warehouse-mode.spec.ts", "apps/web/test/browser/look.composed-application.spec.ts", "apps/web/test/browser/loop-scorecard.ts", "apps/web/test/browser/message-catalog.spec.ts",
    "apps/web/test/browser/meta-sales.spec.ts", "apps/web/test/browser/order-entry.spec.ts", "apps/web/test/browser/order-pages.spec.ts", "apps/web/test/browser/order-pricing.spec.ts", "apps/web/test/browser/payables.spec.ts", "apps/web/test/browser/price-list-pricing.spec.ts", "apps/web/test/browser/purchase-approvals.spec.ts", "apps/web/test/browser/purchase-pricing.spec.ts",
    "apps/web/test/browser/receivables-counter-sale.spec.ts", "apps/web/test/browser/receiving.composed-application.spec.ts", "apps/web/test/browser/sale-fulfillment.composed-application.spec.ts", "apps/web/test/browser/sales-order.composed-application.spec.ts", "apps/web/test/browser/surface-data-binding.spec.ts", "packages/canonical-model/src/schemas.ts", "packages/canonical-model/src/surface-composition.ts", "packages/domain/src/app/order-entry.ts",
    "packages/domain/src/app/today.ts", "packages/domain/src/purchasing/workspace.ts", "packages/domain/src/sales/workspace.ts", "test/fixtures/g2/language-conformance/coverage-decisions.json", "test/integration/surface-data-binding.test.ts", "test/unit/canonical-model/surface-composition.test.ts", "test/unit/workspace-contract.test.ts"
  ],
  "symbols": [
    {"path": "apps/web/src/surface-composition.ts", "name": "badgeStep"}, {"path": "apps/web/src/surface-composition.ts", "name": "prefilledRows"},
    {"path": "apps/web/src/navigation-icons.ts", "name": "declaredIcon"}, {"path": "apps/web/src/component-registry.ts", "name": "navigationGroupLabel"}
  ]
}
```
