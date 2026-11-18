# LOOK-1 — every screen in the Ledger look the owner chose

Status: round 4 frozen at `bfd95051` (CI green, run 44342652700). Mechanical (no Critical path). Round 4 answers Fable
review 2 (`2rain-missions/look-1-fable-review-2.md`): one blocker, three majors, the cheap leftovers. Round 3 (Fable
review 1) merged in groups (a) `fb3f95ee`, (b) `eed94293`, (c)–(e) `e7a284f4` (one merge, ruled); its record is this
file at `b6098500`. Earlier: round 2 `d0d3baf7`, round 1 `5d07856a`. Claim base: main `f76da787`, merged in.

## Round 4 claims

1. N1 Receive: a Task filling its rows from one declared column shows that column (Open) as its figure; the line's
   other figures and its derived unit stay in the markup out of view; Item keeps 220px on one line. The grid reads
   Item · Open · Quantity · Unit cost.
2. N2 a record's title keeps the gutter at 390, its badge beside or just under it.
3. N3 a page with no company of its own (a tenant's record type, a shared record) keeps the company the day's work is
   in, resolved by the landing launcher's declared entry: the sidebar's head, its links and its queues stay in it.
4. N4 the editor's own header: eyebrow, "New purchase order" in the document face, the neutral Draft badge beside it;
   a form's trail ends "New" (or "Edit").
5. Leftovers: a line's supporting details sit in its product cell (no Details column); an empty dataset of the sheet
   shows nothing; More and × align; the dialog's resume panel stays out while it is open; the segmented control sizes
   to its content; the phone Receive shot is full height.

## Round 3 (summary)

Chrome (account menu, company head, one Settings, raw ids refused); Stock (`compact: 'scrollTable'`); record bodies
(badge = the stepper's step, one sheet, Linked documents, `print.currency`, area / List / record trail); Receive
prefilled with "After you post"; new PO line More and "Save draft"; Today searched from the top bar.

## Decisions

- Round 4: columns are hidden by declared role (the fill column, derived inputs), never by label; the company comes from a declared entry, never a hand list.

- The badge and stepper agree by construction: the badge reads the progression's current step, its last when all are
  complete, the record's state when no step applies (cancelled). A closed PO with goods to bill reads "Billing".
- ux-grammar wins: pager targets stay 44px; the save note keeps its row above Save (pinned layout).
- PO lines keep Ordered and Received (line progress names two quantity columns) and Line (it names the receive input).
- New optional keys: List `compact`, `print.currency`; each with compiler accept/refuse tests, coverage re-derived,
  release re-baselined (pre-tenant, ADR-0066).

## Gates

CI run 44342652700 green at `bfd95051` (every job, the proof). Local: format, lint, scoped typecheck, touched unit tests,
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
  "base": "f76da787fb684b010ea671d713b2b924d440d664", "head": "bfd95051ccbd9580d5fdc56998a21e0c34c1ab60",
  "changedPaths": [
    "apps/web/src/component-registry.ts", "apps/web/src/document-editor.ts", "apps/web/src/ledger-styles.ts", "apps/web/src/surface-composition.ts", "apps/web/src/surface-runtime.ts", "apps/web/test/browser/look.composed-application.spec.ts", "apps/web/test/browser/payables.spec.ts", "apps/web/test/browser/sales-order.composed-application.spec.ts"
  ],
  "symbols": [
    {"path": "apps/web/src/surface-runtime.ts", "name": "landingCompanyContext"}, {"path": "apps/web/src/component-registry.ts", "name": "renderBreadcrumb"}
  ]
}
```
