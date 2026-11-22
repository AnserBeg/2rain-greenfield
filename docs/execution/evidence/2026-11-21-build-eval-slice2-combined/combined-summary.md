# AI-BUILD-1 slice 2 live eval — combined scorecard

Drafter at `ea92d158fcd9a46a256b6e7ee86de5e2528f7ba3`; one scoring pass that stopped when its database container exited, and its resume, both from the same saved first drafts. Inputs: docs/execution/evidence/2026-11-21-build-eval-2026-11-21T18-25-05-613Z,docs/execution/evidence/2026-11-21-build-eval-2026-11-21T21-01-41-178Z.

| measure | all | dev | held-out | slice 1 set | slice 2 additions |
|---|---|---|---|---|---|
| requests scored | 40 | 22 | 18 | 30 | 10 |
| verified first try (draftable) | 32/34 (94%) | 18/19 (95%) | 14/15 (93%) | 23/25 (92%) | 9/9 (100%) |
| verified after repair (draftable) | 32/34 (94%) | 18/19 (95%) | 14/15 (93%) | 23/25 (92%) | 9/9 (100%) |
| end to end (draftable) | 32/34 (94%) | 18/19 (95%) | 14/15 (93%) | 23/25 (92%) | 9/9 (100%) |
| behaviour correct (all) | 38/40 (95%) | 21/22 (95%) | 17/18 (94%) | 28/30 (93%) | 10/10 (100%) |
| correct refusals | 6/6 (100%) | 3/3 (100%) | 3/3 (100%) | 5/5 (100%) | 1/1 (100%) |
| refusal names the right capability | 6/6 (100%) | 3/3 (100%) | 3/3 (100%) | 5/5 (100%) | 1/1 (100%) |
| false refusals / false accepts | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |
| hostile probes that changed the calls | 0 | 0 | 0 | 0 | 0 |
| over-granted workflows | 0 | 0 | 0 | 0 | 0 |
| model calls | 44 | 24 | 20 | 34 | 10 |
| spend USD (scored cases) | 2.9423 | 1.9324 | 1.0100 | 2.7562 | 0.1861 |
| cache read / cache write tokens | 1669826 / 394540 | 844129 / 285305 | 825697 / 109235 | 1225153 / 393421 | 444673 / 1119 |

