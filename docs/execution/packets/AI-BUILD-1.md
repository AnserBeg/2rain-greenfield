# AI-BUILD-1 — measure whether the in-app AI builds customized modules from plain English

Status: slice 1 (the eval and its live baseline). Not Critical: test files and evidence only; no product code, migration or reader rung.
CI tier: full https://github.com/AnserBeg/2rain-greenfield/actions/runs/44854101419

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
