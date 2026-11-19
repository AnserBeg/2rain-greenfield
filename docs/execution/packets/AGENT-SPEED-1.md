# AGENT-SPEED-1 — assistant speed across user-built modules

Merge held. On the integrated code all four module shapes passed the accuracy gate. Generated tasks missed the registered latency gate by 1.23 seconds. The first CI candidate exposed a rollback refusal ordering regression. Its correction preserves the ADR-0047 refusal. [Integration-candidate CI](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44600285707).

## Results

| Set and revision | To card (s) | Yes to verified (s) | Tool calls | Passed | USD/task |
|---|---:|---:|---:|---:|---:|
| Original ten, before | 14.17 | 3.45 | 5.5 | 10/10 | 0.0805 |
| Original ten, after | 11.68 | 0.40 | 7 | 10/10 | 0.0712 |
| Matched first-party, before | 4.05 | 3.03 | 4 | 12/12 | 0.0501 |
| Matched first-party, after | 4.43 | 0.12 | 4.5 | 12/12 | 0.0274 |
| Matched generated, before | 2.89 | 2.71 | 3 | 12/12 | 0.0357 |
| Matched generated, after | 4.47 | 0.11 | 4 | 12/12 | 0.0205 |
| Integrated first-party | 5.36 | 0.18 | 4.5 | 12/12 | 0.0270 |
| Integrated generated | 6.52 | 0.25 | 4 | 12/12 | 0.0200 |

Times and calls are medians. Time to the first card includes the screen preamble. Yes ends at the first successful read-back for that plan. Only tasks presenting a card contribute split timings. Costs and pass rates include every attempt. The ten-task baseline used `9ac017b9` and its legacy trace timestamps. Other split timings use a monotonic clock.

The historical ten-task model-loop median was 15.0 s. The fresh baseline measured 11.1 s and the candidate 11.8 s. Model round trips fell from 4.5 to 4 while median discovery calls rose from 2 to 3. Total real-model spend was USD 4.4856 of USD 30. [Per-attempt measurements](../evidence/AGENT-SPEED-1.csv).

Median end-to-end on the four matched journeys was 8.74 s first-party and 6.82 s generated on the baseline, then 5.77 s first-party and 5.66 s generated on the candidate. The gate compares candidate end-to-end medians and pass rates. On the candidate the generated card appeared 0.04 s later. Each attempt also requires the exact operation, one consent, successful read-back and independently observed record state.

The repeat at `345ec2e5` includes company-bound record writes and the workflow authority fix. The same four modules and tasks measured 6.92 s first-party and 8.14 s generated end-to-end. The first installation attempt hit the compiler’s 90-second sandbox limit before any model calls. The repeat used the same limits.

## Decisions and controls

1. The host executes the approved plan and verifies it through the existing gateways before requesting the summary. A scripted run exercises a falsely reported write. The unchanged CRITFIX-A snapshot covers the auto-run decision.
2. On tasks 1 and 14 (reads) and 16 and 18 (single creates), three attempts each, Opus high, Opus low and Sonnet low each passed 12/12. Median read seconds were 5.801, 5.829 and 6.890. Create seconds were 5.963, 4.041 and 3.122. Total USD by route was 0.3752, 0.2432 and 0.1826. Short single creates use Sonnet low. Reads, compound requests and explicit overrides stay at high effort. [Provider prices](https://platform.claude.com/docs/en/about-claude/pricing).
3. Read-only turns run up to four calls concurrently, preserving tool-use IDs, order and the typed evidence for each result. A wrong-type reference is refused.
4. Release-root caching stores only structure. Eligibility filters the summary and the requested detail. On a compiled release with 50 custom types, the initial map shrank from 55,482 to 21,863 characters and a sample detail used 409. The cold structure build took 28.7 ms.
5. The holdout uses identical declarations, generated after the assistant was frozen at `333e9a6c`. Both revisions receive the same independently activated record, link, lines and lifecycle modules, with one matched first-party journey per shape and three attempts each. Inspection is excluded. Activation checks every active declared business operation against its input, discovery and exact read-back contracts. It makes no model call.

## Test it yourself

1. Ask the panel to archive a record, confirm, and observe execution and verified read-back before the summary. Decline another card and check the record remains active.
2. Run `node --import tsx --test --test-name-pattern="measured create route|switching model prices" test/agent/operations-agent.test.ts` to check routing and the shared cap.
3. Run `node --import tsx --test --test-name-pattern="parallel reads" test/agent/business-map.test.ts` to check concurrent lookup and typed-reference refusal.
4. Run `node --import tsx test/agent/map-size.ts` for the 50-type measurement.
5. Run `node --import tsx --test --test-name-pattern="an active action must be exposed" test/unit/customization.test.ts`. Removing Item create from assistant discovery must refuse activation.

## Filed

Atomic parent-and-lines creation requires CUSTOMIZE-4 Option A. Recipes depend on WORKFLOW-1 bodies. Habit shortcuts need durable run records. [Freeze filings](../current-plan-archive.md#filed-during-the-freeze).

```record-claim
{"schemaVersion": "northstar.record-claim/v1", "packet": "AGENT-SPEED-1", "base": "048cf713bc528c1c85385dfa84abdc6d506228b6", "head": "01bcd894828a76cd68a50484adaa4516917efd88", "changedPaths": ["apps/api/src/agent-cli.ts", "apps/api/src/assistant-endpoint.ts", "apps/api/src/composition-root.ts", "apps/web/test/browser/assistant-panel.composed-application.spec.ts", "packages/operations-agent/src/anthropic-model.ts", "packages/operations-agent/src/business-map.ts", "packages/operations-agent/src/index.ts", "packages/operations-agent/src/loop.ts", "packages/operations-agent/src/session.ts", "packages/operations-agent/src/tools.ts", "packages/postgres-provider/src/composed-application-runtime.ts", "packages/postgres-provider/src/customization-service.ts", "test/agent/agent-world.ts", "test/agent/assistant-endpoint.test.ts", "test/agent/business-map.test.ts", "test/agent/compiled-view.ts", "test/agent/dev-tasks.ts", "test/agent/eval-harness.ts", "test/agent/generated-modules.ts", "test/agent/map-size.ts", "test/agent/operations-agent.test.ts", "test/unit/customization.test.ts"], "symbols": [{"path": "packages/operations-agent/src/business-map.ts", "name": "businessMapSummary"}, {"path": "packages/postgres-provider/src/composed-application-runtime.ts", "name": "assertAgentOperationsPlannable"}, {"path": "test/agent/generated-modules.ts", "name": "generatedProof"}]}
```
