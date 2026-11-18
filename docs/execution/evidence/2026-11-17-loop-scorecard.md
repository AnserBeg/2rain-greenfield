# Loop scorecard — 2026-11-17

Written by `apps/web/test/browser/loop-scorecard.composed-application.spec.ts`
(LOOP-1): fresh `distributor` seed, Chromium 1440x900, acting as Buyer,
starting each step where the last one left off. Clicks include choosing
from a drop-down or a search result; a page load is a full document
load; an invented value is one typed only to get past a required field;
raw codes are the charter patterns (`[A-Z]+_[A-Z_]+` tokens, "(UTC)",
"SELECT A PRODUCT") and developer sentences are the plan's, each counted
once per step.

| step | clicks | page loads | typed fields | invented values | raw codes | developer sentences | db transactions | db statements | pg_stat transactions | result |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Purchase order: create and place (1 line) | 11 | 7 | 6 | 0 | 3 | 3 | 3122 | 6442 | 3144 | done |
| Purchase order: receive in full | 5 | 5 | 1 | 0 | 1 | 2 | 2423 | 5020 | 2433 | done |
| Stock: find the item | 3 | 2 | 1 | 0 | 0 | 0 | 456 | 868 | 462 | done |
| Sales order: create and confirm (1 line) | 7 | 4 | 4 | 0 | 3 | 3 | 2374 | 4953 | 2394 | done |
| Sales order: reserve | 6 | 5 | 1 | 0 | 1 | 2 | 4142 | 8668 | 4152 | done |
| Sales order: ship | 5 | 5 | 3 | 2 | 1 | 2 | 4480 | 9470 | 4490 | done |
| Sales order: invoice and record payment | 9 | 9 | 2 | 1 | 1 | 2 | 5298 | 11164 | 5310 | done, through the invoice page |
| **Sales side, create to shipped** | 18 | 14 | 8 | 2 | 3 | 3 | 10996 | 23091 | 11036 | total |

Database work: `db transactions` and `db statements` are counted in the
test process, at the application's PostgreSQL client, for every page and
fragment request of the step (a statement outside BEGIN … COMMIT is its
own transaction; BEGIN, COMMIT and ROLLBACK are not counted as
statements). `pg_stat transactions` is the database's own count
(`xact_commit + xact_rollback` in `pg_stat_database`) across the whole
step, read after its statistics settle, less the reads themselves; it
also counts work outside a request (background and seed tails).

## Raw codes and developer sentences seen

- Purchase order: create and place (1 line): `(UTC)`, `SELECT A PRODUCT`, `COMPOSITION_CHILD_EMPTY`, `Save commits the header`, `No child records`, `required parent selection`
- Purchase order: receive in full: `COMPOSITION_CHILD_EMPTY`, `No child records`, `required parent selection`
- Sales order: create and confirm (1 line): `(UTC)`, `SELECT A PRODUCT`, `COMPOSITION_CHILD_EMPTY`, `Save commits the header`, `No child records`, `required parent selection`
- Sales order: reserve: `COMPOSITION_CHILD_EMPTY`, `No child records`, `required parent selection`
- Sales order: ship: `COMPOSITION_CHILD_EMPTY`, `No child records`, `required parent selection`
- Sales order: invoice and record payment: `COMPOSITION_CHILD_EMPTY`, `No child records`, `required parent selection`

## Database work per request

