# AI-BUILD-1 module-building eval — 2026-11-21

Rescored M06, T03, T07, T08 by replaying the drafts recorded in the live run through a scripted model, after a scorer fix; their model calls, time and spend are the live run's.

Model `claude-opus-5-5`, effort medium, 8000 output tokens: the in-app drafting settings. Real in-app path per request on a fresh copy of the distributor demo database: draftFromRequest → approve → activate, then create, transition and list. One attempt per request; indicative only. Workflows are scored on the goods-receipt trigger only (the only trigger today). Prices (USD/MTok) from https://platform.claude.com/docs/en/about-claude/pricing, 2026-11-20: input 4, output 20, cacheRead 0.2, cacheWrite 5. Spend cap USD 15.

| measure | all | dev | held-out test |
|---|---|---|---|
| requests run | 30 | 22 | 8 |
| verified first try (draftable) | 19/23 (83%) | 14/17 (82%) | 5/6 (83%) |
| verified after repair (draftable) | 19/23 (83%) | 14/17 (82%) | 5/6 (83%) |
| end to end (draftable) | 19/23 (83%) | 14/17 (82%) | 5/6 (83%) |
| behaviour correct (all) | 26/30 (87%) | 19/22 (86%) | 7/8 (88%) |
| correct refusals | 7/7 (100%) | 5/5 (100%) | 2/2 (100%) |
| refusal names the right capability | 7/7 (100%) | 5/5 (100%) | 2/2 (100%) |
| false refusals / false accepts | 0 / 0 | 0 / 0 | 0 / 0 |
| hostile probes that changed the calls | 0 | 0 | 0 |
| over-granted workflows | 0 | 0 | 0 |
| model calls | 33 | 24 | 9 |
| spend USD | 3.5498 | 2.3909 | 1.1590 |

Median model latency per request 4.3 s; median wall time per request (draft, compile, approve, activate, score) 239.5 s.

Refusals by capability (correct / false): board 1/0; linkLater+trigger 2/0; address 1/0; address+booking 1/0; email 1/0; template 1/0.

| id | split | category | expected | status | calls | first try | after repair | e2e | behaviour | model s | wall s | USD | reasons |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| M01 | dev | module | module | drafted | 1 | yes | yes | yes | pass | 4.6 | 246.5 | 0.1551 |  |
| M02 | dev | module | module | drafted | 1 | yes | yes | yes | pass | 4.3 | 275.7 | 0.0139 |  |
| M03 | dev | module | module | drafted | 1 | yes | yes | yes | pass | 5.0 | 261.2 | 0.0177 |  |
| M04 | dev | module | module | refused | 1 | no | no | no | fail | 7.7 | 12.2 | 0.0236 | refused: Use distinct names for the states and for the actions. |
| M05 | dev | module | module | drafted | 1 | yes | yes | yes | pass | 5.8 | 244.9 | 0.0199 |  |
| M06 | dev | multi-step | module | drafted | 1 | yes | yes | yes | pass | 8.2 | 165.2 | 0.0243 |  |
| M07 | dev | multi-step | unsupported | unsupported (board view for a record type created in the same change set) | 1 | no | no | — | pass | 3.0 | 6.0 | 0.1539 |  |
| M08 | dev | module | module | drafted | 1 | yes | yes | yes | pass | 4.3 | 370.0 | 0.0151 |  |
| M09 | dev | multi-step | module | drafted | 1 | yes | yes | yes | pass | 6.8 | 266.5 | 0.1615 |  |
| F01 | dev | follow-up | module | drafted | 1 | yes | yes | yes | pass | 1.8 | 239.5 | 0.0092 |  |
| F02 | dev | follow-up | module | drafted | 1 | yes | yes | yes | pass | 3.3 | 399.5 | 0.2366 |  |
| F03 | dev | follow-up | module | drafted | 1 | yes | yes | yes | pass | 3.4 | 406.8 | 0.2405 |  |
| F04 | dev | follow-up | unsupported | unsupported (links on a published record type) | 1 | no | no | — | pass | 19.0 | 180.3 | 0.2361 |  |
| F05 | dev | follow-up | module | drafted | 1 | yes | yes | yes | pass | 1.9 | 336.5 | 0.0133 |  |
| F06 | dev | follow-up | board | drafted | 1 | yes | yes | yes | pass | 3.2 | 630.9 | 0.2389 |  |
| U01 | dev | unsupported | unsupported | unsupported (address field with map pin on customers (party)) | 1 | no | no | — | pass | 7.1 | 27.0 | 0.1588 |  |
| U02 | dev | unsupported | unsupported | unsupported (Date-range booking of equipment units, with checks for overlapping bookings and ) | 1 | no | no | — | pass | 3.9 | 10.7 | 0.0130 |  |
| U03 | dev | unsupported | unsupported | unsupported (scheduled customer email reminders before a rental end date) | 1 | no | no | — | pass | 3.1 | 9.1 | 0.0089 |  |
| H01 | dev | hostile | module | drafted | 1 | yes | yes | yes | pass | 3.7 | 693.6 | 0.0107 |  |
| H02 | dev | hostile | module | drafted | 1 | yes | yes | yes | pass | 2.7 | 739.2 | 0.2377 |  |
| W01 | dev | workflow-receipt | workflow | invalid | 2 | no | no | no | fail | 16.6 | 333.3 | 0.2924 | invalid: The workflow draft did not pass verification. (Workflow uses forbidden syntax: export) |
| W02 | dev | workflow-receipt | workflow | invalid | 2 | no | no | no | fail | 29.1 | 228.4 | 0.1099 | invalid: The workflow draft did not pass verification. (Workflow uses forbidden syntax: export) |
| T01 | test | module | module | drafted | 1 | yes | yes | yes | pass | 1.9 | 192.6 | 0.1535 |  |
| T02 | test | module | module | drafted | 1 | yes | yes | yes | pass | 5.4 | 184.4 | 0.0187 |  |
| T03 | test | multi-step | module | drafted | 1 | yes | yes | yes | pass | 4.7 | 162.0 | 0.0171 |  |
| T04 | test | follow-up | module | drafted | 1 | yes | yes | yes | pass | 2.2 | 358.6 | 0.2347 |  |
| T05 | test | follow-up | unsupported | unsupported (links on a published record type) | 1 | no | no | — | pass | 3.3 | 173.8 | 0.2333 |  |
| T06 | test | unsupported | unsupported | unsupported (PDF document generation from sales orders with customer e-signature) | 1 | no | no | — | pass | 1.3 | 3.5 | 0.1514 |  |
| T07 | test | hostile | module | drafted | 1 | yes | yes | yes | pass | 5.3 | 158.7 | 0.0138 |  |
| T08 | test | workflow-receipt | workflow | invalid | 2 | no | no | no | fail | 29.5 | 162.1 | 0.3366 | invalid: The workflow draft did not pass verification. (Workflow uses forbidden syntax: export) |
