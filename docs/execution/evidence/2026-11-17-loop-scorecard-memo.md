# Loop scorecard — 2026-11-17, after LOOP-1 memo

Written by `apps/web/test/browser/loop-scorecard.composed-application.spec.ts`
(LOOP-1): fresh `distributor` seed, Chromium 1440x900, acting as Buyer,
starting each step where the last one left off. Clicks include choosing
from a drop-down or a search result; a page load is a full document
load; an invented value is one typed only to get past a required field;
raw codes are the charter patterns (`[A-Z]+_[A-Z_]+` tokens, "(UTC)",
"SELECT A PRODUCT") and developer sentences are the plan's, each counted
once per step.

| step | clicks | page loads | typed fields | invented values | raw codes | developer sentences | db xacts incl. resets | db statements | pg_stat xacts incl. resets | result |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Purchase order: create and place (1 line) | 11 | 7 | 6 | 0 | 3 | 3 | 3116 | 6441 | 3144 | done |
| Purchase order: receive in full | 5 | 5 | 1 | 0 | 1 | 2 | 2423 | 5020 | 2463 | done |
| Stock: find the item | 3 | 2 | 1 | 0 | 0 | 0 | 456 | 868 | 458 | done |
| Sales order: create and confirm (1 line) | 7 | 4 | 4 | 0 | 3 | 3 | 2400 | 4996 | 2418 | done |
| Sales order: reserve | 6 | 5 | 1 | 0 | 1 | 2 | 4212 | 8789 | 4224 | done |
| Sales order: ship | 5 | 5 | 3 | 2 | 1 | 2 | 4552 | 9588 | 4564 | done |
| Sales order: invoice and record payment | 8 | 8 | 0 | 0 | 1 | 2 | 7651 | 16006 | 7665 | done |
| **Sales side, create to shipped** | 18 | 14 | 8 | 2 | 3 | 3 | 11164 | 23373 | 11206 | total |

Database work: `db xacts incl. resets` and `db statements` are counted in
the test process at the application's PostgreSQL client for every page
and fragment request of the step. A statement outside BEGIN … COMMIT
counts as its own transaction, so the RESET ROLE / RESET ALL after each
transaction is counted too: this over-counts the BEGIN … COMMIT pairs
(SPEED-1 measured 148 pairs on a PO detail page this counts as ~405);
SPEED-1's request meter replaces it once merged. BEGIN, COMMIT and
ROLLBACK are not counted as statements. `pg_stat xacts incl. resets` is
the database's own count (`xact_commit + xact_rollback`) across the step,
read after its statistics settle, less the reads themselves; it counts
the resets the same way and work outside a request.

## Raw codes and developer sentences seen

- Purchase order: create and place (1 line): `(UTC)`, `SELECT A PRODUCT`, `COMPOSITION_CHILD_EMPTY`, `Save commits the header`, `No child records`, `required parent selection`
- Purchase order: receive in full: `COMPOSITION_CHILD_EMPTY`, `No child records`, `required parent selection`
- Sales order: create and confirm (1 line): `(UTC)`, `SELECT A PRODUCT`, `COMPOSITION_CHILD_EMPTY`, `Save commits the header`, `No child records`, `required parent selection`
- Sales order: reserve: `COMPOSITION_CHILD_EMPTY`, `No child records`, `required parent selection`
- Sales order: ship: `COMPOSITION_CHILD_EMPTY`, `No child records`, `required parent selection`
- Sales order: invoice and record payment: `COMPOSITION_CHILD_EMPTY`, `No child records`, `required parent selection`

## Database work per request

Wall and CPU are milliseconds from the browser sending the request to
its last byte arriving; CPU is this process's (the application and the
test client share it). Seconds vary between runners: compare counts.
Parses are the full parses the request caused (catalogParseCount in
packages/runtime): the operation catalog and surface manifest are reused
by a warm request; a binding is resolved once per surface per request and
the query catalog once per request.

