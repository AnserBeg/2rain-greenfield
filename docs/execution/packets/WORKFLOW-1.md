# WORKFLOW-1 — goods receipt workflows

Status — slice 1 integrated at `8ffab635`. Slice 2 integrated from `ad81cb91` after [CI 44477729782](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44477729782) passed. The migration and verified activation receipt hook are Critical. The orchestrator owns the trunk read. Slice 3 waits for the CUSTOMIZE-3 formula-family ADR and orchestrator authorization.

## Claims

1. A fresh bounded isolate yields one admitted SDK call at a time. It refuses ambient I/O, the real clock and randomness. Run-twice verification exercises deterministic replay.
2. A verified activation captures visible receipt outbox IDs in one statement. The worker joins posted receipts, validates their scope and source pin, and commits each disposition and its starts together.
3. Scoped outbox pages have a measured row bound. A scan wraps for out-of-order commits and durable dispositions prevent duplicate starts after restart.
4. The original engine, host, SDK, executable, release and fence bind a run. A request and outbox commit together. The exact semantic receipt recovers a write committed before the result journal.
5. The automation principal and activation approver's captured and current authority govern Tier A effects. A stale pin suspends the run. Bulk same-pin retry and cancel preserve evidence.

## Decisions

- [ADR-0073](../../decisions/ADR-0073-workflow-isolate-and-authority.md) selected QuickJS Emscripten 0.32.0. Both candidates passed isolation, dispatch and limit probes. Emscripten also accepted fixed host-owned WASM memory.
- Every Tier B operation, reachable dependency intersection and unknown input or effect intersection needs exact human confirmation. Only the owning operation can produce a Tier B fact.
- Plan §12.5 records the owner's v1 remedy. A person retries only after the original pin is verified active again or cancels the run.
- A tenant-authored Receipt Review with a stored receipt UUID proves the first Tier A run. CUSTOMIZE-4's Inspection and typed link are scheduled for a later slice.
- The verifier and floor belong to slice 3. Timers, approvals and the browser journey belong to slice 4. Documents, communication and email, and connectors remain later N2 work.

## Gates

- Slice 1 [CI 44456002463](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44456002463) passed 16 jobs at `7daf2a52`, including dependency and secret scans.
- Slice 2 [CI 44469719873](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44469719873) covers the migration, recorded receipt identity, crash after the outbox and operation commits, grants, and rollback and same-pin remedy. The PostgreSQL fixture stages its definition with test privileges. It passed in 104 seconds.
- `0036_workflow_substrate.sql` regenerates the platform snapshot. The receipt fixture measures the no-workflow hook against the same unhooked receipt insert.

```record-claim
{
  "schemaVersion": "northstar.record-claim/v1",
  "packet": "WORKFLOW-1",
  "base": "81ba7405e7512a806882f9ea3cff51af8c7115d9",
  "head": "b361c9848932c74050014e0bcd0d50073d999674",
  "changedPaths": [
    "db/migrations/0036_workflow_substrate.sql",
    "db/schema.snapshot.json",
    "packages/domain/src/purchasing/receipt-posted-event.ts",
    "packages/postgres-provider/package.json",
    "packages/postgres-provider/src/module-runtime-interpreter.ts",
    "packages/postgres-provider/src/workflow-consumer.ts",
    "packages/postgres-provider/src/workflow-execution.ts",
    "packages/postgres-provider/src/workflow-gateway.ts",
    "packages/postgres-provider/src/workflow-worker.ts",
    "test/architecture/release-persistence-boundary.test.ts",
    "test/architecture/repository-hygiene.test.ts",
    "test/architecture/tenant-completeness.manifest.json",
    "test/architecture/tenant-completeness.test.ts",
    "test/postgres/inventory-storage.test.ts",
    "test/postgres/migrations.test.ts",
    "test/postgres/module-storage-transition.test.ts",
    "test/postgres/trust-substrate.test.ts",
    "test/postgres/workflow-consumer.test.ts"
  ],
  "symbols": [
    {
      "path": "packages/postgres-provider/src/workflow-consumer.ts",
      "name": "PostgresWorkflowConsumer"
    },
    {
      "path": "packages/postgres-provider/src/workflow-execution.ts",
      "name": "PostgresWorkflowExecution"
    },
    {
      "path": "packages/postgres-provider/src/workflow-worker.ts",
      "name": "PostgresWorkflowWorker"
    }
  ]
}
```

## Test it yourself

- Slice 1. Run `node --import tsx --test test/integration/workflow-host.test.ts`. Expect nine passing tests, including the independent watchdog and replay quarantine.
- Slice 2. Run `node scripts/run-with-test-lock.mjs exclusive -- node --import tsx --test test/postgres/workflow-consumer.test.ts`. Expect one linked Receipt Review across restart, a suspended run that retries only on the same pin, and a refused grant that leaves no result.
