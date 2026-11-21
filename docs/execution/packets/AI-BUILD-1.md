# AI-BUILD-1 — measure whether the in-app AI builds customized modules from plain English

Status: slices 1 and 2, merging as one packet (orchestrator ruling, 2026-11-21). Slice 1: the eval and its live baseline (test files and evidence). Slice 2: the drafter generated from the patch schemas, platform rules in the prompt, a two-turn repair loop, address/map/files/board drafting, and the live re-run. Not Critical: no AGENTS.md Critical path, no migration, no reader rung.
CI tier: full https://github.com/AnserBeg/2rain-greenfield/actions/runs/44954610888

## Slice 2 — raise the drafter's success (built 2026-11-21)

Charter: orchestrator missions folder, `charters/AI-BUILD-1-slice2.md`, items 1–7. Not Critical (no AGENTS.md Critical path, no migration, no reader rung). Slice 1 and slice 2 merge as one packet (orchestrator ruling, 2026-11-21).

### What changed

1. **Generated kind descriptions (rule 12).** `packages/customization/src/ai-draft-kinds.ts` holds what the drafter accepts per patch kind: the patch member's own schema where the model can emit it, and a choice-shaped schema (listed IDs, rule 10) for boards, layouts, validations, calculated displays, address, map and files members. The tool's description and its flat input schema are generated from these with `z.toJSONSchema`; each kind adds one guidance sentence. `test/unit/customization-ai-draft-slice2.test.ts` fails closed when a `CUSTOMIZATION_PATCH_KINDS` member is neither drafted nor carries a dated, named exception (none today); the control (drop `addUploadCategory` from the drafter) reds it. Board v2's named drafter exception is closed.
2. **Platform rules in the prompt.** `authoring-rules.ts` states the rule behind every patch-application refusal code (a `Record` over `CustomizationRefusalCode`, so a new code is a compile error until its rule exists) and the compiler and draft-shape rules a well-formed draft can still meet: distinct state and action labels, lifecycle shape, one line table and one lifecycle per type, address and map placement, and so on. The workflow section is generated from the workflow compiler (`workflowAuthoringRules`): the body is only the statements inside `function run(sdk, event): void`, the banned names, and the `workflowId` pattern from `WorkflowDefinitionSchema`. One rule was added after the dev-only smoke: draft exactly what was asked (M04 had added an unrequested board).
3. **Repair loop, at most two turns.** `draftPatchFromRequest` takes the caller's check; the Customize service's check verifies a workflow bundle (type-check, lint, replay) and drafts the patch (compile). Schema issues, compiler rejections, patch-application refusals and draft-shape `unsupported` outcomes go back as the tool result, at most 8 diagnostics of 400 characters each. Authority, staleness, lineage and every other `unsupported` are final, so a correct refusal is never argued away. The eval records each turn's feedback, so first draft and after repair are reported separately. This subsumes WORKFLOW-2 item 2 (noted there).
4. **New members in the drafter.** `addAddressField`, `addMapPlacement`, `addDocumentField` (with its categories) and `addUploadCategory` are drafted from a record type and a label; IDs derive the way the Customize forms derive them (`field-member-draft.ts`). DOCS-1 template kinds are not on main, so none are added.
5. **A board in the same change as its new record type.** A change-set member may name a record type created earlier in the change; the drafter applies the earlier members to the live definition and builds the board from that offer, so the authoring digest check passes. Rule 10 is proven in the unit test: with the board, adding a field and relabelling a list column still apply.
6. **Scorer buckets** use word boundaries ("pin" no longer matches "overlapping"); a unit test pins the baseline refusal texts to one bucket each.

Also fixed on the way: slice 1's scorer read `board.body` after Board v2 renamed it `frame` (a type error on the merged branch); a generated-schema key collision (below); and the eval may raise the isolated compile's bound on a loaded host (`openCustomizeService` `sandboxWallClockMilliseconds`; the app keeps its default).

### Live result (2026-11-21, local, one attempt per request)

**38 of 40 behave as asked (95%); 32 of 34 draftable requests verify on the first draft (94%).** Baseline (slice 1): 26/30 behaviour, 19/23 verified. Drafter at `f3f427c2` (harness `ea92d158`), Opus 5.5 at medium effort, 8000 output tokens, the app's own drafting settings. First drafts were made back to back from the captured in-app prompts and saved, then each case was scored on the real in-app path (draft → approve → activate → create, transition, list) one at a time on an idle host, compile bound 120 s. The scoring process stopped once when its database container exited (during T05); the 11 remaining cases resumed from the same saved drafts. [Combined scorecard](../evidence/2026-11-21-build-eval-slice2-combined/combined-summary.md) · [first 29](../evidence/2026-11-21-build-eval-2026-11-21T18-25-05-613Z/) · [last 11](../evidence/2026-11-21-build-eval-2026-11-21T21-01-41-178Z/).

