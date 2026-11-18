# Loop scorecard — 2026-11-18, after LOOP-1 slices 3-5

Written by `apps/web/test/browser/loop-scorecard.composed-application.spec.ts`
(LOOP-1): fresh `distributor` seed, Chromium 1440x900, acting as Buyer,
starting each step where the last one left off. Clicks include choosing
from a drop-down or a search result; a page load is a full document
load; an invented value is one typed only to get past a required field;
raw codes are the charter patterns (`[A-Z]+_[A-Z_]+` tokens, "(UTC)",
"SELECT A PRODUCT") and developer sentences are the plan's, each counted
once per step.

| step | clicks | page loads | typed fields | invented values | raw codes | developer sentences | db transactions | db statements | pg_stat xacts incl. resets | result |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Purchase order: create and place (1 line) | 11 | 7 | 5 | 0 | 1 | 0 | 1046 | 8547 | 3144 | done |
| Purchase order: receive in full | 5 | 5 | 1 | 0 | 0 | 0 | 809 | 6638 | 2433 | done |
| Stock: find the item | 3 | 2 | 1 | 0 | 0 | 0 | 152 | 1172 | 485 | done |
| Sales order: create and confirm (1 line) | 7 | 4 | 3 | 0 | 1 | 0 | 824 | 6753 | 2478 | done |
| Sales order: ship | 6 | 5 | 0 | 0 | 0 | 0 | 1412 | 11655 | 4242 | done |
| Sales order: invoice and record payment | 8 | 8 | 0 | 0 | 0 | 0 | 2393 | 19562 | 7189 | done |
| **Sales side, create to shipped** | 13 | 9 | 3 | 0 | 1 | 0 | 2236 | 18408 | 6720 | total |

Database work: `db transactions` and `db statements` are the sums of
each page and fragment request's Server-Timing counts (SPEED-1's request
meter, which counts BEGIN … COMMIT pairs, not the RESET after each).
`pg_stat xacts incl. resets` is the database's own count
(`xact_commit + xact_rollback`) across the step, read after its
statistics settle, less the reads themselves: it counts every statement
outside a transaction, the resets included, and work outside a request.

## Screens

- New purchase order: fields on the create screen: 17
- New sales order: fields on the create screen: 24

## Raw codes and developer sentences seen

- Purchase order: create and place (1 line): `(UTC)`
- Sales order: create and confirm (1 line): `(UTC)`

## Database work per request

Wall and CPU are milliseconds from the browser sending the request to
its response arriving; CPU is this process's (the application and the
test client share it). Seconds vary between runners: compare counts.
Parses are the full parses the request caused (catalogParseCount in
packages/runtime): the operation catalog and surface manifest are reused
by a warm request; a binding is resolved once per surface per request and
the query catalog once per request.

