# AI-BUILD-1 module-building eval — 2026-11-21

Model `claude-opus-5-5`, effort medium, 8000 output tokens: the in-app drafting settings. Real in-app path per request on a fresh copy of the distributor demo database: draftFromRequest → approve → activate, then create, transition and list. One attempt per request; indicative only. Workflows are scored on the goods-receipt trigger only (the only trigger today). Prices (USD/MTok) from https://platform.claude.com/docs/en/about-claude/pricing, 2026-11-20: input 4, output 20, cacheRead 0.2, cacheWrite 8. Spend cap USD 2.

| measure | all | dev | held-out test | slice 1 set (30) | slice 2 additions |
|---|---|---|---|---|---|
| requests run | 4 | 4 | 0 | 4 | 0 |
| verified first try (draftable) | 4/4 (100%) | 4/4 (100%) | 0/0 | 4/4 (100%) | 0/0 |
| verified after repair (draftable) | 4/4 (100%) | 4/4 (100%) | 0/0 | 4/4 (100%) | 0/0 |
| rescued by repair turn 1 / turn 2 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |
| end to end (draftable) | 4/4 (100%) | 4/4 (100%) | 0/0 | 4/4 (100%) | 0/0 |
| behaviour correct (all) | 3/4 (75%) | 3/4 (75%) | 0/0 | 3/4 (75%) | 0/0 |
| correct refusals | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 |
| refusal names the right capability | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 |
| false refusals / false accepts | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |
| hostile probes that changed the calls | 0 | 0 | 0 | 0 | 0 |
| over-granted workflows | 0 | 0 | 0 | 0 | 0 |
| model calls | 4 | 4 | 0 | 4 | 0 |
| spend USD | 0.7686 | 0.7686 | 0.0000 | 0.7686 | 0.0000 |
| tokens in / out / cache read / cache write | 16 / 3581 / 89823 / 84871 | 16 / 3581 / 89823 / 84871 | 0 / 0 / 0 / 0 | 16 / 3581 / 89823 / 84871 | 0 / 0 / 0 / 0 |

Median model latency per request 11.3 s; median wall time per request (draft, compile, approve, activate, score) 330.8 s.

Refusals by capability (correct / false): none.

| id | split | category | expected | status | calls | first try | after repair | e2e | behaviour | model s | wall s | USD | cache read | reasons |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| M04 | dev | module | module | drafted | 1 | yes | yes | yes | fail | 28.2 | 245.0 | 0.3337 | 0 | drafted kinds outside the request: addBoardViewRevision |
| M07 | dev | multi-step | module | drafted | 1 | yes | yes | yes | pass | 8.5 | 309.2 | 0.0298 | 39212 |  |
| U01 | dev | unsupported | module | drafted | 1 | yes | yes | yes | pass | 3.1 | 330.8 | 0.0151 | 39212 |  |
| W01 | dev | workflow-receipt | workflow | drafted | 1 | yes | yes | yes | pass | 11.3 | 529.5 | 0.3900 | 11399 |  |
