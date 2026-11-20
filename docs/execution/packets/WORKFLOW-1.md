# WORKFLOW-1 — goods receipt workflows

Latest integrated checkpoint is slice 4. Workflow authoring and verifier admission remain pending.

## Claims

1. Verified definition bindings and receipt source authority are release- and fence-pinned. The worker consumes the existing receipt outbox.
2. Approval decisions bind the exact release, operation inputs, receipt company, occurrence and fence. The approver needs live grants for the company and operation.
3. Sleep persists a UTC deadline and an exactly-once journaled wake. Stale waiting runs suspend. Approvals shows exact inputs and supports per-run retry or cancel results.

## Decisions

- QuickJS Emscripten 0.32.0 won on the fixed host-owned WASM memory cap. Both candidates passed isolation, dispatch and limit probes. [ADR-0073](../../decisions/ADR-0073-workflow-isolate-and-authority.md)
- Require exact human confirmation for Tier B calls, dependency intersections and incomplete proofs. The owning capability alone writes Tier B facts.
- Actionless historical plans remain auditable and ineligible. Active approval uses source trust records and the pinned action catalog.
- The scheduler and worklist are opt-in for the local demo. Its Manager is enrolled as a potential approver and still needs each operation grant.
- Surface reader 27, workflow drafting and activation, the full author-to-Inspection browser journey, and wait-for-event remain open. Documents, communication/email and connectors are later N2 work.

## Gates

- Slices 1 and 2 passed [CI 44456002463](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44456002463) and [CI 44477729782](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44477729782).
- Receipt scope and release authority passed [CI 44593928640](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44593928640) and [controls 44593937918](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44593937918).
- Approval authority at `e993d742` uses the tested executable tree from `ca1d0d59` and a docs-only synchronization. Gates passed on [CI 44605664198](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44605664198) and [controls 44605664128](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44605664128).
- Slice 4 at `db405493`. Gates passed on [CI 44649285332](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44649285332).

```record-claim
{
  "schemaVersion": "northstar.record-claim/v1",
  "packet": "WORKFLOW-1",
  "base": "cfbe24f0ea74b71b62924125c060137f12d467d6",
  "head": "db40549339b2d963801655cea57dd184fb5c3bd5",
  "changedPaths": [
    "apps/api/src/composition-root.ts",
    "apps/web/src/app-server.ts",
    "apps/web/src/assistant-panel.ts",
    "apps/web/src/ledger-styles.ts",
    "apps/web/src/message-catalog.ts",
    "apps/web/src/surface-runtime.ts",
    "apps/web/src/workflow-approvals.ts",
    "apps/web/test/browser/message-catalog.spec.ts",
    "apps/web/test/surface-runtime-contract.test.ts",
    "learnings.md",
    "packages/postgres-provider/src/composed-application-runtime.ts",
    "packages/postgres-provider/src/workflow-execution.ts",
    "packages/postgres-provider/src/workflow-gateway.ts",
    "packages/postgres-provider/src/workflow-worker.ts",
    "test/postgres/workflow-consumer.test.ts"
  ],
  "symbols": [
    {
      "path": "packages/postgres-provider/src/workflow-execution.ts",
      "name": "PostgresWorkflowExecution"
    },
    {
      "path": "apps/web/src/surface-runtime.ts",
      "name": "renderWorkflowApprovals"
    }
  ]
}
```

## Test it yourself

- In the PostgreSQL receipt journey, verify that a release approver with another company's grant or without the action grant cannot decide or read the plan. Check that no result is written and a current authorized approval succeeds.
- Open **Approvals** in the opt-in local demo. Inspect the exact inputs and approve or decline. In the hosted journey, advance the injected clock across two days and confirm one wake after restart and suspension on rollback.
