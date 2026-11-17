# Loop scorecard — 2026-11-17, after LOOP-1 slice 2

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
| Purchase order: create and place (1 line) | 11 | 7 | 6 | 0 | 3 | 3 | 3122 | 6441 | 3144 | done |
| Purchase order: receive in full | 5 | 5 | 1 | 0 | 1 | 2 | 2425 | 5020 | 2433 | done |
| Stock: find the item | 3 | 2 | 1 | 0 | 0 | 0 | 456 | 868 | 464 | done |
| Sales order: create and confirm (1 line) | 7 | 4 | 4 | 0 | 3 | 3 | 2404 | 5000 | 2418 | done |
| Sales order: reserve | 6 | 5 | 1 | 0 | 1 | 2 | 4218 | 8790 | 4224 | done |
| Sales order: ship | 5 | 5 | 3 | 2 | 1 | 2 | 4552 | 9590 | 4562 | done |
| Sales order: invoice and record payment | 8 | 8 | 0 | 0 | 1 | 2 | 7653 | 16006 | 7665 | done |
| **Sales side, create to shipped** | 18 | 14 | 8 | 2 | 3 | 3 | 11174 | 23380 | 11204 | total |

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

Wall and CPU are milliseconds from the browser sending the request to
its last byte arriving; CPU is this process's (the application and the
test client share it). Seconds vary between runners: compare counts.

