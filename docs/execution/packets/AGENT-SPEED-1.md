# AGENT-SPEED-1 — the host verifies approved changes

The panel and CLI execute a personally approved plan and read it back before asking the model for its summary. Both calls use the existing session gateways and the approved plan ID. A scripted test makes the gateway acknowledge two writes without saving either field and checks that the model receives the failed verification.

## Matched measurements from the original packet

| Set | Time to card (s) | Yes to verified (s) | Tool calls | Pass rate | USD/task |
|---|---:|---:|---:|---:|---:|
| First-party, before | 4.05 | 3.03 | 4 | 12/12 | 0.0501 |
| First-party, all levers | 5.36 | 0.18 | 4.5 | 12/12 | 0.0270 |
| Generated, before | 2.89 | 2.71 | 3 | 12/12 | 0.0357 |
| Generated, all levers | 6.52 | 0.25 | 4 | 12/12 | 0.0200 |

Each set covers four matched tasks with three attempts per task. The isolated timing investigation follows this split. The trace test observes the order of approval, execution, verification and summary.

## Test it yourself

Ask the assistant to archive a record and approve the card. The summary follows the read-back. Decline another card and verify that the record stays active. Run `node --import tsx --test --test-name-pattern='a personal yes|auto-run snapshot' test/agent/business-map.test.ts` to exercise the failed read-back and CRITFIX-A snapshot.

## Filed

Atomic creation with lines needs CUSTOMIZE-4 Option A. Recipes depend on WORKFLOW-1 bodies. Habit shortcuts need a durable run record.

```record-claim
{"schemaVersion": "northstar.record-claim/v1", "packet": "AGENT-SPEED-1", "base": "61c8afb1dd760c854bc5bc33890f1e85fc2a0e99", "head": "0b33d468d4c0e78cbb654bbc0f3614b84127a782", "changedPaths": ["apps/api/src/agent-cli.ts", "apps/api/src/assistant-endpoint.ts", "apps/web/test/browser/assistant-panel.composed-application.spec.ts", "packages/operations-agent/src/loop.ts", "test/agent/business-map.test.ts", "test/agent/eval-harness.ts"], "symbols": [{"path": "packages/operations-agent/src/loop.ts", "name": "runOperationsAgent"}]}
```
