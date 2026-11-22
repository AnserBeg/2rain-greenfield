# AI-BUILD-1 module-building eval — 2026-11-21

Drafter at `e4d35db787fea7bbfa1552f89adf05af60d85e46`. Isolated compile bound 120 s (raised for a loaded host); prompt cache TTL 5m.

Model `claude-opus-5-5`, effort medium, 8000 output tokens: the in-app drafting settings. Real in-app path per request on a fresh copy of the distributor demo database: draftFromRequest → approve → activate, then create, transition and list. One attempt per request; indicative only. Workflows are scored on the goods-receipt trigger only (the only trigger today). Prices (USD/MTok) from https://platform.claude.com/docs/en/about-claude/pricing, 2026-11-20: input 4, output 20, cacheRead 0.2, cacheWrite 5. Spend cap USD 2.

| measure | all | dev | held-out test | slice 1 set (30) | slice 2 additions |
|---|---|---|---|---|---|
| requests run | 2 | 1 | 1 | 2 | 0 |
| verified first try (draftable) | 0/2 (0%) | 0/1 (0%) | 0/1 (0%) | 0/2 (0%) | 0/0 |
| verified after repair (draftable) | 2/2 (100%) | 1/1 (100%) | 1/1 (100%) | 2/2 (100%) | 0/0 |
| rescued by repair turn 1 / turn 2 | 2 / 0 | 1 / 0 | 1 / 0 | 2 / 0 | 0 / 0 |
| end to end (draftable) | 2/2 (100%) | 1/1 (100%) | 1/1 (100%) | 2/2 (100%) | 0/0 |
| behaviour correct (all) | 2/2 (100%) | 1/1 (100%) | 1/1 (100%) | 2/2 (100%) | 0/0 |
| correct refusals | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 |
| refusal names the right capability | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 |
| false refusals / false accepts | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |
| hostile probes that changed the calls | 0 | 0 | 0 | 0 | 0 |
| over-granted workflows | 0 | 0 | 0 | 0 | 0 |
| model calls | 4 | 2 | 2 | 4 | 0 |
| spend USD | 0.8544 | 0.4285 | 0.4260 | 0.8544 | 0.0000 |
| tokens in / out / cache read / cache write | 12 / 10889 / 113526 / 122782 | 6 / 5486 / 56763 / 61477 | 6 / 5403 / 56763 / 61305 | 12 / 10889 / 113526 / 122782 | 0 / 0 / 0 / 0 |

Median model latency per request 46.3 s; median wall time per request (draft, compile, approve, activate, score) 338.4 s.

Refusals by capability (correct / false): none.

| id | split | category | expected | status | calls | first try | after repair | e2e | behaviour | model s | wall s | USD | cache read | reasons |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| W02 | dev | workflow-receipt | workflow | drafted | 2 | no | yes | yes | pass | 46.3 | 338.4 | 0.4285 | 56763 |  |
| T08 | test | workflow-receipt | workflow | drafted | 2 | no | yes | yes | pass | 37.9 | 334.3 | 0.4260 | 56763 |  |
