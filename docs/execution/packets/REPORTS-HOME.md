# REPORTS-HOME — receivables aging, customer accounts with a printable statement, and a Today home view

Status: executable on draft PR (see Gates) against `packet/INTEGRATION`; no merge, no deployment, no production data.
Tier: outside the Critical set — canonical List grammar, the compiler's surface floor and agent projection, the
shared List contract and gateway, the module runtime interpreter's list statement (not the posting kernel), the web
runtime and domain metadata. No posting-kernel, serializer, materializer, activation, verification, trust, migration,
RLS or grant change. Stops taken: none. Surface floor **27** (22-25 are INTEGRATION's, 26 a parallel packet's).
Base: `packet/INTEGRATION` at `8c8cfab1`. Reference: PaneFlow `d057daff` `lib/server/reports.ts` (`arAging`,
`customerStatement`, `openOrdersByCustomer`), `app/inventory-app.tsx` home (≈2035) and CRM accounts (≈3238).

## Claims

1. `surface.list.figures` sums gain (optional v6 keys): `sum: 'count'` (how many rows); `where` (rows whose own
   enumeration or text field holds a value); `age` (rows whose own date or UTC instant lies `from`..`to` whole UTC
   calendar days before the request's midnight); `currency` (rows, or their parent, in the List's one currency);
   `price` (quantity or remainder × price × (100 − discount)/100, half up to cents per row; unstated while any row
   with something to add has no statable price); `within.match` (the parent holds the listed id; the rows then
   name none). `figures.currency` declares the currencies, read one at a time (the first unless chosen);
   `figures.summary` (≤6 number figures its columns show) adds them over the whole filtered set. `list.eligibility`
   keeps rows a related entity points at (a picker's eligibility); `list.record` names the record page rows open in.
   A number figure column may read as money. Each misuse is refused by name (`surface-list.ts`).
2. The PostgreSQL list statement computes every new member in the figures' LATERAL, so count, page, cursor, export
   and a kept band read the same numbers; the summary is computed beside the count over the same FROM/WHERE, and
   is unstated where any row's figure is. Each figure row stays pinned to tenant, environment and the issued read
   scope; a parent match joins through the rows' compiled relation, pinned as every parent is.
3. The shared List contract is closed: `currency` present exactly when a sum reads one, `today` (a midnight-UTC
   instant) exactly when a sum ages, `count` adds no quantity, `price` multiplies a quantity or remainder, the rows
   or their parent match (exactly one); the answer must carry exactly the requested `figureSummary`. Currency and
   today are part of the cursor binding.
4. The gateway authorizes every field the new members read on the rows' (or parent's) list query, per request, in
   the List's company; a denial refuses the List by that query's name.
5. Web: a currency choice (never "All"), a totals strip labelled by the showing columns and the currency, rows opened
   in `list.record`; a launcher Task may bind a List query (it never asks it); its slots render tiles whatever it binds.
6. Content: **Receivables aging** (Sales; parties in one company; Current/1-30/31-60/61-90/over 90, Total owing,
   open invoices, Status; Owing and Past due tabs; totals; Statement action); **Customer accounts** (customers only;
   open orders, ordered and open units, open value, owing; All and With open orders tabs; totals); the **Customer
   account** page (party in one company: invoices with paid/credited/balance, sales orders; **Print statement**);
   **Today** (six tiles over existing List views; the landing page).

## Decisions

- D1: The reports are Lists over parties read in one company (the in-company worklist of `party_list`, as Stock by
  item is of `item_list`); figures are computed in the statement so tabs and totals are exact, not read models.