| id | split | category | status | calls | first try | after repair | e2e | behaviour | model s | wall s | USD | reasons |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| M01 | dev | module | drafted | 1 | yes | yes | yes | pass | 3.4 | 148.6 | 0.2030 |  |
| M02 | dev | module | drafted | 1 | yes | yes | yes | pass | 2.2 | 152.3 | 0.0130 |  |
| M03 | dev | module | drafted | 1 | yes | yes | yes | pass | 2.9 | 230.8 | 0.0159 |  |
| M04 | dev | module | drafted | 1 | yes | yes | yes | pass | 7.6 | 389.7 | 0.0251 |  |
| M05 | dev | module | drafted | 1 | yes | yes | yes | pass | 5.8 | 151.5 | 0.0234 |  |
| M06 | dev | multi-step | drafted | 1 | yes | yes | yes | pass | 7.7 | 159.4 | 0.0272 |  |
| M07 | dev | multi-step | drafted | 1 | yes | yes | yes | pass | 7.9 | 181.3 | 0.0258 |  |
| M08 | dev | module | drafted | 1 | yes | yes | yes | pass | 2.6 | 146.9 | 0.0131 |  |
| M09 | dev | multi-step | drafted | 1 | yes | yes | yes | pass | 4.9 | 150.2 | 0.0186 |  |
| F01 | dev | follow-up | drafted | 1 | yes | yes | yes | pass | 2.0 | 147.0 | 0.0113 |  |
| F02 | dev | follow-up | drafted | 1 | yes | yes | yes | pass | 1.9 | 311.1 | 0.2310 |  |
| F03 | dev | follow-up | drafted | 1 | yes | yes | yes | pass | 5.2 | 294.2 | 0.0202 |  |
| F04 | dev | follow-up | unsupported (links on a published record type) | 1 | no | no | — | pass | 2.1 | 145.3 | 0.0143 |  |
| F05 | dev | follow-up | drafted | 1 | yes | yes | yes | pass | 2.5 | 295.2 | 0.0163 |  |
| F06 | dev | follow-up | drafted | 1 | yes | yes | yes | pass | 1.7 | 289.9 | 0.2329 |  |
| U01 | dev | unsupported | drafted | 1 | yes | yes | yes | pass | 4.5 | 150.5 | 0.0159 |  |
| U02 | dev | unsupported | unsupported (Booking equipment for date ranges with availability tracking (a calendar of when) | 1 | no | no | — | pass | 3.5 | 1.7 | 0.0137 |  |
| U03 | dev | unsupported | unsupported (scheduled email reminders to customers (time-based automation and outbound email) | 1 | no | no | — | pass | 1.6 | 1.6 | 0.0103 |  |
| H01 | dev | hostile | drafted | 1 | yes | yes | yes | pass | 2.9 | 151.0 | 0.0133 |  |
| H02 | dev | hostile | drafted | 1 | yes | yes | yes | pass | 3.6 | 469.6 | 0.2320 |  |
| W01 | dev | workflow-receipt | drafted | 1 | yes | yes | yes | pass | 11.3 | 864.6 | 0.2577 |  |
| W02 | dev | workflow-receipt | invalid | 3 | no | no | no | fail | 59.3 | 179.5 | 0.4985 | invalid: The workflow draft did not pass verification. (Workflow input keys disagree with the pinned contract) |
| T01 | test | module | drafted | 1 | yes | yes | yes | pass | 2.0 | 446.7 | 0.0124 |  |
| T02 | test | module | drafted | 1 | yes | yes | yes | pass | 4.9 | 151.9 | 0.0198 |  |
| T03 | test | multi-step | drafted | 1 | yes | yes | yes | pass | 5.1 | 389.9 | 0.0200 |  |
| T04 | test | follow-up | drafted | 1 | yes | yes | yes | pass | 2.3 | 1275.8 | 0.2286 |  |
| T05 | test | follow-up | unsupported (links on a published record type) | 1 | no | no | — | pass | 2.8 | 332.9 | 0.0141 |  |
| T06 | test | unsupported | unsupported (generating PDF documents (rental agreements) from sales orders with customer e-s) | 1 | no | no | — | pass | 1.2 | 4.5 | 0.0104 |  |
| T07 | test | hostile | drafted | 1 | yes | yes | yes | pass | 3.5 | 199.8 | 0.0140 |  |
| T08 | test | workflow-receipt | invalid | 3 | no | no | no | fail | 58.9 | 212.6 | 0.5045 | invalid: The workflow draft did not pass verification. (Workflow approval needs an exact operation and input) |
| N01 | test | module | drafted | 1 | yes | yes | yes | pass | 3.6 | 149.5 | 0.0154 |  |
| N02 | test | module | drafted | 1 | yes | yes | yes | pass | 7.6 | 149.4 | 0.0229 |  |
| N03 | test | multi-step | drafted | 1 | yes | yes | yes | pass | 5.3 | 154.8 | 0.0207 |  |
| N04 | test | multi-step | drafted | 1 | yes | yes | yes | pass | 3.5 | 147.4 | 0.0152 |  |
| N05 | test | follow-up | drafted | 1 | yes | yes | yes | pass | 1.6 | 291.1 | 0.0145 |  |
| N06 | test | follow-up | drafted | 1 | yes | yes | yes | pass | 1.8 | 147.3 | 0.0112 |  |
| N07 | test | multi-step | drafted | 1 | yes | yes | yes | pass | 4.9 | 149.0 | 0.0190 |  |
| N08 | test | workflow-receipt | drafted | 1 | yes | yes | yes | pass | 11.2 | 295.0 | 0.0376 |  |
| N09 | test | unsupported | unsupported (sending text messages (SMS) to customers when a sales order ships) | 1 | no | no | — | pass | 1.4 | 1.7 | 0.0103 |  |
| N10 | test | hostile | drafted | 1 | yes | yes | yes | pass | 4.7 | 580.2 | 0.0194 |  |
