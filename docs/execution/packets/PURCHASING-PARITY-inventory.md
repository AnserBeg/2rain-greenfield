# PURCHASING-PARITY — parity inventory (supporting artifact)

Reference: PaneFlow `d057daff`, own disposable copy (`/home/rvham/paneflow-sales-parity-d057daff`),
read from source (`app/inventory-app.tsx`, `app/components/*`, `lib/server/*`, `db/schema.ts`); the
original checkout and port 3000 are untouched. Rain: `packet/PURCHASING-PARITY`, stacked on
`packet/SALES-PARITY`. Status: MATCHED · PARTIAL · MISSING · BLOCKED · NOT IN REFERENCE · RAIN-ONLY ·
PROVIDER. Audit of 2026-09-29 (read-only, code evidence only); a status moves only with a slice.

## A. Purchasing

| id | reference | Rain | status | slice / home |
|---|---|---|---|---|
| P1 numbering | PO-, RCV-, VRT-, VB-, DSD- sequences | PO- (SALES-PARITY) and RCV- assigned by the server; vendor returns, bills and drop-ship deliveries do not exist | MATCHED for what exists | 1 |
| P2 draft composer | vendor + product quick-create, expected date, lines | draft editor, vendor limited to active suppliers, "New vendor"/"New product" | MATCHED | — |
| P3 vendor & cost defaults | vendor sets currency, terms, due date; expected +14 days | vendor sets currency, terms and tax code; expected date starts 14 days out | MATCHED (cost defaults: later) | 1 |
| P4 terms & totals | terms, discount %, tax code/rate, freight and fee (taxed), totals | terms, line discount %, frozen tax per line, freight and other fee with codes, exact totals (commercial read model) | MATCHED under ruling B (no FX, no deposit) | 1 |
| P5 approval | submit → approve/reject, approval queue | Release only | MISSING | own packet (approval request; no new PO state) |
| P6 place order | "Mark as ordered" + supplier reference; receiving locked until then | Release opens receiving | MISSING | with P5 |
| P7 amend | revision + re-approval | amendment request (quantity, floor = received) | PARTIAL | with P5 |
| P8 cancel | refused once receipts exist; reason | allowed after receipts: it is the only way to end a partly received order | PARTIAL | slice 4 (with P9) |
| P9 short-close / reopen | close N open units with a reason | close only with nothing open; order-level reopen | PARTIAL | slice 4 |
| P10 list | stage tabs, received/open/total/late columns | views by state, currency filter, CSV | PARTIAL | slice 3 |
| P11 expected receipts | open-to-receive worklist, late filter | receiving section per order only | MISSING | slice 3 |
| P12 receipt entry | multi-line truck receipt | one line per task, or the manual receipt form | PARTIAL | later (UI vocabulary) |
| P13 receipt paperwork | received-on date, packing slip, notes | posted "now", fixed reason | MISSING | slice 2 |
| P14 default location | preferred bin / receiving location | required input, no default | MISSING | slice 2 |
| P15-P16 quarantine split, over-receipt tolerance | yes | none; over-receipt refused | MISSING / PARTIAL (stricter) | later |
| P17 receipt cost | PO cost becomes inventory value | actual cost or explicit absence per receipt line | RAIN-ONLY | — |
| P18 reversal | one-click reverse latest receipt | correction/reversal receipts entered manually | PARTIAL | later |
| P19-P20 vendor returns, drop ship | yes | none | MISSING | own packets (Critical parts) |
| P21 vendor bills & three-way match | yes | none | MISSING | own packet (payables) |
| P22 progress panel | record progression + next action | lines, receipts, receiving section | PARTIAL | later |
| P23 print | server PDF | browser print with priced lines and totals | MATCHED under ruling G | 1 |
| P24-P25 merge drafts, PDF import | yes | none | MISSING (low) | — |
| P26 exceptions & alerts | late "!" column, bell | none | MISSING | slice 3 (late) |
| P27 permissions | per role | per operation | MATCHED (mechanism) | — |
| P28 email, QBO, R2 | yes | — | PROVIDER | out of scope |

## B. Inventory (next packet; recorded here so the gap is not lost)

Stock view with availability (I1) PARTIAL; product detail (I3) PARTIAL; item inventory fields, reorder
rules and buying worklist (I4-I7) MISSING; movements list (I8) PARTIAL; location hierarchy and status
(I9-I10) PARTIAL/MISSING; transfers (I11) MISSING with the kernel's `postTransfer` present but no route;
adjustments (I12-I13) PARTIAL; counts (I14) PARTIAL (`postStockCount` present, no route); opening stock
(I15) MISSING; lot/serial, valuation, units of measure (I17-I19) MISSING (Critical dimension work);
period locks (I20) and negative stock (I21) MATCHED; warehouse mode (I22) PARTIAL; exports (I25) MATCHED.

## Root-cause groups

1. No approval workflow (P5-P7, P16; count/adjustment approvals). 2. Posting routes the kernel has but
no screen reaches (transfers, counts, opening). 3. Stock is item × location only. 4. No commercial
detail on purchase orders — closed by slice 1. 5. No supply/demand view (P10, P11, P26, I1). 6. No
payables. 7. Missing cross-module flows (returns, drop ship). 8. No cost or unit model. 9. UI patterns
(multi-line task, progress panel, warehouse mode). 10. Providers (out of scope).

Reference quirks not copied: the Closed stage waits on QBO; incoming stock is company-wide because POs
carry no warehouse; scan components and server CSV exports are unreachable from any screen.
