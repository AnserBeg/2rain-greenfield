# AI-RELY-1 — every AI behaviour measured, gated in CI without a model, and recoverable

Status: task 0 and slice 1 built 2026-11-22 on `packet/AI-RELY-1-s1`, merged with origin/main `37bfd473` (TRAIN-H, CI-6). **CI: full green on `e7f2e533`** (run below). Ready for review, then a train. Not Critical: no AGENTS.md Critical path, no migration, no reader rung. Charter: orchestrator missions folder, `ai-review/AI-RELY-1-charter.md`.
CI tier: full https://github.com/AnserBeg/2rain-greenfield/actions/runs/45015301370

Earlier full run 45004579188 on `9abd831c` was red in architecture and hygiene: the new test files were not in the suite inventory or reachability producers, and the probe's tool was named `erp_read` (reserved by AUTH005). Fixed in `a0eb2563`. Its shard 3 timed out with no failure line. After the merge, gates (a) and (b) went red on what REPORTS added, as designed. `addReportRevision` now has a dated exception, and `CUSTOMIZE_REPORT_CONFLICT` is pinned as final (`e7f2e533`).

## Task 0 — does the assistant's request pattern fail or run stale? (review R1)

Owner-approved live spend, cap USD 1.00. **Spent USD 0.083** (29 calls, `count_tokens` free; worst case checked before each call). Probe: `packages/operations-agent/probes/prefix-check-probe.ts` (manual; key only through `NORTH_STAR_AGENT_KEY_FILE` and the repo's `loadModelKey`; no key or message text logged). It sends the production body of `anthropic-model.ts` (cache breakpoints, effort, raw `content` replay via `toMessages`) non-streamed, `max_tokens` 2000; after each replay a copy with `max_tokens` 16 and the `thinking-binding-controls-2026-08-01` header, no field, which only reports `input_transformations`. Models are the app's own route: Opus 5.5 high, Sonnet 5.5 low. The live runs named the stand-in tool `erp_read`; it is now `record_lookup` (AUTH005). The check does not depend on the tool name.

| Edit the app makes | Production shape (no header) | With the header |
|---|---|---|
| honest append (control) | 200 | `[]` |
| system prompt rebuilt (business map v1 to v2) | **200** | 2 x `thinking_mismatch_allowed`, `prefix_binding_mismatch` |
| same request with `prefix_mismatch_behavior: "error"` | — | **400** "The `system` prompt differs from the one this block was created with"; header `pattern=system_rerendered` |
| oldest exchange trimmed, later reasoning kept | **200** | `thinking_mismatch_allowed`, `prefix_binding_mismatch` |
| Opus to Sonnet ("add a ..." route) | **200** | `thinking_dropped`, `model_binding_mismatch` |

**Answer: on this account the pattern is never rejected; it runs on stale reasoning** (blocks that fail the check reach the model and are billed), and a switch to Sonnet silently loses Opus's reasoning. The account is not enforced by default on these models; an enforced account (created after 2026-08-31, or any account on Fable 5.2) gets the 400 above on every later turn. Log: `ai-review/AI-RELY-1-task0-run.jsonl` (missions folder; ids, statuses, usage, entries only).

**Fix (in scope, since it breaks).** `runOperationsAgent` returns the `system` it ran under; the endpoint keeps it as `historySystem`. When this turn's prompt differs (or is unknown), or old exchanges were cut, the history is replayed through `withoutReasoning` (thinking and redacted_thinking removed, text and tool calls kept). Live re-run with the fix: **0 `prefix_binding_mismatch` entries** in both conversations; only the Sonnet downgrade drop remains.

## Slice 1 — four gates, each red when its check is removed (rule 8)

| Gate | Test | Seeded fault, result |
|---|---|---|
| (a) every drafted kind has a scored case or a dated, named exception | `test/unit/customization-ai-draft-gates.test.ts` | drop the `addChoice` exception: red; workflow cases score nothing: red |
| (b) `classifyDraftOutcome`, one test per branch; every refusal code pinned | same | empty `REPAIRABLE_REFUSAL_CODES`: red; add `CUSTOMIZE_POPUP_CONFLICT`: red |
| (c) every capability operation of the release is plannable, its child reads exist | `test/agent/capability-coverage.test.ts` | delete `reservation_release` from `capability-children.ts`: red |
| (d) a repairable refusal tells the model what to change | gates test | stop appending the rule: red |
| task 0 fix | `test/agent/operations-agent.test.ts` (3 tests) | keep reasoning on a rebuilt prompt: red; keep it after a cut: red |
| endpoint wiring | `test/agent/assistant-endpoint.test.ts` (1 test) | drop `conversation.historySystem = run.system`: red |

- (a) `scoredKinds` reads what the scorer checks from each hand-written expectation. 11 of 23 drafted kinds are scored, matching the review; the 12 others carry exceptions (13 after REPORTS added `addReportRevision`) (since 2026-11-22, owner AI-RELY-1 slice 3). The gate refuses an exception for a scored kind, so slice 3 must remove each one as it adds the case.
- (d) `classifyDraftOutcome` now appends `rule: <AUTHORING_RULES[code]>` to a repairable refusal's repair diagnostics, so the model is told the rule as well as the code. This changes what the live drafter sees on repair; it has not been measured live.
- Bridge (§7): `REPAIRABLE_REFUSAL_CODES` is exported for the test.

## General blocks (rule 16)

- **Reasoning replay bound to its prefix:** any tenant's assistant conversation survives a release or permission change: a rental firm adding a contract field mid-chat, a clinic's intake change, a distributor's new approval role.
- **Model-free coverage gates:** a drafted kind, a refusal or a capability added for any domain pack (field service, hotels, logistics) fails CI until it is scored, classified and plannable.

## Decisions (one line each)

- Model switch: not fixed here. One model per conversation needs the router (AI-FAST-1) and is slice 0's. Measured cost: Opus reasoning dropped, unbilled, no error.
- `prefix_mismatch_behavior` and the `input_transformations` log are left to slice 0. With the fix every replayed block passes, so the setting becomes a guard. It needs the beta endpoint in `anthropic-model.ts`.
- `CUSTOMIZE_POPUP_CONFLICT` and `CUSTOMIZE_REPORT_CONFLICT` stay final (not repairable). They are pinned by gate (b); filed for their owners to decide.
- Gate (c) covers the checked-in first-party release. A domain pack's release joins it when the pack lands.

## Test it yourself (about 5 minutes, no model)

```
node --import tsx --test test/unit/customization-ai-draft-gates.test.ts test/agent/capability-coverage.test.ts
node --import tsx --test --test-name-pattern="reasoning|rebuilt|cut from the front" test/agent/operations-agent.test.ts
# One gate going red: delete the line "reservation_release: []," from
# packages/domain/src/app/capability-children.ts, rerun the first command, then git checkout that file.
```

```record-claim
{"schemaVersion": "northstar.record-claim/v1", "packet": "AI-RELY-1", "base": "37bfd47311c58060000cebca49d5f55174e3874a", "head": "e7f2e53340586f013b64242de90df752ccff3455", "changedPaths": ["apps/api/src/assistant-endpoint.ts", "package.json", "packages/operations-agent/probes/prefix-check-probe.ts", "packages/operations-agent/src/loop.ts", "packages/postgres-provider/src/customization-service.ts", "test/agent/assistant-endpoint.test.ts", "test/agent/build-eval-cases.ts", "test/agent/capability-coverage.test.ts", "test/agent/operations-agent.test.ts", "test/architecture/repository-hygiene.test.ts", "test/helpers/reachability-producers.ts", "test/unit/customization-ai-draft-gates.test.ts"], "symbols": [{"path": "packages/operations-agent/src/loop.ts", "name": "withoutReasoning"}, {"path": "packages/operations-agent/src/loop.ts", "name": "runOperationsAgent"}, {"path": "packages/postgres-provider/src/customization-service.ts", "name": "classifyDraftOutcome"}, {"path": "packages/postgres-provider/src/customization-service.ts", "name": "REPAIRABLE_REFUSAL_CODES"}, {"path": "test/agent/build-eval-cases.ts", "name": "scoredKinds"}, {"path": "test/agent/build-eval-cases.ts", "name": "EVAL_CASE_EXCEPTIONS"}]}
```
