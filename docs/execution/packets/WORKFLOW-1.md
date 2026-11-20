# WORKFLOW-1 — goods receipt workflows

Latest integrated checkpoint corrects dispatch, approval and validation-read authority. Workflow authoring and verifier admission remain pending.

## Claims

1. Verified definition bindings and receipt source authority are release- and fence-pinned. The worker consumes the existing receipt outbox.
2. Approval decisions bind the exact release, operation inputs, receipt company, occurrence and fence. The approver needs the live action grant for the target’s owner. Shared targets require a global grant. Ambiguous record IDs are refused.
3. Sleep persists a UTC deadline and an exactly-once journaled wake. Stale waiting runs suspend. Approvals shows exact inputs and supports per-run retry or cancel results.
4. Customize shows the approved live definition and read-only source to workspace authors and release approvers.
5. Workflow dispatch applies the pinned role restrictions to both principals and uses their live intersection with activation grants for validation reads.

## Decisions

- QuickJS Emscripten 0.32.0 won on the fixed host-owned WASM memory cap. Both candidates passed isolation, dispatch and limit probes. [ADR-0073](../../decisions/ADR-0073-workflow-isolate-and-authority.md)
- Require exact human confirmation for Tier B calls, dependency intersections and incomplete proofs. The owning capability alone writes Tier B facts.
- Actionless historical plans remain auditable and ineligible. Active approval uses source trust records and the pinned action catalog.
- The scheduler and worklist are opt-in for the local demo. Its Manager is enrolled as a potential approver and still needs each operation grant.
- Keep the receipt company in the immutable plan for source attribution. Show the resolved action scope in Approvals.
- Company-owned validation paths without issued scope are refused by the integrated CRITFIX-G guard.
- The next surface-reader rung is assigned at integration. Workflow drafting and activation, the full author-to-Inspection browser journey, and wait-for-event remain open. Documents, communication/email and connectors are later N2 work.

## Gates

- Slices 1 and 2 passed [CI 44456002463](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44456002463) and [CI 44477729782](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44477729782).
- Receipt scope and release authority passed [CI 44593928640](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44593928640) and [controls 44593937918](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44593937918).
- Approval authority at `e993d742` uses the tested executable tree from `ca1d0d59` and a docs-only synchronization. Gates passed on [CI 44605664198](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44605664198) and [controls 44605664128](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44605664128).
- Slice 4 at `db405493`. Gates passed on [CI 44649285332](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44649285332).
- Workflow display at `f8393f9a`. Gates passed on [CI 44653100303](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44653100303).

- Authority findings at `cfba4a6c` passed [CI 44678755860](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44678755860). Defect controls are in [five restored-behavior controls 44669839289](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44669839289) and [shared-scope control 44678755737](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44678755737). Migration `0046_workflow_approval_target_scope.sql`.

## Controls

- `workflow-dispatch-role-narrowing`, `workflow-approval-stored-owner` and `workflow-validation-read-authority` each restore the pre-fix behavior and fail the corresponding PostgreSQL regression.
- The controls also refuse company-only grants on shared actions, missing exact action grants and ambiguous target IDs.

```record-claim
{
  "schemaVersion": "northstar.record-claim/v1",
  "packet": "WORKFLOW-1",
  "base": "60451569e92ffe9aad3fc2c67bfa326a978b1f3c",
  "head": "cfba4a6c1dfe090de6d97fba480278a5f7cd83c1",
  "changedPaths": [
    "apps/web/src/surface-runtime.ts",
    "apps/web/src/workflow-approvals.ts",
    "apps/web/test/browser/message-catalog.spec.ts",
    "db/migrations/0046_workflow_approval_target_scope.sql",
    "db/schema.snapshot.json",
    "packages/postgres-provider/src/current-policy.ts",
    "packages/postgres-provider/src/workflow-gateway.ts",
    "packages/postgres-provider/src/workflow-worker.ts",
    "test/architecture/release-persistence-boundary.test.ts",
    "test/evidence/WORKFLOW-1.expected-red.json",
    "test/postgres/inventory-storage.test.ts",
    "test/postgres/migrations.test.ts",
    "test/postgres/module-storage-transition.test.ts",
    "test/postgres/trust-substrate.test.ts",
    "test/postgres/workflow-consumer.test.ts"
  ],
  "symbols": [
    {
      "path": "packages/postgres-provider/src/workflow-gateway.ts",
      "name": "PostgresWorkflowGateway"
    },
    {
      "path": "packages/postgres-provider/src/workflow-worker.ts",
      "name": "PostgresWorkflowWorker"
    }
  ]
}
```

## Test it yourself

- Open PostgreSQL shard 3 in the CI run above and find the workflow receipt journey. Check the results for pinned role restrictions, target ownership, shared grants and validation reads.
- Open **Approvals** in the local demo. Check the target company or **Tenant-wide** and the exact operation inputs before deciding. Open **Customize → Live workflows → View code** to inspect the trigger, grants and read-only source.
