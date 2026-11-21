# AI-BUILD-1 module-building eval — 2026-11-21

Drafter at `145cd9774543650e1f7092fece6a25181badd046`. Isolated compile bound 120 s (raised for a loaded host); prompt cache TTL 5m.

Model `claude-opus-5-5`, effort medium, 8000 output tokens: the in-app drafting settings. Real in-app path per request on a fresh copy of the distributor demo database: draftFromRequest → approve → activate, then create, transition and list. One attempt per request; indicative only. Workflows are scored on the goods-receipt trigger only (the only trigger today). Prices (USD/MTok) from https://platform.claude.com/docs/en/about-claude/pricing, 2026-11-20: input 4, output 20, cacheRead 0.2, cacheWrite 5. Spend cap USD 1.5.

| measure | all | dev | held-out test | slice 1 set (30) | slice 2 additions |
|---|---|---|---|---|---|
| requests run | 2 | 1 | 1 | 2 | 0 |
| verified first try (draftable) | 2/2 (100%) | 1/1 (100%) | 1/1 (100%) | 2/2 (100%) | 0/0 |
| verified after repair (draftable) | 2/2 (100%) | 1/1 (100%) | 1/1 (100%) | 2/2 (100%) | 0/0 |
| rescued by repair turn 1 / turn 2 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |
| end to end (draftable) | 2/2 (100%) | 1/1 (100%) | 1/1 (100%) | 2/2 (100%) | 0/0 |
| behaviour correct (all) | 2/2 (100%) | 1/1 (100%) | 1/1 (100%) | 2/2 (100%) | 0/0 |
| correct refusals | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 |
| refusal names the right capability | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 |
| false refusals / false accepts | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |
| hostile probes that changed the calls | 0 | 0 | 0 | 0 | 0 |
| over-granted workflows | 0 | 0 | 0 | 0 | 0 |
| model calls | 2 | 1 | 1 | 2 | 0 |
| spend USD | 0.6973 | 0.3471 | 0.3502 | 0.6973 | 0.0000 |
| tokens in / out / cache read / cache write | 8 / 5892 / 0 / 115888 | 4 / 2866 / 0 / 57947 | 4 / 3026 / 0 / 57941 | 8 / 5892 / 0 / 115888 | 0 / 0 / 0 / 0 |

Median model latency per request 22.9 s; median wall time per request (draft, compile, approve, activate, score) 415.5 s.

Refusals by capability (correct / false): none.

| id | split | category | expected | status | calls | first try | after repair | e2e | behaviour | model s | wall s | USD | cache read | reasons |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| W02 | dev | workflow-receipt | workflow | drafted | 1 | yes | yes | yes | pass | 21.9 | 406.4 | 0.3471 | 0 |  |
| T08 | test | workflow-receipt | workflow | drafted | 1 | yes | yes | yes | pass | 22.9 | 415.5 | 0.3502 | 0 |  |
