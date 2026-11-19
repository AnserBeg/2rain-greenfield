# WORKFLOW-1 — goods receipt inspection workflow

Status — slice 1 candidate, host only. Fable 5.2 approved the amended ADR to build in slices. The next slices require an orchestrator go-ahead.

## Claims

1. Each attempt uses a worker with 16 MiB fixed linear memory, a 4 MiB QuickJS heap ceiling, a cooperative CPU budget and an independent watchdog. The guest has no ambient network, filesystem, real clock or random APIs.
2. The issued release view supplies the typed SDK and its callable catalog. The supervisor checks canonical JSON, target grants and inputs before exposing a request.
3. Journal reload preserves the pending request and completed prefix through every mocked effect. An exact result retry is idempotent. Changed requests and unconsumed prefixes quarantine with the cursor preserved.
4. Type-check and lint precede emission. The run-twice harness uses fixtures for the first run and a fresh replay that consumes the complete journal and yields no new effect.

## Decisions

- [ADR-0073](../../decisions/ADR-0073-workflow-isolate-and-authority.md) records the 2026-11-18 bakeoff. Both QuickJS candidates passed isolation, effect and limit probes. Emscripten 0.32.0 also admitted host-owned fixed linear memory. The pin shipped on npm on 2026-02-16.
- The pinned Party fixture exercises Q0 and O0 calls. Slice 1 admits SDK operations with supported compiled input contracts and uses the existing query and mutation input validators. TypeScript uses the repository's existing 5.9.3 pin for the compile gate.
- Every Tier B operation, reachable intersection with a published Tier B dependency, or unknown input/effect intersection requires exact human confirmation. The owning Semantic Operation alone can produce a Tier B fact.
- The later activation hook is a Critical touch of the 0005 receipts table. It runs only when the incoming or outgoing release declares workflows. The operator gets bulk cancel and same-pin retry. Successor retry is deferred and Gate N2 wording sits with the owner.
- Earlier canonical-model, compiler, verifier, runtime-view and host prototype edits were preserved at `cd59ab9b` on `wip/WORKFLOW-1-later-slices`.

## Gates

- Nine focused host tests cover cooperative and watchdog pre-emption, heap and ambient API refusal, invalid and repeated dispatch, refused grants and inputs, journal reload, replay quarantine and unmocked calls.
- The compiled-path smoke verified that a plain Node worker can load the supervisor-resolved engine and yield a call.
- The host test is registered in the architecture test inventory for the integration suite.
- Hosted CI, including dependency and secret scans, is the integration gate. Slice 1 changes no Critical path.
- Slice 2 owns the migration and event consumer. Slice 3 owns verifier admission and reader floor. Slice 4 owns durable timers, approvals and the browser journey.
- The rest of N2 includes document templates, business-object-linked communication and consent, and email behind a connector with deduplicated delivery and reconciliation.

```record-claim
{
  "schemaVersion": "northstar.record-claim/v1",
  "packet": "WORKFLOW-1",
  "base": "7df1ea960f03528926be71e55cbbea7cfcbb77a3",
  "head": "d12d0279d46497ac3885e36ef48ffa250159b814",
  "changedPaths": [
    "packages/postgres-provider/package.json",
    "packages/postgres-provider/src/module-runtime-interpreter.ts",
    "packages/postgres-provider/src/workflow-compile.ts",
    "packages/postgres-provider/src/workflow-isolate-worker.ts",
    "packages/postgres-provider/src/workflow-isolate.ts",
    "packages/postgres-provider/src/workflow-run.ts",
    "packages/postgres-provider/src/workflow-sdk.ts",
    "packages/runtime/src/semantic-query-gateway.ts",
    "pnpm-lock.yaml",
    "test/architecture/repository-hygiene.test.ts",
    "test/integration/workflow-host.test.ts"
  ],
  "symbols": [
    {
      "path": "packages/postgres-provider/src/workflow-compile.ts",
      "name": "compileWorkflowBody"
    },
    {
      "path": "packages/postgres-provider/src/workflow-isolate.ts",
      "name": "runWorkflowIsolate"
    },
    {
      "path": "packages/postgres-provider/src/workflow-run.ts",
      "name": "InMemoryWorkflowRun"
    },
    {
      "path": "packages/postgres-provider/src/workflow-run.ts",
      "name": "verifyWorkflowReplay"
    },
    {
      "path": "packages/postgres-provider/src/workflow-sdk.ts",
      "name": "generateWorkflowSdk"
    }
  ]
}
```

## Test it yourself

Run `node --import tsx --test test/integration/workflow-host.test.ts`. Expect nine passing tests and observe the two distinct runtime budget refusals, journal restoration at each call, and quarantine after a replay mismatch. Run `scripts/check-records.sh` to validate the record.
