# WORKFLOW-1 — goods receipt workflows

Status — slices 1 and 2 integrated at `8ffab635` and `5dc9c849`. Slice 2 corrective candidate covers the 14 findings in the orchestrator's independent read. The forward migration is Critical. Slice 3 awaits the narrow re-read.

## Claims

1. Verified activation captures exact definition digests and unattended-operation proofs. Later definition inserts do not change an active fence's subscriptions.
2. Only the authenticated request role can decide a plan, with current human eligibility and the exact pending digest and fence. The worker can propose pending plans.
3. Semantic mutations lock the runnable run through commit. Cancellation and same-pin retry each recheck operator authority under lock.
4. Worker scan positions and receipt dispositions commit together. The activation hook seeds from indexed unresolved receipt keys. Source reads use claiming columns and current subscriptions.
5. Replay runs outside the pointer lock. Permanent guest errors quarantine one run. Oversized committed results park with a bounded receipt reference.
6. The supervised scheduler uses dedicated worker and runtime pools and defaults off. Semantic query denials record the automation principal and the WORKFLOW channel.

## Decisions

- QuickJS Emscripten 0.32.0 won the bakeoff on fixed host-owned WASM memory. Both candidates passed isolation, dispatch, and limit probes. [ADR-0073](../../decisions/ADR-0073-workflow-isolate-and-authority.md)
- Every Tier B operation, reachable intersection, and incomplete dependency or effect proof requires exact human confirmation. Only the owning capability can create a Tier B fact.
- Admit unattended creates with exact release, operation, and input-contract digests plus verified reachable write evidence. The slice 2 fixture stages evidence with test privileges.
- Maintain the unresolved receipt index at the trust outbox boundary. The occurrence journal remains append-only.
- Refuse capability read-model queries at SDK admission until workflow policy and pinned executors are wired together.
- Canonical workflow projections, timers, the approvals worklist, and the Inspection browser journey remain later slices. Documents, communication and email, and connectors remain later N2 work.

## Gates

- Slice 1 [CI 44456002463](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44456002463) passed 16 jobs at `7daf2a52`, including dependency and secret scans.
- Slice 2 [CI 44477729782](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44477729782) passed before the independent read.
- The correction adds regression assertions to the PostgreSQL receipt journey and a focused scheduler supervision test. CI on the corrective packet tip gates integration.

```record-claim
{
  "schemaVersion": "northstar.record-claim/v1",
  "packet": "WORKFLOW-1",
  "base": "421bd8b82882ee24cbff87bb72914640e600aa6e",
  "head": "06870fbcc9d82e85a15b81cd61acad04f4528377",
  "changedPaths": [
    "apps/api/src/composition-root.ts",
    "apps/api/src/main.ts",
    "db/migrations/0038_workflow_review_fixes.sql",
    "db/schema.snapshot.json",
    "packages/postgres-provider/src/current-policy.ts",
    "packages/postgres-provider/src/module-runtime-interpreter.ts",
    "packages/postgres-provider/src/workflow-consumer.ts",
    "packages/postgres-provider/src/workflow-execution.ts",
    "packages/postgres-provider/src/workflow-gateway.ts",
    "packages/postgres-provider/src/workflow-isolate.ts",
    "packages/postgres-provider/src/workflow-run.ts",
    "packages/postgres-provider/src/workflow-sdk.ts",
    "packages/postgres-provider/src/workflow-worker.ts",
    "test/architecture/release-persistence-boundary.test.ts",
    "test/architecture/tenant-completeness.manifest.json",
    "test/integration/workflow-host.test.ts",
    "test/postgres/inventory-storage.test.ts",
    "test/postgres/migrations.test.ts",
    "test/postgres/module-storage-transition.test.ts",
    "test/postgres/trust-substrate.test.ts",
    "test/postgres/workflow-consumer.test.ts"
  ],
  "symbols": [
    {"path": "packages/postgres-provider/src/workflow-consumer.ts", "name": "PostgresWorkflowConsumer"},
    {"path": "packages/postgres-provider/src/workflow-execution.ts", "name": "PostgresWorkflowExecution"},
    {"path": "packages/postgres-provider/src/workflow-gateway.ts", "name": "PostgresWorkflowGateway"},
    {"path": "packages/postgres-provider/src/workflow-worker.ts", "name": "startWorkflowScheduler"}
  ]
}
```

## Test it yourself

- Run `node --import tsx --test --test-name-pattern='workflow scheduling' test/integration/workflow-host.test.ts`. Expect the default-off check and a successful poll after a failed pass.
- Run `node scripts/run-with-test-lock.mjs exclusive -- node --import tsx --test test/postgres/workflow-consumer.test.ts`. Expect only verified starts, a write refused after cancellation, an auditable parked receipt, exact human approval, and a later run progressing after an earlier run fails.