- D2: Ruling B: one currency per reading (CAD, USD, EUR; CAD first), chosen beside the search; never converted.
- D3: Aging is as of today (UTC calendar days, the List's own `before` calendar); PaneFlow's as-of date and its
  reconstruction of past balances are not built. Buckets are PaneFlow's (≤0, 1-30, 31-60, 61-90, >90).
- D4: The statement matches PaneFlow's: one customer's invoices with total, paid, credited and balance (payments
  show as Paid), as of today, printable. Payment lines, a running balance and a date range need composition grammar
  (a dataset reached through its parent's field, a running total, a period input) — filed.
- D5: "Open orders" are released orders (open until closed); open units/value are each open line's remainder.
- D6: Customer accounts keep parties with an active customer role (`eligibility`, as the customer picker does).
- D7: Today has six tiles (launcher bound 6): PaneFlow's seven less "Open warehouse demand" (a unit sum, which To
  ship already counts). Inventory risks open the Buying worklist's To buy tab. Entry is authorized by Sales orders.
- D8: Today's surface id `a_today` orders it first in Sales and makes it the landing page, as the shell's `a_home`.
- D9: The customer account page is a second record page over Party (module party, with Sales' datasets), so Party's
  own page is unchanged; the two Lists name it as their record page.
- D10: The two in-company Lists add no verification scenarios (no entity); the release appends one entry (2 total).

## Gates

- Local (no container unless said): tsc, eslint, prettier clean; release `--check` PASS; unit 251/251; compiler
  175/175; integration 257/257 + REPORTS-HOME's own; web contracts 46/46; PostgreSQL `reports-home` (see below).
- Pins moved: surfaces 113 → 117; navigation leaves 22 → 25; surface floor 21 → 27 (runtime support 21 → 27);
  verification scenarios 633 (unchanged); coverage obligations 2805 → 2832, observed 946 → 976; lineage entries
  1 → 2; suite lists gain `test/unit/reports-home.test.ts` and `test/postgres/reports-home.test.ts` (commercial job).
- Sizes: authored file 1,440,469 → 1,476,108 B; normalized 1,499,742 → 1,535,857 B (cap 2,097,152);
  compiled 6,237,235 → 12,238,368 B (two entries).

## Controls

Non-Critical, owed by the charter: `test/evidence/REPORTS-HOME.expected-red.json` — `reports-aging-from-inclusive`
and `reports-aging-to-inclusive` (claim 2, bucket bounds), `reports-aging-calendar-days` (claim 2, UTC calendar days),
`reports-figure-rows-company-scope` (claim 2, company scope), `reports-figure-one-currency` (claim 2, ruling B),
`reports-customer-eligibility` (claim 5/6, customers only).

## Test it yourself

`REPORTS-HOME-test-it-yourself.md`: §1 Today, §2 Customer accounts, §3 Receivables aging and the statement.

## Filed

- Statement payment lines, running balance and date range (composition grammar; D4).
- PaneFlow's as-of aging (reconstructing past balances from dated payments and credits; D3).
- A credit column on aging (credit limit, hold): SALES-EXTRAS' credit facts are not on this base.
- "Next requested delivery" per customer (a figure of the earliest parent date; not built).
- Figure columns are unsortable (as every figure); PaneFlow sorts aging by the oldest bucket.

Review: not owed — outside the Critical set.

```record-claim
{
  "schemaVersion": "northstar.record-claim/v1",
  "packet": "REPORTS-HOME",
  "base": "8c8cfab1c54ac1b51b4617e45f8e2f0ddd1dfa1b",
  "head": "ed6bd95153d26faa8f7b7c3b3679c32590281026",
  "changedPaths": [
    "apps/web/release/app.authored.json", "apps/web/release/app.compiled.json", "apps/web/src/component-registry.ts",
    "apps/web/src/list-declaration.ts", "apps/web/src/surface-contract.ts", "apps/web/src/surface-runtime.ts",
    "apps/web/test/browser/receivables-reports-home.spec.ts", "package.json", "packages/canonical-model/src/schemas.ts",
    "packages/canonical-model/src/surface-list.ts", "packages/compiler/src/projections.ts", "packages/domain/src/app/builder.ts",
    "packages/domain/src/app/list-declarations.ts", "packages/domain/src/app/reports-home.ts", "packages/postgres-provider/src/module-runtime-interpreter.ts",
    "packages/runtime/src/list-behavior/figures.ts", "packages/runtime/src/list-behavior/index.ts", "packages/runtime/src/list-behavior/supply.ts",
    "packages/runtime/src/request-runtime-view.ts", "packages/runtime/src/semantic-query-gateway.ts", "test/architecture/repository-hygiene.test.ts",
    "test/architecture/surface-grammar-conformance.test.ts", "test/compiler/g2-module-conformance.test.ts", "test/evidence/REPORTS-HOME.expected-red.json",
    "test/fixtures/g2/language-conformance/coverage-decisions.json", "test/helpers/reachability-producers.ts", "test/integration/surface-data-binding.test.ts",
    "test/postgres/composed-application.test.ts", "test/postgres/reports-home.test.ts", "test/unit/canonical-model/surface-list.test.ts",
    "test/unit/reports-home.test.ts"
  ],
  "symbols": [
    {"path": "apps/web/src/component-registry.ts", "name": "renderFigureSummary"},
    {"path": "packages/canonical-model/src/schemas.ts", "name": "listFigureSumWithin"},
    {"path": "packages/canonical-model/src/schemas.ts", "name": "listFigureSumRows"},
    {"path": "packages/canonical-model/src/surface-list.ts", "name": "validateSurfaceLists"},
    {"path": "packages/domain/src/app/list-declarations.ts", "name": "receivablesAgingList"},
    {"path": "packages/domain/src/app/list-declarations.ts", "name": "customerAccountList"},
    {"path": "packages/domain/src/app/reports-home.ts", "name": "customerAccountSurface"},
    {"path": "packages/domain/src/app/reports-home.ts", "name": "todaySurface"},
    {"path": "packages/postgres-provider/src/module-runtime-interpreter.ts", "name": "figureSumSql"},
    {"path": "packages/postgres-provider/src/module-runtime-interpreter.ts", "name": "supplyMatchColumn"},
    {"path": "packages/runtime/src/list-behavior/figures.ts", "name": "parseFigureSum"},
    {"path": "packages/runtime/src/list-behavior/figures.ts", "name": "SharedListSumParts"}
  ]
}
```
