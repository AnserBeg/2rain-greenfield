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
| L13 money | CA$ with two decimals | stored decimals (`25`, `12.5`) | Total and Balance columns read as money (grouped, two decimals, never rounded); CSV keeps stored values | MATCHED (no symbol: the currency is its own column) |
| L-reuse | shared controls on other lists | — | Purchase orders (tabs/filter/export) and Posted stock (SKU, item, location labels) | MATCHED |

## A. Sales-order workflows

| id | reference | Rain now | status | slice |
|---|---|---|---|---|
| S1 numbering | SO-000001 per tenant at draft create | SO-/PO-/SHP- assigned on create, not typed, never reused (3e718be9) | MATCHED | 2 |
| S2 create/edit/save/reopen | modal composer, one POST | draft editor, sequential save (audit, d9eca60a) | MATCHED | — |
| S3 customer select/create | combobox, "+ New customer" | in-place combobox, eligibility, quick create (review2, d9eca60a) | MATCHED | — |
| S4 customer defaults | currency, terms, ship-to from customer | currency, terms, salesperson and default ship-to set in a customer workspace, filled in place on choosing the customer (bed8809a) | MATCHED | 3 |
| S5 salesperson | required select | a Party with an active salesperson role; optional picker offering only salespeople; List column and search (bed8809a) | MATCHED (optional per ruling E) | 3 |
| S6 ship-to / address book | block + saved addresses (Google autocomplete: provider) | per-customer address book, picker scoped to the customer, the order's own copy; Confirm and an initial shipment need a complete ship-to (bed8809a) | MATCHED (autocomplete REMAINDER) | 3 |
| S7 requested date | today + 21 days default | a new draft starts 21 days out (midnight UTC), declared as an editor default counted from today | MATCHED | 8 |
| S8 terms / due date | Net N from requested date | terms on the order, defaulted from the customer; the invoice's due date is its date plus the order's terms (ruling B) | MATCHED | 3/7 |
| S9 currency / FX | CAD/USD/EUR, rate for non-CAD | CAD/USD/EUR choice | MATCHED under ruling B (no FX) | — |
| S10 product lines | type-ahead with price/availability | picker with SKU/unit; choosing it prices the line in the order currency, takes the order's tax code and freezes its rate | MATCHED (availability shown in Fulfillment) | 4 |
| S11 prices | contract list, then catalog | item price per currency (CAD/USD/EUR); the line keeps its list price and marks a manual override; a currency change re-prices untouched lines | MATCHED under ruling B (price lists deferred) | 4 |
| S12 discount/tax/charges/totals | line %, tax codes, freight/fees, server totals | line % discount; fixed-rate tax codes frozen on each line and charge; freight and other fee with their own codes; exact half-up line amounts and order totals read by a commercial read model; printed totals | MATCHED under ruling B | 4 |
| S13 confirm | Confirm (reason required though labelled optional: defect) | Confirm, offered only with a complete ship-to (7084b983, bed8809a) | MATCHED (state reads Released: relabel needs an ADR-0066 re-baseline) | 5 |
| S14 cancel | draft cancel; confirmed cancel has no button | draft + released cancel | MATCHED | — |
| S15 close/reopen | none | Close; Reopen with confirmation, refused while an invoice counts (ruling F); Close and Cancel offered only on a confirmed order | MATCHED (exceeds) | 5/7 |
| S16 reserve / release | one dialog per line; release/reallocate not reachable | reserve task, release remainder | MATCHED | — |
| S17 partial shipment + carrier/tracking | carrier + tracking or BOL required | ship task requires carrier and tracking or BOL; the shipment keeps them and its ship-to (7084b983, bed8809a) | MATCHED | 5 |
| S18 shipment correction | not reachable in UI | correction/reversal (SALE-FULFILLMENT) | RAIN-ONLY | — |
| S19 customer returns | RMA into usable/quarantine/damaged | none | MISSING (Critical arm owed) | 5 |
| S20 invoice / credit / payment | internal records; Collect/Closed depend on QuickBooks (Closed tab empty with 1,216 invoices) | INV- invoice of the shipped, not yet invoiced quantities at the order's frozen figures (charges on the first); PAY- payment and CM- credit up to the balance; void only while unsettled; Invoices List by state; printable invoice | MATCHED under ruling C; QuickBooks/Helcim REMAINDER | 7 |
| S21 print / PDF | server PDF for confirmed orders | printable Sales and Purchase order with a Ship to block, printed or saved as PDF by the browser (7084b983, bed8809a) | MATCHED under ruling G | 6 |
| S22 related documents | Record progression panel | order detail lists its lines, reservations, shipments (open packing) and invoices (open invoice); an invoice lists its lines, payments and credits | PARTIAL: no link from an invoice back to its order | 5/7 |
| S23 history | audit under Reports only | change documents, no timeline | PARTIAL (activity slot unregistered) | filed |
| S24 exceptions | shortage banner, "!" column | quantities only | MISSING | 5 |
| S25 restricted role | viewer sees no create | create offered only when it may start (d9eca60a) | MATCHED | — |

## Root-cause groups

1. Missing List vocabulary (tabs, sort, filters, labels, export) — closed by slice 1 (general, declared).
2. Missing document numbering capability — slice 2.
3. Missing commercial master data (salesperson, addresses, defaults, terms) — closed by slice 3.
4. Missing pricing/tax/totals capabilities (Q2 families) — closed by slice 4 (commercial read model).
5. Lifecycle and physical gaps (Confirm label, Reopen, carrier/tracking, returns, exceptions) — slice 5 (Confirm, Reopen, carrier/tracking closed in 5a).
6. Missing document output (printable order) — closed by slice 6.
7. Missing receivables (invoice, credit, payment) — closed by slice 7 (receivables capability); providers are REMAINDER.

Reference defects not copied: tab counts over the first 100 records; search count omitting notes;
"optional" confirm note that is required; Closed/Collect gated on QuickBooks sync.