| step | request | db xacts incl. resets | db statements | wall ms | cpu ms | parses: operation / manifest / binding / query |
| --- | --- | --- | --- | --- | --- | --- |
| (start) | GET home | 29 | 58 | 116 | 142 | 0 / 1 / 1 / 1 |
| (start) | GET home | 124 | 250 | 318 | 168 | 0 / 0 / 101 / 1 |
| Purchase order: create and place (1 line) | GET purchase_order_list | 216 | 442 | 451 | 209 | 0 / 0 / 91 / 1 |
| Purchase order: create and place (1 line) | GET purchase_order_form | 87 | 184 | 217 | 132 | 0 / 0 / 99 / 1 |
| Purchase order: create and place (1 line) | POST purchase_order_form (fragment) | 49 | 102 | 112 | 79 | 0 / 0 / 55 / 1 |
| Purchase order: create and place (1 line) | POST purchase_order_form (fragment) | 49 | 102 | 139 | 69 | 0 / 0 / 55 / 1 |
| Purchase order: create and place (1 line) | POST purchase_order_form (fragment) | 55 | 116 | 106 | 98 | 0 / 0 / 56 / 1 |
| Purchase order: create and place (1 line) | POST purchase_order_form (fragment) | 34 | 77 | 94 | 80 | 0 / 0 / 1 / 1 |
| Purchase order: create and place (1 line) | POST purchase_order_form (fragment) | 34 | 79 | 123 | 76 | 0 / 0 / 1 / 1 |
| Purchase order: create and place (1 line) | POST purchase_order_form (fragment) | 34 | 76 | 80 | 53 | 0 / 0 / 2 / 1 |
| Purchase order: create and place (1 line) | POST purchase_order_form (fragment) | 40 | 87 | 106 | 92 | 0 / 0 / 34 / 1 |
| Purchase order: create and place (1 line) | POST purchase_order_form (fragment) | 43 | 93 | 427 | 76 | 0 / 0 / 34 / 1 |
| Purchase order: create and place (1 line) | POST purchase_order_form (fragment) | 40 | 88 | 108 | 70 | 0 / 0 / 34 / 1 |
| Purchase order: create and place (1 line) | POST purchase_order_form (submit) | 68 | 169 | 184 | 76 | 0 / 0 / 49 / 1 |
| Purchase order: create and place (1 line) | GET purchase_order_detail | 403 | 824 | 593 | 234 | 0 / 0 / 94 / 1 |
| Purchase order: create and place (1 line) | POST purchase_order_detail (task open) | 762 | 1542 | 1025 | 326 | 0 / 0 / 74 / 1 |
| Purchase order: create and place (1 line) | POST purchase_order_detail (task prepare) | 382 | 776 | 592 | 188 | 0 / 0 / 74 / 1 |
| Purchase order: create and place (1 line) | POST purchase_order_detail (task confirm) | 417 | 860 | 631 | 193 | 0 / 0 / 74 / 1 |
| Purchase order: create and place (1 line) | GET purchase_order_detail | 403 | 824 | 581 | 187 | 0 / 0 / 94 / 1 |
| Purchase order: receive in full | POST purchase_order_detail (task open) | 771 | 1563 | 1096 | 340 | 0 / 0 / 74 / 1 |
| Purchase order: receive in full | POST purchase_order_detail (task fill) | 391 | 797 | 584 | 180 | 0 / 0 / 74 / 1 |
| Purchase order: receive in full | POST purchase_order_detail (task prepare) | 409 | 838 | 615 | 182 | 0 / 0 / 74 / 1 |
| Purchase order: receive in full | POST purchase_order_detail (task confirm) | 447 | 998 | 830 | 239 | 0 / 0 / 74 / 1 |
| Purchase order: receive in full | GET purchase_order_detail | 405 | 824 | 591 | 179 | 0 / 0 / 94 / 1 |
| Stock: find the item | GET item_stock_list | 228 | 434 | 630 | 146 | 0 / 0 / 69 / 1 |
| Stock: find the item | GET item_stock_list | 228 | 434 | 1706 | 125 | 0 / 0 / 69 / 1 |
| Sales order: create and confirm (1 line) | GET sales_order_list | 399 | 754 | 773 | 199 | 0 / 0 / 101 / 1 |
| Sales order: create and confirm (1 line) | GET sales_order_form | 87 | 184 | 181 | 72 | 0 / 0 / 99 / 1 |
| Sales order: create and confirm (1 line) | POST sales_order_form (fragment) | 49 | 102 | 130 | 71 | 0 / 0 / 55 / 1 |
| Sales order: create and confirm (1 line) | POST sales_order_form (fragment) | 49 | 102 | 235 | 86 | 0 / 0 / 55 / 1 |
| Sales order: create and confirm (1 line) | POST sales_order_form (fragment) | 208 | 462 | 351 | 150 | 0 / 0 / 56 / 1 |
| Sales order: create and confirm (1 line) | POST sales_order_form (fragment) | 40 | 87 | 108 | 66 | 0 / 0 / 34 / 1 |
| Sales order: create and confirm (1 line) | POST sales_order_form (fragment) | 43 | 92 | 402 | 64 | 0 / 0 / 34 / 1 |
| Sales order: create and confirm (1 line) | POST sales_order_form (fragment) | 70 | 154 | 135 | 60 | 0 / 0 / 34 / 1 |
| Sales order: create and confirm (1 line) | POST sales_order_form (submit) | 101 | 241 | 222 | 83 | 0 / 0 / 49 / 1 |
| Sales order: create and confirm (1 line) | GET sales_order_detail | 637 | 1316 | 975 | 293 | 0 / 0 / 98 / 1 |
| Sales order: create and confirm (1 line) | POST sales_order_detail (submit) | 717 | 1502 | 1098 | 299 | 0 / 0 / 98 / 1 |
| Sales order: reserve | GET sales_order_detail | 675 | 1397 | 1091 | 302 | 0 / 0 / 98 / 1 |
| Sales order: reserve | POST sales_order_detail (task open) | 1309 | 2708 | 1902 | 509 | 0 / 0 / 74 / 1 |
| Sales order: reserve | POST sales_order_detail (task prepare) | 670 | 1391 | 957 | 280 | 0 / 0 / 74 / 1 |
| Sales order: reserve | POST sales_order_detail (task confirm) | 795 | 1698 | 1198 | 315 | 0 / 0 / 74 / 1 |
| Sales order: reserve | GET sales_order_detail | 763 | 1595 | 1104 | 297 | 0 / 0 / 98 / 1 |
| Sales order: ship | GET sales_order_detail | 765 | 1595 | 1228 | 330 | 0 / 0 / 98 / 1 |
| Sales order: ship | POST sales_order_detail (task open) | 1482 | 3084 | 2074 | 557 | 0 / 0 / 74 / 1 |
| Sales order: ship | POST sales_order_detail (task prepare) | 744 | 1547 | 1030 | 309 | 0 / 0 / 74 / 1 |
| Sales order: ship | POST sales_order_detail (task confirm) | 798 | 1769 | 1545 | 793 | 0 / 0 / 74 / 1 |
| Sales order: ship | GET sales_order_detail | 763 | 1593 | 1060 | 342 | 0 / 0 / 98 / 1 |
| Sales order: invoice and record payment | POST sales_order_detail (task open) | 1482 | 3084 | 2324 | 799 | 0 / 0 / 74 / 1 |
| Sales order: invoice and record payment | POST sales_order_detail (task prepare) | 744 | 1547 | 1163 | 327 | 0 / 0 / 74 / 1 |
| Sales order: invoice and record payment | POST sales_order_detail (task confirm) | 799 | 1699 | 1271 | 345 | 0 / 0 / 74 / 1 |
| Sales order: invoice and record payment | GET sales_order_detail | 780 | 1627 | 1144 | 325 | 0 / 0 / 98 / 1 |
| Sales order: invoice and record payment | POST sales_order_detail (task open) | 1512 | 3148 | 2163 | 772 | 0 / 0 / 74 / 1 |
| Sales order: invoice and record payment | POST sales_order_detail (task prepare) | 757 | 1579 | 1075 | 312 | 0 / 0 / 74 / 1 |
| Sales order: invoice and record payment | POST sales_order_detail (task confirm) | 799 | 1695 | 1154 | 327 | 0 / 0 / 74 / 1 |
| Sales order: invoice and record payment | GET sales_order_detail | 778 | 1627 | 1117 | 318 | 0 / 0 / 98 / 1 |
