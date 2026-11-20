# WORKFLOW-1 — goods receipt workflows

## Claims

1. A posted receipt starts a release- and fence-pinned workflow as a scoped automation principal. The journal and outbox make effect retry and timer wake idempotent.
2. Dispatch applies current narrowed policy and activation authority. Approval requires the exact action and its stored owner scope. Shared targets require a global grant and ambiguous record IDs are refused.
3. Customize Ask drafts workflow source and replay fixtures as a normal patch. The release verifier binds the body, trigger, grants and SDK to the pinned release. Approval and activation use the normal release path.
4. A receipt for Field notebooks creates an Inspection linked to the receipt. Two days later a pending Inspection produces a human approval request. Rollback retains the audit trail.

## Decisions

- QuickJS Emscripten 0.32.0 won on the fixed host-owned WASM memory cap. Both candidates passed isolation, dispatch and limit probes. [ADR-0073](../../decisions/ADR-0073-workflow-isolate-and-authority.md)
- Tier B calls and incomplete dependency proofs require exact human confirmation. The owning capability writes Tier B facts.
- The workflow requires surface reader 29. Releases with no workflow keep their previous bytes. [ADR-0074](../../decisions/ADR-0074-formula-rule-and-workflow-projection-admission.md)
- The demo scheduler and Approvals are opt-in. SIGNIN-1 owns the staff approval proof.
- Wait-for-event, broader document workflows, communication/email and connectors remain open.

- Slice 3 fixes require the activation grant's role ID and a recorded human Retry for a later fence. Legacy watermarks retain their audit data and need a fresh activation to authorize new runs.
- An approval on an earlier fence explains its journal result. An uncommitted effect requires a new decision on the current fence.

## Gates

- Slices 1 and 2 passed [CI 44456002463](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44456002463) and [CI 44477729782](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44477729782).
- Receipt scope and release authority passed [CI 44593928640](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44593928640) and [controls 44593937918](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44593937918).
- Approval authority at `e993d742` uses the tested executable tree from `ca1d0d59` and a docs-only synchronization. Gates passed on [CI 44605664198](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44605664198) and [controls 44605664128](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44605664128).
- Slice 4 at `db405493`. Gates passed on [CI 44649285332](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44649285332).
- Workflow display at `f8393f9a`. Gates passed on [CI 44653100303](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44653100303).

- Authority findings at `cfba4a6c` passed [CI 44678755860](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44678755860). Defect controls are in [five restored-behavior controls 44669839289](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44669839289) and [shared-scope control 44678755737](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44678755737). Migration `0046_workflow_approval_target_scope.sql`.
- Verifier and authoring at `35c0de4a` passed [CI 44711875228](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44711875228).

## Controls

- The dispatch narrowing, stored-owner and validation-read regressions each fail with the old behavior restored.
- A real pre-admission reader refuses the required surface floor. The archived tenant runner reproduces the whole workflow-free envelope. Altered SDK and trigger projections are refused.

- Slice 3 controls restore each reviewed failure and check an actual candidate, operation receipt, Retry decision or evidence row. See [control manifest](../../../test/evidence/WORKFLOW-1-slice3-fix.expected-red.json).

```record-claim
{
  "schemaVersion": "northstar.record-claim/v1",
  "packet": "WORKFLOW-1",
  "base": "08edc207bcd5be1982c9c0bcf1723172df9cb7ad",
  "head": "5375450fa9fc24cf255a3b5a763facb0ed99c7b4",
  "changedPaths": [
    "db/migrations/0052_workflow_retry_authority.sql", "db/schema.snapshot.json",
    "learnings.md", "packages/postgres-provider/src/current-policy.ts",
    "packages/postgres-provider/src/release-verification-service.ts", "packages/postgres-provider/src/workflow-execution.ts",
    "packages/postgres-provider/src/workflow-gateway.ts", "test/architecture/release-persistence-boundary.test.ts",
    "test/architecture/tenant-completeness.manifest.json", "test/architecture/tenant-completeness.test.ts",
    "test/evidence/WORKFLOW-1-slice3-fix.expected-red.json", "test/evidence/WORKFLOW-1-threat-model-fix.expected-red.json",
    "test/evidence/WORKFLOW-1.expected-red.json", "test/integration/workflow-admission.test.ts",
    "test/postgres/inventory-storage.test.ts", "test/postgres/migrations.test.ts",
    "test/postgres/module-storage-transition.test.ts", "test/postgres/releases.test.ts",
    "test/postgres/trust-substrate.test.ts", "test/postgres/workflow-consumer.test.ts"
  ],
  "symbols": [
    {"path": "packages/postgres-provider/src/current-policy.ts", "name": "PostgresCurrentPolicyGateway"},
    {"path": "packages/postgres-provider/src/release-verification-service.ts", "name": "compiledProjectionBinding"},
    {"path": "packages/postgres-provider/src/workflow-execution.ts", "name": "loadJournal"}
  ]
}
```

## Test it yourself

- Open the Customization rules browser runner in [CI 44711875228](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44711875228). Find **a drafted receipt workflow links an inspection and requests escalation after two days**. It drafts and activates the change, posts a receipt, opens its link from the pending Inspection and advances the clock to the approval request.
- In the opt-in local demo, open **Customize → Live workflows → View code** to check the trigger, grants and source. Open **Approvals** to inspect the exact operation inputs and target company.
- In CI for the slice 3 fix, open the PostgreSQL shard for **only a recorded human Retry can advance the run fence** and **same-pin Retry asks for fresh approval before an uncommitted effect**. The first requires human Retry, and the second shows a fresh plan with zero receipts until approval.
