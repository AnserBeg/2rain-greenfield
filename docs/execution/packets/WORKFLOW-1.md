# WORKFLOW-1 — goods receipt workflows

Latest integrated checkpoint is workflow display. Workflow authoring and verifier admission remain pending.

## Claims

1. Verified definition bindings and receipt source authority are release- and fence-pinned. The worker consumes the existing receipt outbox.
2. Approval decisions bind the exact release, operation inputs, receipt company, occurrence and fence. The approver needs live grants for the company and operation.
3. Sleep persists a UTC deadline and an exactly-once journaled wake. Stale waiting runs suspend. Approvals shows exact inputs and supports per-run retry or cancel results.
4. Customize shows the approved live definition and read-only source to workspace authors and release approvers.

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
- Workflow display at `f8393f9a`. Gates passed on [CI 44653100303](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44653100303).

```record-claim
{
  "schemaVersion": "northstar.record-claim/v1",
  "packet": "WORKFLOW-1",
  "base": "759938e7056eca4a094ff3077f9abb81ebb495fd",
  "head": "f8393f9a9220e55374244a6e570fcfd5175c1426",
  "changedPaths": [
    "apps/web/src/customize-screen.ts",
    "apps/web/test/browser/message-catalog.spec.ts",
    "packages/domain/src/purchasing/receipt-posted-event.ts",
    "packages/postgres-provider/src/customization-service.ts",
    "test/postgres/workflow-consumer.test.ts",
    "test/unit/customize-screen.test.ts"
  ],
  "symbols": [
    {
      "path": "apps/web/src/customize-screen.ts",
      "name": "renderCustomizeScreen"
    }
  ]
}
```

## Test it yourself

- In the PostgreSQL receipt journey, verify that a release approver with another company's grant or without the action grant cannot decide or read the plan. Check that no result is written and a current authorized approval succeeds.
- Open **Approvals** in the opt-in local demo. Inspect the exact inputs and approve or decline. In the hosted journey, advance the injected clock across two days and confirm one wake after restart and suspension on rollback.
- Open **Customize → Live workflows → View code** as a Customize author or release approver. Check the trigger, grants and summary. The workflow source is selectable and read-only.
