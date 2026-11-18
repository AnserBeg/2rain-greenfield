# LOOK-1 — every screen in the Ledger look the owner chose

Status: frozen at `b89acf31` (CI green at `399de34d`, run 44262425699). Mechanical (no Critical path). Base `08260fc2`. Stops, each ruled 2026-11-17: line progress carrier
(option A), icon carrier (option A); plain names for the setup lists required (slice 4). Queue counts on every page: SPEED-1.

## Claims

1. The tokens are the spec's (`ledger-spec.md` §1, §3, §4): light, dark (media and `data-theme`), compact and
   comfortable; the stylesheet (`apps/web/src/ledger-styles.ts`) reads tokens only; no colour literal outside the block.
2. `inProgress` rides the accent hue; success, attention and blocked stay outside it (browser gate derives the band
   from the rendered `--accent`); every status keeps colour + glyph + word.
3. The shell: work queues (Today + the landing launcher's declared tiles, counts where the page read them) above the
   area groups; desktop groups always list their destinations; at 900px and below the sidebar is a drawer behind a
   native `<details>` menu button (no script); the top bar searches through the launcher's declared scan.
4. Icons come from a closed set of 20 names declared on a module, a destination's workspace and a launcher tile; an
   undeclared icon falls back to the destination's kind (launcher, list, page).
5. A record page: eyebrow, serif number, status badge with the kind its own List declares (neutral otherwise),
   subtitle; the stepper and the next-step card (one primary button, a sentence from the record's figures); the facts
   grid; per-line progress bars from a declared `presentation.progress`; the totals block from the declared print totals.

## Decisions (one line each)

- Specs in `apps/web/test/browser/`; styles in `ledger-styles.ts` behind SPEED-1's `surfaceRuntimeStyles()` seam; no `style=`.
- Desktop groups stay `<details>` with `::details-content{content-visibility:visible}`, so every nav contract holds.
- Next step: "{open} of {total} {item} still open." / "{units} units still open on {lines} lines." from the next
  Task's `rows` and per-row `fillFrom`, else "{title} is {status}."; detail "Step n of m · {step}".
- Phone targets stay ≥ 44px (ux-grammar); tiles four a row, two below 1000px; the diagnostic code stays on diagnostics.
- The header keeps its facts in its markup (specs pin it), `display:contents`, laid after the stepper by CSS `order`.
- The top bar's search is a text box; the record's other commands drop down at the header's right.
- `icon` and `presentation.progress` add language axes; the coverage decisions are re-derived for them.
- Plain names (labels only): Contacts (group), Customers and suppliers, Contact roles, Companies, Period locks, Stock
  movements, Stock by location, Stock counts, Items, Tax codes, Price lists, Locations. Re-baselines: `dev:reset`.
- The proof's screenshots come from CI (`look-evidence-<sha>`, composed browser job; owner rule 2026-11-18).

## Slices

1 tokens `0f54907e` · 2 shell and 3 record page `f01f6e2c`, `44ab99ea` · 4 lists, forms, plain names `db33d246`,
`e48ceb75` · 5 proof `apps/web/test/browser/look.composed-application.spec.ts`, shots in `docs/execution/evidence/look-1/`.

## Gates

CI run 44262425699 green at `399de34d` (every job, the proof included); `b89acf31` adds one CSS selector. Local: format,
lint, the touched unit tests, the web contract file, `check:app-release`. Screenshots: `docs/execution/evidence/look-1/`
(`app-*` from the proof on CI, `mock-*` from the mockup), 7 screens × 1440/390 × light/dark.

## Test it yourself

`pnpm --filter @north-star/api dev:reset`, `pnpm dev`, <http://127.0.0.1:4174/>: Today in the Ledger look, queues at
the top of the sidebar; walk LOOP-1's path (its record, "Test it yourself"); every page is pale paper with one teal
button; a purchase order shows its stepper, the next step sentence and button, each line's bar.

## Filed

- Stepper captions (date each step was entered; "204 of 210 in") have no source.
- To invoice queue: the sales order List holds eight views (the maximum) and no shipped-not-invoiced figure.
- Tenant record types: structural icons until the patch kinds learn `icon`; no line datasets, so no progress yet.
- Totals show no currency code: no declared currency column for the totals block.
- PO and SO badges render neutral: the record's state value does not yet match its List's declared status roles.
- The assistant panel (AGENT-3) gets the Ledger classes in a follow-up after it lands.
- Right rail (linked documents, activity): no carrier places a dataset in the shell's rail; a language change.

```record-claim
{
  "schemaVersion": "northstar.record-claim/v1", "packet": "LOOK-1",
  "base": "28dbc55a0d02e6b6c0fa9529f5d404545f1eb5b0", "head": "b89acf31dee681793484c9261c02c74c390ba252",
  "changedPaths": [
    ".github/workflows/ci.yml", "apps/web/release/app.authored.json", "apps/web/release/app.compiled.json", "apps/web/src/component-registry.ts", "apps/web/src/design-tokens.ts", "apps/web/src/ledger-styles.ts",
    "apps/web/src/surface-composition.ts", "apps/web/src/surface-contract.ts", "apps/web/src/surface-runtime.ts", "apps/web/test/browser/composed-application.spec.ts", "apps/web/test/browser/declared-list.spec.ts", "apps/web/test/browser/inventory-catalog-aliases.spec.ts",
    "apps/web/test/browser/inventory-locations.spec.ts", "apps/web/test/browser/inventory-replenishment.spec.ts", "apps/web/test/browser/inventory-warehouse-mode.spec.ts", "apps/web/test/browser/item-stock.spec.ts", "apps/web/test/browser/look.composed-application.spec.ts", "apps/web/test/browser/meta-sales.spec.ts",
    "apps/web/test/browser/surface-grammar.spec.ts", "apps/web/test/browser/table-behavior.spec.ts", "apps/web/test/surface-runtime-contract.test.ts", "packages/canonical-model/src/index.ts", "packages/canonical-model/src/schemas.ts", "packages/canonical-model/src/surface-composition.ts",
    "packages/compiler/src/projections.ts", "packages/domain/src/app/builder.ts", "packages/domain/src/app/today.ts", "packages/domain/src/purchasing/workspace.ts", "packages/domain/src/sales/workspace.ts", "test/architecture/surface-grammar-conformance.test.ts",
    "test/fixtures/g2/language-conformance/coverage-decisions.json", "test/helpers/assert-composed-inventory.ts", "test/integration/surface-data-binding.test.ts", "test/postgres/locations.test.ts", "test/unit/canonical-model/surface-composition.test.ts", "test/unit/canonical-model/surface-launcher.test.ts",
    "test/unit/purchasing-definition.test.ts", "test/unit/sales-definition.test.ts", "test/unit/web-surface-hex-literal-ratchet.test.ts", "test/unit/web-surface-hex-literal.baseline.ts"
  ],
  "symbols": [
    {"path": "apps/web/src/ledger-styles.ts", "name": "LEDGER_STYLES"}, {"path": "apps/web/src/design-tokens.ts", "name": "DESIGN_TOKENS"},
    {"path": "packages/canonical-model/src/schemas.ts", "name": "NavigationIconSchema"}, {"path": "packages/domain/src/app/builder.ts", "name": "composedDestinationIcon"}
  ]
}
```