| step | request | db transactions | db statements | wall ms | cpu ms |
| --- | --- | --- | --- | --- | --- |
| (start) | GET home | 29 | 58 | 45 | 37 |
| (start) | GET home | 124 | 250 | 759 | 694 |
| Purchase order: create and place (1 line) | GET purchase_order_list | 216 | 442 | 749 | 618 |
| Purchase order: create and place (1 line) | GET purchase_order_form | 87 | 184 | 1746 | 1707 |
| Purchase order: create and place (1 line) | POST purchase_order_form (fragment) | 39 | 84 | 275 | 268 |
| Purchase order: create and place (1 line) | POST purchase_order_form (fragment) | 61 | 122 | 287 | 265 |
| Purchase order: create and place (1 line) | POST purchase_order_form (fragment) | 55 | 115 | 284 | 273 |
| Purchase order: create and place (1 line) | POST purchase_order_form (fragment) | 34 | 77 | 64 | 54 |
| Purchase order: create and place (1 line) | POST purchase_order_form (fragment) | 34 | 77 | 65 | 43 |
| Purchase order: create and place (1 line) | POST purchase_order_form (fragment) | 36 | 78 | 59 | 41 |
| Purchase order: create and place (1 line) | POST purchase_order_form (fragment) | 37 | 78 | 158 | 160 |
| Purchase order: create and place (1 line) | POST purchase_order_form (fragment) | 48 | 103 | 277 | 114 |
| Purchase order: create and place (1 line) | POST purchase_order_form (fragment) | 40 | 86 | 133 | 140 |
| Purchase order: create and place (1 line) | POST purchase_order_form (submit) | 68 | 169 | 211 | 162 |
| Purchase order: create and place (1 line) | GET purchase_order_detail | 403 | 824 | 1813 | 1625 |
| Purchase order: create and place (1 line) | POST purchase_order_detail (task open) | 760 | 1542 | 2029 | 1730 |
| Purchase order: create and place (1 line) | POST purchase_order_detail (task prepare) | 384 | 776 | 1690 | 1524 |
| Purchase order: create and place (1 line) | POST purchase_order_detail (task confirm) | 415 | 860 | 1643 | 1468 |
| Purchase order: create and place (1 line) | GET purchase_order_detail | 405 | 824 | 1676 | 1488 |
| Purchase order: receive in full | POST purchase_order_detail (task open) | 771 | 1563 | 2022 | 1592 |
| Purchase order: receive in full | POST purchase_order_detail (task fill) | 393 | 797 | 1623 | 1419 |
| Purchase order: receive in full | POST purchase_order_detail (task prepare) | 411 | 838 | 1596 | 1432 |
| Purchase order: receive in full | POST purchase_order_detail (task confirm) | 447 | 998 | 1814 | 1533 |
| Purchase order: receive in full | GET purchase_order_detail | 403 | 824 | 1676 | 1495 |
| Stock: find the item | GET item_stock_list | 228 | 434 | 1021 | 759 |
| Stock: find the item | GET item_stock_list | 228 | 434 | 1429 | 673 |
| Sales order: create and confirm (1 line) | GET sales_order_list | 399 | 754 | 880 | 579 |
| Sales order: create and confirm (1 line) | GET sales_order_form | 87 | 184 | 1656 | 1591 |
| Sales order: create and confirm (1 line) | POST sales_order_form (fragment) | 39 | 84 | 256 | 246 |
| Sales order: create and confirm (1 line) | POST sales_order_form (fragment) | 61 | 123 | 334 | 237 |
| Sales order: create and confirm (1 line) | POST sales_order_form (fragment) | 208 | 461 | 416 | 323 |
| Sales order: create and confirm (1 line) | POST sales_order_form (fragment) | 40 | 87 | 140 | 125 |
| Sales order: create and confirm (1 line) | POST sales_order_form (fragment) | 45 | 94 | 296 | 124 |
| Sales order: create and confirm (1 line) | POST sales_order_form (fragment) | 70 | 154 | 129 | 98 |
| Sales order: create and confirm (1 line) | POST sales_order_form (submit) | 101 | 241 | 239 | 171 |
| Sales order: create and confirm (1 line) | GET sales_order_detail | 637 | 1316 | 2104 | 1706 |
| Sales order: create and confirm (1 line) | POST sales_order_detail (submit) | 717 | 1502 | 2067 | 1678 |
| Sales order: reserve | GET sales_order_detail | 675 | 1397 | 2078 | 1713 |
| Sales order: reserve | POST sales_order_detail (task open) | 1311 | 2709 | 2340 | 1704 |
| Sales order: reserve | POST sales_order_detail (task prepare) | 672 | 1391 | 1907 | 1586 |
| Sales order: reserve | POST sales_order_detail (task confirm) | 795 | 1698 | 2108 | 1741 |
| Sales order: reserve | GET sales_order_detail | 765 | 1595 | 2115 | 1814 |
| Sales order: ship | GET sales_order_detail | 765 | 1595 | 2473 | 2273 |
| Sales order: ship | POST sales_order_detail (task open) | 1482 | 3084 | 2689 | 2089 |
| Sales order: ship | POST sales_order_detail (task prepare) | 744 | 1547 | 1991 | 1650 |
| Sales order: ship | POST sales_order_detail (task confirm) | 798 | 1769 | 2122 | 1620 |
| Sales order: ship | GET sales_order_detail | 763 | 1595 | 2018 | 1785 |
| Sales order: invoice and record payment | POST sales_order_detail (task open) | 1482 | 3084 | 2439 | 1700 |
| Sales order: invoice and record payment | POST sales_order_detail (task prepare) | 744 | 1547 | 1937 | 1656 |
| Sales order: invoice and record payment | POST sales_order_detail (task confirm) | 799 | 1699 | 1962 | 1600 |
| Sales order: invoice and record payment | GET sales_order_detail | 778 | 1627 | 1988 | 1651 |
| Sales order: invoice and record payment | POST sales_order_detail (task open) | 1512 | 3148 | 2472 | 1786 |
| Sales order: invoice and record payment | POST sales_order_detail (task prepare) | 759 | 1579 | 1892 | 1568 |
| Sales order: invoice and record payment | POST sales_order_detail (task confirm) | 801 | 1695 | 1948 | 1537 |
| Sales order: invoice and record payment | GET sales_order_detail | 778 | 1627 | 1980 | 1766 |
