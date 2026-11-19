# INTERACT-1 — purchase, receive and sell with fewer clicks

No owned Critical-path changes. Phase 3 of the loop UX plan.

## Claims

- Contract facts determine direct application; consequential tasks explicitly confirm a server preparation.
- Task stages and verified outcomes replace named regions in place, with ordinary page forms available.
- Existing live authorization, atomic posting and verified read-back remain authoritative.
- Stock impact rows use existing server read models and exact decimal arithmetic.
- Task defaults derive from selected rows; pickers show declared figures and stage counts share the batched loader.

## Slices and gates

- 0: merged `b218bf03`, PR #88, [CI 44393050211](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44393050211) green.
- 1: merged `d775c078`, PR #93, [CI 44407145880](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44407145880) green.
- 2: merged `ca9812e7`, PR #96, [CI 44488258241](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44488258241) green.
- 3: ready for full CI. Focused units pass; GitHub CI is the acceptance gate.

## Decisions

- The production scorecard replaces the test-only spike. [Baseline and spike measurements](../evidence/interact-1-spike.md).
- Additive v6 keys have compiler accept/refuse coverage; release lineage and coverage are re-derived (ADR-0066).
- Normal git metadata is read-only; isolated metadata in `/tmp` tracks this chartered worktree.
- Exact-minute browser fills canonicalize zero seconds without changing the instant (CI reproduction passed).
- Mid-packet checkpoint: no whole-app review trigger; no new correctness domain or fan-out.

- CI 44499550504: reuse only actually counted queues; unread tiles retain their independent stage counts.

```record-claim
{
  "schemaVersion": "northstar.record-claim/v1",
  "packet": "INTERACT-1",
  "base": "d31e28314923c793a2f7458c86a8d682cf62b4b2",
  "head": "7a1e1f6dfc7434c0eda75c84debc4aea56c03a78",
  "changedPaths": [
    "apps/web/release/app.authored.json",
    "apps/web/release/app.compiled.json",
    "apps/web/src/document-editor.ts",
    "apps/web/src/editor-controls.ts",
    "apps/web/src/list-declaration.ts",
    "apps/web/src/surface-composition.ts",
    "apps/web/src/surface-runtime.ts",
    "apps/web/src/workspace-entry.ts",
    "apps/web/test/browser/loop-scorecard.ts",
    "apps/web/test/browser/order-entry.spec.ts",
    "apps/web/test/browser/order-pages.spec.ts",
    "packages/canonical-model/src/schemas.ts",
    "packages/canonical-model/src/surface-composition.ts",
    "packages/canonical-model/src/surface-workspace.ts",
    "packages/domain/src/app/order-entry.ts",
    "packages/domain/src/purchasing/workspace.ts",
    "packages/domain/src/sales/workspace.ts",
    "test/compiler/g2-module-conformance.test.ts",
    "test/fixtures/g2/language-conformance/coverage-decisions.json",
    "test/integration/surface-data-binding.test.ts",
    "test/unit/canonical-model/surface-composition.test.ts",
    "test/unit/canonical-model/surface-launcher.test.ts"
  ],
  "symbols": [
    {
      "path": "apps/web/src/surface-composition.ts",
      "name": "applyTaskDefaults"
    }
  ]
}
```

## Test it yourself

- 0: compare INTERACT_SPIKE in the linked browser job; receipt 2/0 and shipment 4/0 clicks/loads.
- 1: Receive on a released PO, enter actual cost, and confirm the server preparation; the record updates in place. Disable JavaScript to exercise Review and Confirm page forms.
- 2: inspect each receipt line’s On hand, Reserved and Available changes; edit quantity and confirm the current prepared action. Try a signed adjustment.
- 3: inspect ordered cost and preferred location defaults, picker price and availability, and worklist stage counts. Clear a receipt line’s quantity to omit it.