| step | request | db transactions | db statements | db authorization | db repeats | wall ms | cpu ms | parses: operation / manifest / binding / query |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| (start) | GET home | 9 | 76 | 6 | 1 | 114 | 138 | 0 / 1 / 1 / 1 |
| (start) | GET home | 56 | 446 | 47 | 39 | 385 | 163 | 0 / 0 / 48 / 1 |
| Purchase order: create and place (1 line) | GET purchase_order_list | 72 | 586 | 59 | 65 | 405 | 182 | 0 / 0 / 92 / 1 |
| Purchase order: create and place (1 line) | GET purchase_order_form | 29 | 242 | 22 | 23 | 163 | 130 | 0 / 0 / 100 / 1 |
| Purchase order: create and place (1 line) | POST purchase_order_form (fragment) | 17 | 138 | 13 | 3 | 140 | 78 | 0 / 0 / 56 / 1 |
| Purchase order: create and place (1 line) | POST purchase_order_form (fragment) | 17 | 138 | 13 | 3 | 128 | 65 | 0 / 0 / 56 / 1 |
| Purchase order: create and place (1 line) | POST purchase_order_form (fragment) | 19 | 157 | 14 | 4 | 165 | 113 | 0 / 0 / 57 / 1 |
| Purchase order: create and place (1 line) | POST purchase_order_form (fragment) | 12 | 103 | 8 | 2 | 104 | 89 | 0 / 0 / 1 / 1 |
| Purchase order: create and place (1 line) | POST purchase_order_form (fragment) | 12 | 103 | 8 | 2 | 118 | 88 | 0 / 0 / 1 / 1 |
| Purchase order: create and place (1 line) | POST purchase_order_form (fragment) | 12 | 102 | 8 | 2 | 78 | 50 | 0 / 0 / 2 / 1 |
| Purchase order: create and place (1 line) | POST purchase_order_form (fragment) | 14 | 117 | 10 | 2 | 135 | 77 | 0 / 0 / 35 / 1 |
| Purchase order: create and place (1 line) | POST purchase_order_form (fragment) | 15 | 124 | 11 | 2 | 385 | 70 | 0 / 0 / 35 / 1 |
| Purchase order: create and place (1 line) | POST purchase_order_form (fragment) | 14 | 116 | 10 | 2 | 95 | 58 | 0 / 0 / 35 / 1 |
| Purchase order: create and place (1 line) | POST purchase_order_form (submit) | 22 | 213 | 15 | 14 | 179 | 81 | 0 / 0 / 49 / 1 |
| Purchase order: create and place (1 line) | GET purchase_order_detail | 135 | 1094 | 110 | 115 | 563 | 261 | 0 / 0 / 95 / 1 |
| Purchase order: create and place (1 line) | POST purchase_order_detail (task open) | 254 | 2050 | 209 | 257 | 989 | 309 | 0 / 0 / 75 / 1 |
| Purchase order: create and place (1 line) | POST purchase_order_detail (task prepare) | 128 | 1032 | 105 | 105 | 567 | 183 | 0 / 0 / 75 / 1 |
| Purchase order: create and place (1 line) | POST purchase_order_detail (task confirm) | 139 | 1138 | 113 | 115 | 586 | 183 | 0 / 0 / 75 / 1 |
| Purchase order: create and place (1 line) | GET purchase_order_detail | 135 | 1094 | 110 | 115 | 535 | 181 | 0 / 0 / 95 / 1 |
| Purchase order: receive in full | POST purchase_order_detail (task open) | 257 | 2077 | 211 | 259 | 1064 | 323 | 0 / 0 / 75 / 1 |
| Purchase order: receive in full | POST purchase_order_detail (task fill) | 131 | 1059 | 107 | 107 | 550 | 187 | 0 / 0 / 75 / 1 |
| Purchase order: receive in full | POST purchase_order_detail (task prepare) | 137 | 1112 | 111 | 114 | 517 | 161 | 0 / 0 / 75 / 1 |
| Purchase order: receive in full | POST purchase_order_detail (task confirm) | 149 | 1296 | 119 | 128 | 947 | 347 | 0 / 0 / 75 / 1 |
| Purchase order: receive in full | GET purchase_order_detail | 135 | 1094 | 110 | 115 | 535 | 172 | 0 / 0 / 95 / 1 |
| Stock: find the item | GET item_stock_list | 76 | 586 | 67 | 62 | 599 | 134 | 0 / 0 / 70 / 1 |
| Stock: find the item | GET item_stock_list | 76 | 586 | 67 | 62 | 1674 | 116 | 0 / 0 / 70 / 1 |
| Sales order: create and confirm (1 line) | GET sales_order_list | 133 | 1020 | 119 | 122 | 744 | 175 | 0 / 0 / 102 / 1 |
| Sales order: create and confirm (1 line) | GET sales_order_form | 29 | 242 | 22 | 23 | 172 | 72 | 0 / 0 / 100 / 1 |
| Sales order: create and confirm (1 line) | POST sales_order_form (fragment) | 17 | 138 | 13 | 3 | 122 | 86 | 0 / 0 / 56 / 1 |
| Sales order: create and confirm (1 line) | POST sales_order_form (fragment) | 17 | 138 | 13 | 3 | 247 | 67 | 0 / 0 / 56 / 1 |
| Sales order: create and confirm (1 line) | POST sales_order_form (fragment) | 70 | 603 | 48 | 50 | 329 | 133 | 0 / 0 / 57 / 1 |
| Sales order: create and confirm (1 line) | POST sales_order_form (fragment) | 14 | 117 | 10 | 2 | 88 | 48 | 0 / 0 / 35 / 1 |
| Sales order: create and confirm (1 line) | POST sales_order_form (fragment) | 15 | 124 | 11 | 2 | 392 | 57 | 0 / 0 / 35 / 1 |
| Sales order: create and confirm (1 line) | POST sales_order_form (fragment) | 24 | 202 | 17 | 7 | 137 | 64 | 0 / 0 / 35 / 1 |
| Sales order: create and confirm (1 line) | POST sales_order_form (submit) | 33 | 307 | 23 | 21 | 219 | 77 | 0 / 0 / 49 / 1 |
| Sales order: create and confirm (1 line) | GET sales_order_detail | 223 | 1812 | 182 | 192 | 913 | 282 | 0 / 0 / 99 / 1 |
| Sales order: create and confirm (1 line) | POST sales_order_detail (submit) | 249 | 2050 | 201 | 224 | 962 | 286 | 0 / 0 / 99 / 1 |
| Sales order: ship | POST sales_order_detail (task open) | 449 | 3653 | 367 | 470 | 1894 | 489 | 0 / 0 / 75 / 1 |
| Sales order: ship | POST sales_order_detail (task fill) | 227 | 1847 | 185 | 196 | 896 | 252 | 0 / 0 / 75 / 1 |
| Sales order: ship | POST sales_order_detail (task prepare) | 230 | 1874 | 187 | 200 | 888 | 257 | 0 / 0 / 75 / 1 |
| Sales order: ship | POST sales_order_detail (task confirm) | 267 | 2331 | 213 | 245 | 1382 | 457 | 0 / 0 / 75 / 1 |
| Sales order: ship | GET sales_order_detail | 239 | 1950 | 194 | 212 | 915 | 271 | 0 / 0 / 99 / 1 |
| Sales order: invoice and record payment | POST sales_order_detail (task open) | 462 | 3762 | 377 | 486 | 1969 | 840 | 0 / 0 / 75 / 1 |
| Sales order: invoice and record payment | POST sales_order_detail (task prepare) | 232 | 1888 | 189 | 202 | 1054 | 576 | 0 / 0 / 75 / 1 |
| Sales order: invoice and record payment | POST sales_order_detail (task confirm) | 251 | 2078 | 203 | 218 | 1123 | 392 | 0 / 0 / 75 / 1 |
| Sales order: invoice and record payment | GET sales_order_detail | 244 | 1992 | 198 | 216 | 1078 | 319 | 0 / 0 / 99 / 1 |
| Sales order: invoice and record payment | POST sales_order_detail (task open) | 472 | 3846 | 385 | 497 | 1867 | 527 | 0 / 0 / 75 / 1 |
| Sales order: invoice and record payment | POST sales_order_detail (task prepare) | 237 | 1930 | 193 | 206 | 896 | 427 | 0 / 0 / 75 / 1 |
| Sales order: invoice and record payment | POST sales_order_detail (task confirm) | 251 | 2074 | 203 | 217 | 1021 | 321 | 0 / 0 / 75 / 1 |
| Sales order: invoice and record payment | GET sales_order_detail | 244 | 1992 | 198 | 216 | 998 | 286 | 0 / 0 / 99 / 1 |
