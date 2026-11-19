# WORKFLOW-1 — goods receipt workflows

Latest integrated checkpoint is approval authority. Workflow authoring and verifier admission remain pending.

## Claims

1. Verified definition bindings and receipt source authority are release- and fence-pinned. The worker consumes the existing receipt outbox.
2. Approval decisions bind the exact release, operation inputs, receipt company, occurrence and fence. The approver needs live grants for the company and operation.

## Decisions

- QuickJS Emscripten 0.32.0 won on the fixed host-owned WASM memory cap. Both candidates passed isolation, dispatch and limit probes. [ADR-0073](../../decisions/ADR-0073-workflow-isolate-and-authority.md)
- Require exact human confirmation for Tier B calls, dependency intersections and incomplete proofs. The owning capability alone writes Tier B facts.
- Actionless historical plans remain auditable and ineligible. Active approval uses source trust records and the pinned action catalog.
- Surface reader 27, workflow drafting and activation, the full author-to-Inspection browser journey, and wait-for-event remain open. Documents, communication/email and connectors are later N2 work.

## Gates

- Slices 1 and 2 passed [CI 44456002463](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44456002463) and [CI 44477729782](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44477729782).
- Receipt scope and release authority passed [CI 44593928640](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44593928640) and [controls 44593937918](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44593937918).
- Approval authority at `e993d742` uses the tested executable tree from `ca1d0d59` and a docs-only synchronization. Gates passed on [CI 44605664198](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44605664198) and [controls 44605664128](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44605664128).

```record-claim
{
  "schemaVersion": "northstar.record-claim/v1",
  "packet": "WORKFLOW-1",
  "base": "31d16d2d381b54ff1f2a7100d9264e7b2679a899",
  "head": "e993d7427a508d09409273c7655dea4961817ae4",
  "changedPaths": [
    "db/migrations/0043_workflow_approval_scope.sql",
    "db/schema.snapshot.json",
    "packages/postgres-provider/src/workflow-execution.ts",
    "packages/postgres-provider/src/workflow-isolate-worker.ts",
    "packages/postgres-provider/src/workflow-sdk.ts",
    "test/architecture/release-persistence-boundary.test.ts",
    "test/evidence/WORKFLOW-1.expected-red.json",
    "test/integration/workflow-host.test.ts",
    "test/postgres/inventory-storage.test.ts",
    "test/postgres/migrations.test.ts",
    "test/postgres/module-storage-transition.test.ts",
    "test/postgres/trust-substrate.test.ts",
    "test/postgres/workflow-consumer.test.ts"
  ],
  "symbols": [
    {
      "path": "packages/postgres-provider/src/workflow-sdk.ts",
      "name": "generateWorkflowSdk"
    }
  ]
}
```

## Test it yourself

- In the PostgreSQL receipt journey, verify that a release approver with another company's grant or without the action grant cannot decide or read the plan. Check that no result is written and a current authorized approval succeeds.
