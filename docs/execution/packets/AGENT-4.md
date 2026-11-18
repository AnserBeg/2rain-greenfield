# AGENT-4 — approval, Undo and recovery after the assistant re-read

BUILD · 2026-11-18 · [PR 90](https://github.com/AnserBeg/2rain-greenfield/pull/90) · Base `8561a73d` · Reviewed source `d33ca17f` · No Critical path.

## Claims and controls

“Map” and “endpoint” refer to `test/agent/business-map.test.ts` and `test/agent/assistant-endpoint.test.ts`. “Panel” refers to `assistant-panel.composed-application.spec.ts`. Test names and finding numbers identify the assertions.

| Finding | Disposition and behavior | Commit | Test |
|---|---|---|---|
| 1 | Fixed. Cards name the capability, show explicit clears and shorten declared options only. | `a205ed66` | Endpoint X1 checks invoice post/void and bound inputs. |
| 2–3 | Fixed. “Yes, please.” approves. A failed POST can be retried. Server settlement clears its card and preserves typed input. | `a205ed66`, `8f9d1e6f` | Endpoint X2 and Panel failed POST, stale card replay and timeout. |
| 4 | Fixed. Purchase-order release reads its declared child queries under their owning relation. | `a205ed66` | Map 4/5 rejects unsupported scopes. |
| 5 | Fixed for all pages and targets created by this plan. Residual executor race filed below. | `a205ed66` | Map 4/5 changes line 101. Map 5 adds an unexpected child to a newly created order. |
| 6–7 | Fixed. Setup controls and reviewed stock counts and their lines need a yes. | `a205ed66`, `8f9d1e6f` | Map X5 and 7 exercise the company default, credit hold, header and parent state. |
| 8, 10 | Fixed. Stop expires unused approvals. Every execution, including recovered Undo, checks its own signal at invocation. | `a205ed66` | Map 8/10/14 aborts during view acquisition and retries Undo on a fresh signal. |
| 9, 27 | Fixed. Each committed receipt has its own Did and Open, including after failure and recovery. Only the latest eligible update offers Undo. | `a205ed66`, `8f9d1e6f` | Endpoint 9/27 observes both host reads and both link targets. Panel streams Did on error. |
| 11–13 | Removed by R1. Creates and every multi-step plan require confirmation. Archive inverses, dependency scans and partial inverse execution are gone. | `a205ed66` | Map risk class and X8 exercise a create, two updates, and a later write to another record. |
| 14 | Fixed for the remaining single update. Undo requires a successful inverse receipt for the original record. | `a205ed66` | Map 8/10/14 switches the release between inverse planning and execution. |
| 15–16 | Fixed. Selected surface scope governs the company. Recovery and Undo require the current company to match. | `a205ed66`, `8f9d1e6f`, `999a198f` | PostgreSQL agent-tasks resolves a company B invoice with the real runtime. Endpoint X9 tests recovery, Undo and identical-card digests. Map X9 changes the company before execution. |
| 17 | Fixed. A bare loopback Host is accepted on HTTP port 80. | `a205ed66` | Endpoint 17 and X10 exercise default port and foreign Host. |
| 18 | Fixed. Only a standalone customization intent through `erp_plan` requests a draft. The drafter gets the user’s words. | `a205ed66` | Endpoint X11 quotes the entire instruction. PostgreSQL dev task 35 exercises the legacy line recognizer. |
| 19–21 | Fixed. References have declared targets. Text currencies use supported codes. Planning shares purchase approval argument validation with execution. | `a205ed66` | Map 19/20/21 covers literal IDs, earlier step types, actor codes, currency and invalid reason. |
| 22–23 | Fixed. Admission reserves the serialized request at the highest input rate. An oversized request can be retried. A resumed conversation survives concurrent eviction. | `a205ed66`, `8f9d1e6f` | Endpoint 22 retries with a short request and 23 races two tabs. |
| 24 | Fixed. Stop reaches the drafter, staging and patch recording transaction. | `a205ed66`, `8f9d1e6f` | PostgreSQL customization stops while waiting for the release lock. Panel checks the composed draft meter. |
| 25–26 | Fixed. An exact successful read establishes “this record.” A partial plan reports only the role that committed. | `a205ed66` | Map turn context, X14 and 26 check failed reads and a refused customer role. |
| R5 | Strengthened card, host read-back, latest-write, company, quotation, draft wiring and CLI caller tests. R1 removes the partial Undo premise. | `a205ed66`, `8f9d1e6f`, `999a198f` | Panel, endpoint X9/X11/X15 and 9/27, Map X8, PostgreSQL agent-tasks and dev task 35. |

## Decisions and gates

- Under R1, a single eligible O0 master or draft update can run immediately. Undo restores its prior fields against the revision that the update wrote. The plan records this narrower implementation in §9.4.
- Five tools. Customization uses the existing plan tool. The submitting surface supplies the company's scope for both recovery and Undo.
- Selective reversions failed the CLI caller, endpoint read-back, later-write Undo, identical-card endpoint digest and execution digest assertions.
- Gate is the [PR’s CI checks](https://github.com/AnserBeg/2rain-greenfield/pull/90/checks). Local checks cover format, typecheck, lint, focused assistant tests and record fidelity.

## Test it yourself

1. Run `node --import tsx --test test/agent/assistant-endpoint.test.ts test/agent/business-map.test.ts`. The number-prefixed tests exercise the re-read findings.
2. In the assistant, ask to change one customer’s name. Open the changed customer from Did, click Undo, and refresh the record to see the old name.
3. Ask to create a contact, then ask to make two edits together. Each plan waits for Yes. Decline to leave the data alone.
4. Open a reviewed stock count and ask to change its location. Check the company and bound input on the card, then press Stop.

## Filed

Finding 5, R3. A line edit committed after the final agent re-read and before the receiving executor’s line SELECT can change the posted quantity. This spans gateway authorization and transaction entry with no elapsed-time bound. Closing it requires comparing the approved snapshot under the receiving executor’s lock. The orchestrator accepts this window for the local demo. [Archive entry](../current-plan-archive.md#filed-during-the-freeze)

```record-claim
{
  "schemaVersion": "northstar.record-claim/v1", "packet": "AGENT-4",
  "base": "8561a73d546439b34427bfab5ed3e31f4693901b", "head": "999a198f35ec54fbca43220d592518bf20259271",
  "changedPaths": [
    "apps/api/src/assistant-endpoint.ts", "apps/api/src/composition-root.ts", "apps/web/src/assistant-panel.ts",
    "apps/web/src/surface-runtime.ts", "apps/web/test/browser/assistant-panel.composed-application.spec.ts", "packages/domain/src/purchasing/approval-arguments.ts",
    "packages/operations-agent/src/capability-children.ts", "packages/operations-agent/src/index.ts", "packages/operations-agent/src/loop.ts",
    "packages/operations-agent/src/record-references.ts", "packages/operations-agent/src/risk.ts", "packages/operations-agent/src/session.ts",
    "packages/operations-agent/src/tools.ts", "packages/postgres-provider/src/customization-service.ts", "packages/postgres-provider/src/purchase-order-approval-executor.ts",
    "test/agent/assistant-endpoint.test.ts", "test/agent/business-map.test.ts", "test/postgres/agent-dev-tasks.test.ts",
    "test/postgres/agent-tasks.test.ts", "test/postgres/customization.test.ts"
  ],
  "symbols": [{"path":"packages/operations-agent/src/session.ts","name":"OperationsAgentSession"},{"path":"packages/operations-agent/src/capability-children.ts","name":"capabilityChildren"},{"path":"packages/domain/src/purchasing/approval-arguments.ts","name":"checkApprovalArguments"},{"path":"apps/web/src/surface-runtime.ts","name":"assistantCompany"}]
}
```
