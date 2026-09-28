# SALES-PARITY — parity inventory (supporting artifact)

Reference: PaneFlow `d057daff`, own disposable copy on 127.0.0.1:3311 with its distributor seed
(1,299 orders; one incompatible crate unit-conversion row skipped), local developer (administrator),
provider settings empty. Rain: `packet/SALES-PARITY` fixture `--distributor --order-volume=N`.
Viewports 1280×800 and 390×844, Chromium, en-US. Earlier audit (35e3eaa1/d9eca60a) reused where its
state is unchanged; entries re-observed here say so. Status: MATCHED · PARTIAL · MISSING · BLOCKED ·
NOT OBSERVED · NOT IN REFERENCE (not built) · RAIN-ONLY.

## B. Shared List (slice 1 — built)

| id | reference (observed) | Rain before (994a7dc9) | Rain now | status |
|---|---|---|---|---|
| L1 tabs | stage tabs; counts computed in the browser over the first 100 orders, and "1299 matching records" does not follow the tab (defect) | none | declared views; one server count per view under the current search and filters | MATCHED (counts complete) |
| L2 search | server LIKE over number, customer, salesperson, project, notes ("Mahogany" → 30); its count omits notes (source) | substring over stored values; customer shown as a uuid | substring over selected fields plus the customer NAME (reference label join) | MATCHED; salesperson joins in slice 3 |
| L3 filters | "All states" menu incl. derived supply states | archived toggle | declared choice filters + views | PARTIAL: supply-state filters need slice 5 read models |
| L4 sort | header buttons with aria-sort + sort menu, server | none (uuid order) | header links with aria-sort + Sort by/Order controls, server, label sort included | MATCHED |
| L5 columns | no chooser (component unused) | none | none | NOT IN REFERENCE |
| L6 paging | First/Prev/page/Next/Last, 50 a page | Prev/Next, 100 a page | First/Previous/Page x of y/Next/Last/Go, 50 a page, past-the-end → last page | MATCHED |
| L7 row actions | Post shipment or View | title link | title link | PARTIAL → slice 5 |
| L8 bulk | none | selection bar, no actions | unchanged | NOT IN REFERENCE |
| L9 export | full-table server CSV for other lists; none for sales orders | none | whole filtered view as CSV in one bounded statement; over-limit refused | MATCHED (exceeds for sales orders) |
| L10 keyboard | Ctrl-K and "/" global search; no row keys | picker only | every tab, sort, page is a link; forms submit on Enter | PARTIAL: global search (SUP-01) is outside the List |
| L11 states | loading skeleton, "No sales order matches this filter", refresh banner | "No records yet" | view-empty vs narrowed-empty with Clear; server-rendered, so no loading state | MATCHED |
| L12 phone | table 1,073px wide scrolls sideways inside a 364px box | cards | cards; tab strip scrolls; controls in a 2-column grid; no page scroll | MATCHED (better) |
| L-reuse | shared controls on other lists | — | Purchase orders (tabs/filter/export) and Posted stock (SKU, item, location labels) | MATCHED |

## A. Sales-order workflows

| id | reference | Rain now | status | slice |
|---|---|---|---|---|
| S1 numbering | SO-000001 per tenant at draft create | SO-/PO-/SHP- assigned on create, not typed, never reused (3e718be9) | MATCHED | 2 |
| S2 create/edit/save/reopen | modal composer, one POST | draft editor, sequential save (audit, d9eca60a) | MATCHED | — |
| S3 customer select/create | combobox, "+ New customer" | in-place combobox, eligibility, quick create (review2, d9eca60a) | MATCHED | — |
| S4 customer defaults | currency, terms, ship-to from customer | none | MISSING | 3 |
| S5 salesperson | required select | none | MISSING | 3 |
| S6 ship-to / address book | block + saved addresses (Google autocomplete: provider) | none | MISSING (autocomplete REMAINDER) | 3 |
| S7 requested date | today + 21 days default | optional instant | PARTIAL | 3 |
| S8 terms / due date | Net N from requested date | none | MISSING (ruled: due on invoice) | 3/7 |
| S9 currency / FX | CAD/USD/EUR, rate for non-CAD | CAD/USD/EUR choice | MATCHED under ruling B (no FX) | — |
| S10 product lines | type-ahead with price/availability | picker with SKU/unit | PARTIAL | 4 |
| S11 prices | contract list, then catalog | none | MISSING | 4 |
| S12 discount/tax/charges/totals | line %, tax codes, freight/fees, server totals | unit price only | MISSING | 4 |
| S13 confirm | Confirm (reason required though labelled optional: defect) | Release | PARTIAL (label per ruling F) | 5 |
| S14 cancel | draft cancel; confirmed cancel has no button | draft + released cancel | MATCHED | — |
| S15 close/reopen | none | Close; no Reopen | PARTIAL (Reopen per ruling F) | 5 |
| S16 reserve / release | one dialog per line; release/reallocate not reachable | reserve task, release remainder | MATCHED | — |
| S17 partial shipment + carrier/tracking | carrier + tracking or BOL required | ship task, quantity only | PARTIAL | 5 |
| S18 shipment correction | not reachable in UI | correction/reversal (SALE-FULFILLMENT) | RAIN-ONLY | — |
| S19 customer returns | RMA into usable/quarantine/damaged | none | MISSING (Critical arm owed) | 5 |
| S20 invoice / credit / payment | internal records; Collect/Closed depend on QuickBooks (Closed tab empty with 1,216 invoices) | none | MISSING; QuickBooks/Helcim REMAINDER | 7 |
| S21 print / PDF | server PDF for confirmed orders | packing document only | MISSING | 6 |
| S22 related documents | Record progression panel | order detail child datasets | PARTIAL | 5 |
| S23 history | audit under Reports only | change documents, no timeline | PARTIAL (activity slot unregistered) | filed |
| S24 exceptions | shortage banner, "!" column | quantities only | MISSING | 5 |
| S25 restricted role | viewer sees no create | create offered only when it may start (d9eca60a) | MATCHED | — |

## Root-cause groups

1. Missing List vocabulary (tabs, sort, filters, labels, export) — closed by slice 1 (general, declared).
2. Missing document numbering capability — slice 2.
3. Missing commercial master data (salesperson, addresses, defaults, terms) — slice 3.
4. Missing pricing/tax/totals capabilities (Q2 families) — slice 4.
5. Lifecycle and physical gaps (Confirm label, Reopen, carrier/tracking, returns, exceptions) — slice 5.
6. Missing document output (printable order) — slice 6 (documents substrate, N2 family).
7. Missing receivables (invoice, credit, payment) — slice 7; providers are REMAINDER.

Reference defects not copied: tab counts over the first 100 records; search count omitting notes;
"optional" confirm note that is required; Closed/Collect gated on QuickBooks sync.
