# WORKFLOW-1 — goods receipt workflows

Slices 1 and 2 and the first correction landed. Round 2 closes the five open verification findings with one Critical migration. The next step is the orchestrator's narrow verification before slice 3.

## Claims

1. The verifier role publishes evidence for the exact release and definition digest. Human approval freezes the set. Activation copies it into the exact pointer fence.
2. Only the human-decision function can decide an approval. Replay derives the branch from that decision for the exact request digest and fence.
3. The Tier B closure comes from pinned compiler projections, including owned children and transitive relations. The gate requires exact operation and input-contract digests.
4. Deterministic operation failures quarantine the run. Each batch rotates attempted runs so retryable failures leave slots for later work.
5. The workflow gateway commits cross-company query denials under the automation principal and WORKFLOW channel before suspending the run.

## Decisions

- QuickJS Emscripten 0.32.0 won on fixed host-owned WASM memory. Both candidates passed isolation, dispatch, and limit probes. [ADR-0073](../../decisions/ADR-0073-workflow-isolate-and-authority.md)
- Tier B calls, reachable intersections, and incomplete proofs require exact human confirmation. Only the owning capability can create a Tier B fact.
- Seed the Tier B closure conservatively with first-party storage and capability writes. A receipt reference on an independent tenant record does not make that record a receipt dependency.
- Treat pre-correction evidence and decisions as historical. A trusted definition set needs verification and a fresh human approval.
- The PostgreSQL journey uses the verifier role with test-provisioned credentials. Canonical authoring, timers, the Approvals worklist, and the Inspection browser journey are still ahead.
- Documents, communication and email, and connectors remain later N2 work.

## Gates

- Slice 1 [CI 44456002463](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44456002463), slice 2 [CI 44477729782](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44477729782), and round 1 [CI 44497680722](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44497680722).
- Round 2 adds a compiler control and extends the PostgreSQL receipt journey. The integration CI run is recorded in the ledger.

```record-claim
{
  "schemaVersion": "northstar.record-claim/v1",
  "packet": "WORKFLOW-1",
  "base": "fc56f4a0af8b4dfbff4692906c5b45c34eae4bbc",
  "head": "4a34e0fea1777d75d658898de3c0e67c5c4c449d",
  "changedPaths": [
    "db/migrations/0041_workflow_authority.sql",
    "db/schema.snapshot.json",
    "learnings.md",
    "packages/compiler/src/index.ts",
    "packages/compiler/src/workflow-dependencies.ts",
    "packages/postgres-provider/src/workflow-consumer.ts",
    "packages/postgres-provider/src/workflow-execution.ts",
    "packages/postgres-provider/src/workflow-gateway.ts",
    "packages/postgres-provider/src/workflow-verification.ts",
    "test/architecture/release-persistence-boundary.test.ts",
    "test/integration/workflow-host.test.ts",
    "test/postgres/inventory-storage.test.ts",
    "test/postgres/migrations.test.ts",
    "test/postgres/module-storage-transition.test.ts",
    "test/postgres/trust-substrate.test.ts",
    "test/postgres/workflow-consumer.test.ts"
  ],
  "symbols": [
    {"path": "packages/compiler/src/workflow-dependencies.ts", "name": "workflowTierBDependencies"},
    {"path": "packages/postgres-provider/src/workflow-verification.ts", "name": "recordVerifiedWorkflow"},
    {"path": "packages/postgres-provider/src/workflow-execution.ts", "name": "PostgresWorkflowExecution"},
    {"path": "packages/postgres-provider/src/workflow-gateway.ts", "name": "PostgresWorkflowGateway"}
  ]
}
```

## Test it yourself

- Run `node --import tsx --test --test-name-pattern='workflow verification derives' test/integration/workflow-host.test.ts` to check the transitive Tier B closure.
- Run the [PostgreSQL receipt journey](../../../test/postgres/workflow-consumer.test.ts) in CI shard 3. Check that late evidence stays out of the approved set, a duplicate create is quarantined, a cross-company denial is audited, and a forged journal result cannot override a human approval or decline.
