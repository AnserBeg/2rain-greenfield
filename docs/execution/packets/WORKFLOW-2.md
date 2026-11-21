# WORKFLOW-2 — verify and review a workflow before approving it

Slices 1, 3 and 4 on the packet branch. Pre-tenant. No migration or reader rung.
[Accepted amendments to ADR-0073](../../decisions/ADR-0073-workflow-isolate-and-authority.md#workflow-2-amendments-2026-11-20-accepted-with-amendments-fable-2026-11-20) · [Original slice charter and trigger proofs](https://github.com/AnserBeg/2rain-greenfield/blob/0a9f7ca52304969c65092893f50375c90f8c2265/docs/execution/packets/WORKFLOW-2.md)

## Claims and decisions

1. Every sandbox request forks with an explicit environment containing only the wall-clock bound. Node reads the installed packages and cannot read the fixture connector key. A fresh verification child has 512 MiB old space, a 30 s deadline and a 1 MiB response cap.
2. Candidate admission formerly ran the replay on the request side of a database transaction. Both it and drafting now send the body, release declarations and admitted fixture calls to the child. Only the parent reads the database and writes verification evidence.
3. Customize displays the exact source, at most five ordered sample runs, conditional and loop call sites, inputs, uncovered sites and unused grants. A replay of the recorded prefix maps each call to its exact site. The lint requires direct SDK calls and literal targets.
4. Workflow approval checks the displayed review at the gesture. The release preparation binds the rendered text, versioned review digest and body digest. The gesture also covers the patch, pointer and fence. No workflow member or normalization step carries a review digest.
5. SDK v2 drops external event waits and caps sleep at 7,776,000,000 ms. Version and declaration digest select v1 for retained run pins. Upgrade replay uses the destination release catalogs. A retained wait conflicts as REMOVED_ACTION.
6. The live supervisor retries a CPU overrun once with the same pin and journal prefix. Both attempts write CONTROL evidence in the validated transaction. A repeated CPU overrun quarantines as cpu-limit-exceeded. A host watchdog expiry has its own reason.

## Remaining slices

- Slice 2 belongs to **AI-BUILD-1 slice 2**, including the generic repair loop, costs and evals. These slices add no Customize member and change no compiled chunk or stored definition shape.
- Slice 4a owns the tenant rate limiter. The three trigger slices follow it with their source audits, drafter and eval cases, company and loop controls, and reader-rung proofs.
- Slice 8 owns live per-step process isolation and the pre-tenant OS user/container and network boundary. The engine policy also requires a named owner and deputy before the first tenant. [Engine patch policy](../../operations/engine-patch-policy.md)

## Gates and controls

CI tier: full https://github.com/AnserBeg/2rain-greenfield/actions/runs/44868120892

The workflow-host tests exercise both fork kinds with credential sentinels, a protected key and a socket observer, the injected deadline, SDK contracts, reviewed bytes and retry outcomes. The PostgreSQL journey checks admission, durable control rows and a suspended v1 event wait. The browser journey refuses an external wait, reopens the pending review and approves the displayed digest. The historical pre-workflow reader answers an item query before its named refusal after activation.

## Test it yourself

- Slice 1 — `node --import tsx --test --test-name-pattern='both sandbox|unfinished workflow' test/integration/workflow-host.test.ts`. Both forks discard credentials and the parent refuses an expired draft.
- Slice 3 — `node --import tsx --test --test-name-pattern='review uses each|review traces|review lint|gesture binds' test/integration/workflow-host.test.ts`. Five examples, exact site coverage, indirect-call refusal and fenced review.
- Slice 4 — `node --import tsx --test --test-name-pattern='v2 drops|a CPU overrun' test/integration/workflow-host.test.ts`. Legacy and current contracts are distinct, and the CPU and watchdog attempts are distinguishable.

```record-claim
{
  "schemaVersion": "northstar.record-claim/v1",
  "packet": "WORKFLOW-2",
  "base": "0a9f7ca52304969c65092893f50375c90f8c2265",
  "head": "87accc9aa51bd74b4da86769923b84635ddb35a8",
  "changedPaths": [
    "apps/api/scripts/customize-cli.ts",
    "apps/api/src/staff-decisions.ts",
    "apps/web/src/customize-screen.ts",
    "apps/web/test/browser/customize-inspection.composed-application.spec.ts",
    "docs/execution/packets/WORKFLOW-2.md",
    "packages/customization/src/ai-draft.ts",
    "packages/customization/src/sandbox-loader.mjs",
    "packages/customization/src/sandbox-worker.ts",
    "packages/customization/src/sandbox.ts",
    "packages/customization/src/workflow-draft.ts",
    "packages/postgres-provider/src/customization-service.ts",
    "packages/postgres-provider/src/release-verification-service.ts",
    "packages/postgres-provider/src/workflow-bundle.ts",
    "packages/postgres-provider/src/workflow-compile.ts",
    "packages/postgres-provider/src/workflow-draft-worker.ts",
    "packages/postgres-provider/src/workflow-execution.ts",
    "packages/postgres-provider/src/workflow-isolate-worker.ts",
    "packages/postgres-provider/src/workflow-isolate.ts",
    "packages/postgres-provider/src/workflow-review.ts",
    "packages/postgres-provider/src/workflow-run.ts",
    "packages/postgres-provider/src/workflow-sdk-version.ts",
    "packages/postgres-provider/src/workflow-sdk.ts",
    "packages/postgres-provider/src/workflow-verification.ts",
    "test/integration/workflow-host.test.ts",
    "test/postgres/workflow-consumer.test.ts",
    "test/unit/production-start.test.ts"
  ],
  "symbols": [
    {
      "path": "packages/postgres-provider/src/workflow-review.ts",
      "name": "renderWorkflowReview"
    }
  ]
}
```
