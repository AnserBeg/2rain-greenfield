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

```record-claim
{
  "schemaVersion": "northstar.record-claim/v1",
  "packet": "WORKFLOW-1",
  "base": "238b98a6cbb88171983f395ec23179eb4d73b24e",
  "head": "35c0de4a3b8bcbd0cebee3f70beab792f21e4f6c",
  "changedPaths": [
    ".github/workflows/ci.yml", "apps/web/test/browser/customize-inspection.composed-application.spec.ts",
    "packages/canonical-model/src/normalize.ts", "packages/canonical-model/src/schemas.ts",
    "packages/canonical-model/src/workflows.ts", "packages/compiler/src/compiler.ts",
    "packages/compiler/src/index.ts", "packages/compiler/src/projections.ts",
    "packages/compiler/src/workflows.ts", "packages/customization/src/ai-draft.ts",
    "packages/customization/src/apply.ts", "packages/customization/src/patch.ts",
    "packages/customization/src/render.ts", "packages/customization/src/targets.ts",
    "packages/customization/src/workflow-draft.ts", "packages/postgres-provider/src/composed-application-runtime.ts",
    "packages/postgres-provider/src/customization-service.ts", "packages/postgres-provider/src/release-verification-service.ts",
    "packages/postgres-provider/src/request-runtime-view-service.ts", "packages/postgres-provider/src/workflow-admission.ts",
    "packages/postgres-provider/src/workflow-bundle.ts", "packages/postgres-provider/src/workflow-execution.ts",
    "packages/postgres-provider/src/workflow-verification.ts", "packages/postgres-provider/src/workflow-worker.ts",
    "packages/runtime/src/request-runtime-view.ts", "test/architecture/repository-hygiene.test.ts",
    "test/fixtures/g2/language-conformance/coverage-decisions.json", "test/helpers/archived-customization-runtime.ts",
    "test/helpers/archived-runtime-process.ts", "test/helpers/language-coverage-packages.ts",
    "test/integration/workflow-admission.test.ts", "test/postgres/request-runtime-view.test.ts"
  ],
  "symbols": [
    {
      "path": "packages/postgres-provider/src/release-verification-service.ts",
      "name": "releaseVerificationBinding"
    },
    {
      "path": "packages/postgres-provider/src/workflow-admission.ts",
      "name": "verifyWorkflowDefinitions"
    }
  ]
}
```

## Test it yourself

- Open the Customization rules browser runner in [CI 44711875228](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44711875228). Find **a drafted receipt workflow links an inspection and requests escalation after two days**. It drafts and activates the change, posts a receipt, opens its link from the pending Inspection and advances the clock to the approval request.
- In the opt-in local demo, open **Customize → Live workflows → View code** to check the trigger, grants and source. Open **Approvals** to inspect the exact operation inputs and target company.