| measure | baseline (30) | slice 2, same 30 | slice 2, 10 new held-out | slice 2, all 40 |
|---|---|---|---|---|
| verified first try (draftable) | 19/23 (83%) | 23/25 (92%) | 9/9 | 32/34 (94%) |
| verified after repair | 19/23 (83%) | 23/25 (92%) | 9/9 | 32/34 (94%) |
| end to end | 19/23 (83%) | 23/25 (92%) | 9/9 | 32/34 (94%) |
| behaviour correct | 26/30 (87%) | 28/30 (93%) | 10/10 | 38/40 (95%) |
| receipt workflows | 0/3 | 1/3 | 1/1 | 2/4 |
| correct refusals, right capability | 7/7 | 5/5 | 1/1 | 6/6 |
| false refusals / false accepts | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |
| hostile probes that changed the calls | 0/3 | 0/3 | 0/1 | 0/4 |
| over-granted workflows | 0 | 0 | 0 | 0 |

- Two slice 1 expectations changed because the platform can now do the request, and were rewritten before any slice 2 run: U01 (an address field with its map on customers, was "unsupported: address") and M07 (rental contracts with lines, statuses and a board, was "unsupported: board"). Both pass, which moves two cases from the refusal column to the draftable column.
- Fixed on the way to this result: M04 (one action label on three transitions) now drafts distinct labels; no case needed a repair turn except the two workflow failures.
- Cost: USD 2.94 for the 44 model calls of the scored cases, 1.67 M cache-read against 0.39 M cache-write tokens. Slice 2's live spend in all was about USD 8.1 with the rescore below (7.0 before it): smoke 0.77 (dev cases, drafter `f5a8f279`, not counted), a first 40-run stopped at 12 cases for the key-collision defect below 2.85 (not counted), one probe 0.20, and this run (drafts 2.09, repairs about 1.1).
- Median model time per request 3.6 s; median wall time about 150 s on an idle host (the drafted change's compile, approval and activation dominate).
- Validation rules are not covered by the 40. Three dated follow-up requests (V01 literal, V02 cross-field, V03 through a parent link) are written and committed outside the scored set (`VALIDATION_FOLLOWUP_CASES`).

### Failure causes, ranked

1. **Approval-shaped receipt workflows (W02, T08): 2 of 4 workflows.** The model's approval fixture names the operation `id` where the envelope needs `operationId`; the verifier said only "needs an exact operation and input" or "keys disagree with the pinned contract", so neither repair turn could converge (USD 0.50 each). Fixed after the run (`ce0b8b47`): one table, `WORKFLOW_CALL_ENVELOPES`, is read by both the SDK's call admission and the drafter's workflow rules, and the refusal names the expected, missing and unexpected keys (test, red control). Rescore below.
2. **A generated-schema key collision (found in the first, stopped 40-run, fixed before this run).** Merging every kind's keys into one tool schema made `field` an object for `addField` and text for `addMapPlacement`; Opus sent `field` as a JSON string three turns running (F01). The keys are now `addressField` and `filesField`, and a schema test fails on any object-or-text collision except `target`.
3. **Environment, not scored as model failures.** On a loaded host the 90 s compile bound refused base installs and drafted changes; slice 1 saw the same (T08). The eval now raises the bound to the compiler's 120 s cap, waits for an idle host before each case, requeues a compile timeout up to twice and reports a case still timing out as not scored. None was needed in the final run.

### W02 and T08 after the verifier fix (2026-11-21)

- **Same first drafts, live repairs** (`--force-first-turn`; [evidence](../evidence/2026-11-21-build-eval-2026-11-21T21-55-15-295Z/)): both pass after one repair turn. The refusal now reads "expected exactly {kind, summary, operationId, input}; missing "operationId"; unexpected "id"". Two new model calls in all (USD 0.85 for both cases including the replayed first turns).
- **Fresh first drafts on the fixed drafter** (the envelope generated into the prompt; [evidence](../evidence/2026-11-21-build-eval-2026-11-21T22-09-31-798Z/)): both pass on the first draft, no repair (USD 0.70 for both).
- With these, receipt workflows are 4/4 on the fixed drafter (W01 and N08 unchanged from the 40-run).

### Gates

- CI tier is full (shared paths). Latest PR #136 runs: see the CI tier line above; the scripted build-eval cases (compiler-refusal repair, workflow repair from the verifier, module with board, address with map) passed in CI on 67d6db64.
- Merged with main twice (DOCS-1 slice 2, CUSTOMIZE-5, WORKFLOW-2, BOOKING-1, CONNECT-1, UPGRADE-2, TRAIN-B). After the merge the drafter also covers `addDateTimeField` from its schema; DOCS-1's template members carry dated, named drafter exceptions (owner AI-BUILD-1 slice 3).
- The 40-run measured the drafter at `f3f427c2`; the branch tip adds the main merges and the workflow envelope fix (`ce0b8b47`), measured only by the W02/T08 rescore above.

### Test it yourself (slice 2)

1. `node --import tsx --test test/unit/customization-ai-draft-slice2.test.ts` (no Docker, about a minute): coverage fails closed, the tool schema is one object with no object-or-text key collision, repairs are bounded and never argue with a refusal, a board drafts with its new record type, an address and its map draft from a label, and a workflow key refusal names its keys.
2. `node --import tsx --test test/postgres/build-eval.test.ts` (Docker, about 30 minutes): ten scripted cases on the real in-app path, including a compiler refusal repaired, a workflow repaired from the verifier error, a module with its board, and an address with its map saved end to end.
3. Live, local only: draft once, then score from the saved drafts on a quiet host (see `test/agent/build-eval-run.ts` header): `--prompts-in <captured> --drafts-out <file>`, then `--drafts-in <file>`. Open `combined-summary.md` in the evidence folder.

## Slice 1

## Claims

1. `test/agent/build-eval.ts` drives the real in-app path per request on a fresh copy of the distributor demo database: Customize `draftFromRequest` → `approve` → `activate`. It then scores end to end on the never-restarted runtime: create a record with every writable field, add a line, walk the lifecycle, read back and list.
2. Behaviour is scored against 30 hand-written expectations in `test/agent/build-eval-cases.ts`, committed (`c30faa85`) before any live run. 8 of the 30 are held out.
3. CI proves the scoring with scripted models only (`test/postgres/build-eval.test.ts`): a correct draft passes; a repaired draft counts as after-repair; a wrong draft that activates fails behaviour; a refusal is credited with its capability; a module refused is a false refusal; a hostile permission proposal is flagged; a receipt workflow runs on the eval's own event.
4. The key is read only from the file named by `NORTH_STAR_AGENT_KEY_FILE`; an ambient key is ignored. Every transcript line passes `redactSecrets` with the key on its list; provider content is never recorded.

## Baseline (live, local, 2026-11-20/21)

**Of 30 requests (one attempt each): 19 built and worked end to end, 7 were correctly refused, 4 failed.** The one repair turn rescued nothing (83% verified before and after it), and receipt workflows are 0/3. Model `claude-opus-5-5`, effort medium, 8000 output tokens, the app's own drafting settings. One attempt per request, so the numbers are indicative only. Spend cap USD 15 (USD 2 for the T08 rerun). Total spend USD 3.55 for 33 model calls (the replays made none).

| measure | all | dev (22) | held-out (8) |
|---|---|---|---|
| verified first try (draftable) | 19/23 (83%) | 14/17 | 5/6 |
| verified after the one repair turn | 19/23 (83%) | 14/17 | 5/6 |
| end to end: create, transition, list | 19/23 (83%) | 14/17 | 5/6 |
| behaviour correct against expectations | 26/30 (87%) | 19/22 | 7/8 |
| correct "unsupported", right capability named | 7/7 | 5/5 | 2/2 |
| false refusals / false accepts | 0 / 0 | | |
| hostile probes that changed the drafted calls | 0/3 (H01, H02, T07) | | |

- Every module, multi-step, follow-up and hostile request passed except M04. A no-model probe confirmed H02's hostile field label reaches the drafting system prompt (6 lines), so H02 is a real system-prompt probe.
- All 4 failures are on the drafting path. W01, W02 and T08 fail at workflow verification; M04's draft is refused.
- Latency: median 4.3 s model time per request (1.3 to 29.5 s). Median 4 to 5 minutes wall time per request, most of it compile and activation on a loaded laptop.
- Workflows, scored on the goods-receipt case only (the only trigger until WORKFLOW-2):
  - verified on the first draft 0/3; verified after repair 0/3; behaviour correct 0/3;
  - declared grants exactly the expected operations 3/3. The run-based over-grant check needs a verified body, so it has not run yet.
  - Re-run these cases after WORKFLOW-2.
- Refusals by capability, all correct:
  - links on a published type 2;
  - address and map 1;
  - booking 1;
  - email reminders 1;
  - PDF and e-signature templates 1;
  - a board in the same change as its new type 1.
  - Bucket labels overlap in two rows ("pin" matches inside "overlapping"; "when … created" matches the link-later text). The right-reason judgement is unaffected.

## Failure causes, by frequency

1. 3 of 3 workflows: the body is a whole `export default function run(...)`, not a function body. The prompt does not say so, and the verification error is never shown to the model (WORKFLOW-2 item 2).
2. 3 of 3 workflows, first turn: `workflowId` with underscores. The schema needs `^[a-z][a-z0-9-]*$`, and the prompt does not state it. The repair turn fixed it each time.
3. M04: one action label ("Mark lost") on three transitions. The draft is refused with "Use distinct names for the states and for the actions"; the rule is not in the prompt, and a refusal gets no repair turn.
4. Scorer defects found during the run, fixed, and rescored by replaying the recorded drafts. M06 and T03 added a line after closing the record; T07 found no seeded purchase order and no date-time eval value. Expectations unchanged.
5. Environment: T08's base install exceeded the 90 s sandbox compile bound under host load (load average 44). It was rerun live.

## Decisions

- Each case gets a fresh copy of the seeded demo database, not the person's running demo. Follow-ups start from a base installed through the declarative editor, so a failure belongs to the follow-up.
- A case scores as verified when it is drafted (compiled) and approved (release verification). Activation is a separate stage.
- M07 (the charter's "lines, statuses and a board") expects a refusal: a board cannot target a type created in the same change. Module-scale requests without a board passed (M06, M09, T03), so decomposition is not indicated yet.
- Rescoring replays the recorded tool calls through a scripted model (`--replay`). It keeps the model's output, time and spend fixed while the scorer changes.

## Gates

- Full CI 44838134807 green at `4da63373` (all harness code but the replay and fallback commits). Full CI 44854101419 green at `1b6aa091` (last executable commit plus evidence; the secret scans read the transcripts). Later commits are docs only.
- Evidence: [live run](../evidence/2026-11-20-build-eval-2026-11-20T23-03-14-492Z/summary.md), [T08 rerun](../evidence/2026-11-21-build-eval-2026-11-21T01-32-08-200Z/summary.md), [final merged table](../evidence/2026-11-21-build-eval-rescore-2026-11-21T01-52-38-712Z/summary.md).

## Test it yourself

1. `node --import tsx --test test/postgres/build-eval.test.ts` (Docker running, about 15 minutes): six scripted cases, including the wrong draft that must fail.
2. Live, local only (about 2.5 hours, about USD 4): `NORTH_STAR_AGENT_KEY_FILE=/mnt/c/Users/rvham/rent_soft/.env node --import tsx test/agent/build-eval-run.ts --cap 15`. Add `--cases M01,F02` for a 10-minute check.
3. Open the new folder's `summary.md` under `docs/execution/evidence/`. Check that no transcript line contains a key.

## Filed

- Slice 2 inputs:
  - put the workflow-body shape and the id pattern in the drafter prompt;
  - feed verification errors and draft refusals back for bounded repair turns;
  - state the distinct-action-label rule.
- Tighten the bucket regexes with word boundaries.

```record-claim
{"schemaVersion": "northstar.record-claim/v1", "packet": "AI-BUILD-1", "base": "f1829ea9ce70a886a050e043dce23cb12267335d", "head": "3caef21db3821156722e4588b96e8346174456a3", "changedPaths": ["test/agent/build-eval-cases.ts", "test/agent/build-eval-run.ts", "test/agent/build-eval.ts", "test/architecture/repository-hygiene.test.ts", "test/postgres/build-eval.test.ts"], "symbols": [{"path": "test/agent/build-eval.ts", "name": "runBuildCase"}, {"path": "test/agent/build-eval.ts", "name": "scoreModule"}, {"path": "test/agent/build-eval.ts", "name": "scoreWorkflow"}, {"path": "test/agent/build-eval.ts", "name": "redactSecrets"}]}
```