| step | request | db transactions | db statements |
| --- | --- | --- | --- |
| (start) | GET home | 29 | 58 |
| (start) | GET home | 124 | 250 |
| Purchase order: create and place (1 line) | GET purchase_order_list | 216 | 442 |
| Purchase order: create and place (1 line) | GET purchase_order_form | 87 | 184 |
| Purchase order: create and place (1 line) | POST purchase_order_form (fragment) | 39 | 83 |
| Purchase order: create and place (1 line) | POST purchase_order_form (fragment) | 61 | 122 |
| Purchase order: create and place (1 line) | POST purchase_order_form (fragment) | 55 | 115 |
| Purchase order: create and place (1 line) | POST purchase_order_form (fragment) | 34 | 79 |
| Purchase order: create and place (1 line) | POST purchase_order_form (fragment) | 34 | 77 |
| Purchase order: create and place (1 line) | POST purchase_order_form (fragment) | 34 | 78 |
| Purchase order: create and place (1 line) | POST purchase_order_form (fragment) | 40 | 87 |
| Purchase order: create and place (1 line) | POST purchase_order_form (fragment) | 43 | 94 |
| Purchase order: create and place (1 line) | POST purchase_order_form (fragment) | 40 | 86 |
| Purchase order: create and place (1 line) | POST purchase_order_form (submit) | 66 | 169 |
| Purchase order: create and place (1 line) | GET purchase_order_detail | 405 | 824 |
| Purchase order: create and place (1 line) | POST purchase_order_detail (task open) | 762 | 1542 |
| Purchase order: create and place (1 line) | POST purchase_order_detail (task prepare) | 384 | 776 |
| Purchase order: create and place (1 line) | POST purchase_order_detail (task confirm) | 417 | 860 |
| Purchase order: create and place (1 line) | GET purchase_order_detail | 405 | 824 |
| Purchase order: receive in full | POST purchase_order_detail (task open) | 771 | 1563 |
| Purchase order: receive in full | POST purchase_order_detail (task fill) | 391 | 797 |
| Purchase order: receive in full | POST purchase_order_detail (task prepare) | 409 | 838 |
| Purchase order: receive in full | POST purchase_order_detail (task confirm) | 447 | 998 |
| Purchase order: receive in full | GET purchase_order_detail | 405 | 824 |
| Stock: find the item | GET item_stock_list | 228 | 434 |
| Stock: find the item | GET item_stock_list | 228 | 434 |
| Sales order: create and confirm (1 line) | GET sales_order_list | 399 | 754 |
| Sales order: create and confirm (1 line) | GET sales_order_form | 85 | 183 |
| Sales order: create and confirm (1 line) | POST sales_order_form (fragment) | 39 | 86 |
| Sales order: create and confirm (1 line) | POST sales_order_form (fragment) | 61 | 122 |
| Sales order: create and confirm (1 line) | POST sales_order_form (fragment) | 208 | 461 |
| Sales order: create and confirm (1 line) | POST sales_order_form (fragment) | 40 | 87 |
| Sales order: create and confirm (1 line) | POST sales_order_form (fragment) | 43 | 91 |
| Sales order: create and confirm (1 line) | POST sales_order_form (fragment) | 70 | 152 |
| Sales order: create and confirm (1 line) | POST sales_order_form (submit) | 97 | 239 |
| Sales order: create and confirm (1 line) | GET sales_order_detail | 627 | 1296 |
| Sales order: create and confirm (1 line) | POST sales_order_detail (submit) | 705 | 1482 |
| Sales order: reserve | GET sales_order_detail | 663 | 1377 |
| Sales order: reserve | POST sales_order_detail (task open) | 1287 | 2669 |
| Sales order: reserve | POST sales_order_detail (task prepare) | 660 | 1371 |
| Sales order: reserve | POST sales_order_detail (task confirm) | 781 | 1676 |
| Sales order: reserve | GET sales_order_detail | 751 | 1575 |
| Sales order: ship | GET sales_order_detail | 753 | 1575 |
| Sales order: ship | POST sales_order_detail (task open) | 1458 | 3044 |
| Sales order: ship | POST sales_order_detail (task prepare) | 732 | 1527 |
| Sales order: ship | POST sales_order_detail (task confirm) | 786 | 1749 |
| Sales order: ship | GET sales_order_detail | 751 | 1575 |
| Sales order: invoice and record payment | POST sales_order_detail (task open) | 1458 | 3044 |
| Sales order: invoice and record payment | POST sales_order_detail (task prepare) | 730 | 1527 |
| Sales order: invoice and record payment | POST sales_order_detail (task confirm) | 789 | 1679 |
| Sales order: invoice and record payment | GET sales_order_detail | 766 | 1607 |
| Sales order: invoice and record payment | GET customer_invoice_detail | 255 | 537 |
| Sales order: invoice and record payment | POST customer_invoice_detail (task open) | 495 | 1043 |
| Sales order: invoice and record payment | POST customer_invoice_detail (task prepare) | 255 | 537 |
| Sales order: invoice and record payment | POST customer_invoice_detail (task confirm) | 297 | 653 |
| Sales order: invoice and record payment | GET customer_invoice_detail | 253 | 537 |
