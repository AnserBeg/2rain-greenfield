# AGENT-3 — the office assistant in the web app: fast, screen-aware, act-then-undo, measured honestly

Status: slice 1 building · Tier: Mechanical (no Critical path) · Stops taken: none
Charter: [AGENT-3-charter.md](AGENT-3-charter.md) from `main` `f1abcb3a`. Branch `packet/AGENT-3`, base `5c25acdb`.

## Pre-registered measures (written 2026-11-17, before any real-model run of this packet)

- **Discovery calls** = every `erp_discover` call, any mode (search, contracts, resolve, context); reported per task by tool and mode.
  Baseline (run 16:52, 10 tasks): 5 / 4 / 5 / 6 / 11 / 9 / 13 / 10 / 12 / 2, **median 7.5**; slice-1 target median ≤ 3.75.
- **Seconds** = the agent run on a monotonic clock (`performance.now()`, arrangement excluded). The baseline has no such field; from
  its JSONL `at` stamps (task line to last line): 14.0 / 23.0 / 16.1 / 31.2 / 74.9 / 40.6 / 71.2 / 119.7 / 38.3 / 15.9, **median 34.8**.
- Pass rate must not fall below the baseline's 9 of 10; one attempt per task is noisy (task 6 flipped across runs), reported as run.

## Claims

1. The session starts with a business map generated from the pinned release (record types, states, operations with writable
   fields, queries with views, screen recipes); the unfiltered structure is cached by release root and a customized release, having
   its own root, gets its own (`business-map.ts`; `test/agent/business-map.test.ts`).
2. The map is filtered per person, on every call, through the routed gateways' eligibility previews; the filtered text is never
   cached or shared (`businessMap()`; buyer vs manager in `business-map.test.ts` and `test/postgres/agent-tasks.test.ts`).
3. A short name (`currency`, `sales_order_create`) resolves to exactly one id of the pinned contract or to none (`matchId`).
4. The screen is named only when the pinned release declares the surface; its record id is stated as the page's claim.
5. The eval reports per task: calls by tool and mode, seconds, USD; and the median discovery calls and seconds.

## Decisions

- Map wording: one block per record type, ids by local name, fields without their record type's prefix, `!` = needs confirmation,
  archive/restore folded into one line, update fields written "the create fields" when equal; bound 60,000 characters (about 33,600 now),
  degrading to no field lists, then ids only.
- Prompt caching: one explicit breakpoint on the system prompt (prompt + map, stable per person and release) plus the top-level
  automatic one; today, now, currency, form defaults and the screen travel in the user turn, so the cached prefix stays stable.
- `#usable` eligibility cache is keyed by principal, policy version, release id and release root.

## Results (each dated result file stands as registered)

| run | pass | median discovery calls | median s | median calls | USD total | USD / completed task |
|---|---|---|---|---|---|---|
| baseline 2026-11-17 16:52 (AGENT-2, no map) | 9/10 | 7.5 | 34.8 (JSONL stamps) | 14.0 | 1.5282 | 0.1698 |
| slice 1 2026-11-17 17:54 at `7c604fda` ([result](../evidence/2026-11-17T17-54-02-978Z-agent-eval.md)) | 10/10 | 2 | 18.6 | 7 | 0.8869 | 0.0887 |

Slice 1 target met: discovery median 7.5 -> 2 (contracts 24 -> 6, search 28 -> 0, context 7 -> 0; resolve 18 -> 14), seconds 34.8 -> 18.6.
One attempt per task; the baseline's seconds come from JSONL stamps, slice 1's from the monotonic clock (both exclude arrangement).

## Slices

1. Context instead of discovery — Test it yourself below.

## Gates

## Test it yourself

Slice 1: `node --import tsx --test test/agent/business-map.test.ts` passes 7/7. With `corepack pnpm dev` running,
`NORTH_STAR_AGENT_KEY_FILE=/mnt/c/Users/rvham/rent_soft/.env corepack pnpm agent "How many Field notebooks are on hand at Calgary warehouse?"`
answers with fewer `erp_discover` lines than before (no search, no context).

## Filed
