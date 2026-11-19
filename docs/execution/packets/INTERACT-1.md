# INTERACT-1 — purchase, receive and sell with fewer clicks

Measurement probe only; no slice 4 PR or integration. Actual submission follows slice 3 on main.

## Claims

- Contract facts determine direct application; consequential tasks explicitly confirm a server preparation.
- Task stages and verified outcomes replace named regions in place, with ordinary page forms available.
- Existing live authorization, atomic posting and verified read-back remain authoritative.
- Stock impact rows use existing server read models and exact decimal arithmetic.
- Task defaults derive from selected rows; pickers show declared figures and stage counts share the batched loader.
- Today reads five To receive rows in the page snapshot.

## Slices and gates

- 0: merged `b218bf03`, PR #88, [CI 44393050211](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44393050211) green.
- 1: merged `d775c078`, PR #93, [CI 44407145880](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44407145880) green.
- 2: merged `ca9812e7`, PR #96, [CI 44488258241](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44488258241) green.
- 4: ready for full CI. Focused units pass; GitHub CI is the acceptance gate.

## Decisions

- The production scorecard replaces the test-only spike. [Baseline and spike measurements](../evidence/interact-1-spike.md).
- Additive v6 keys have compiler accept/refuse coverage; release lineage and coverage are re-derived (ADR-0066).
- Normal git metadata is read-only; isolated metadata in `/tmp` tracks this chartered worktree.
- Exact-minute browser fills canonicalize zero seconds without changing the instant (CI reproduction passed).
- Mid-packet checkpoint: no whole-app review trigger; no new correctness domain or fan-out.

- Home retains its existing ceiling until this probe measures the preview read.

```record-claim
{
  "schemaVersion": "northstar.record-claim/v1",
  "packet": "INTERACT-1",
  "base": "364fd53f85f7b270daa38c7948a3d4c05d99d078",
  "head": "5ff06d982749d47c66d440c323d2ce50ebd64dec",
  "changedPaths": [
    "apps/web/release/app.authored.json",
    "apps/web/release/app.compiled.json",
    "apps/web/src/component-registry.ts",
    "apps/web/src/surface-launcher.ts",
    "apps/web/src/surface-runtime.ts",
    "apps/web/test/browser/look.composed-application.spec.ts",
    "packages/canonical-model/src/schemas.ts",
    "packages/canonical-model/src/surface-launcher.ts",
    "packages/domain/src/app/today.ts",
    "test/compiler/g2-module-conformance.test.ts",
    "test/fixtures/g2/language-conformance/coverage-decisions.json",
    "test/unit/canonical-model/surface-launcher.test.ts"
  ],
  "symbols": [
    {
      "path": "apps/web/src/surface-launcher.ts",
      "name": "launcherTiles"
    }
  ]
}
```

## Test it yourself

- 0: compare INTERACT_SPIKE in the linked browser job; receipt 2/0 and shipment 4/0 clicks/loads.
- 1: Receive on a released PO, enter actual cost, and confirm the server preparation; the record updates in place. Disable JavaScript to exercise Review and Confirm page forms.
- 2: inspect each receipt line’s On hand, Reserved and Available changes; edit quantity and confirm the current prepared action. Try a signed adjustment.
- 3: inspect ordered cost and preferred location defaults, picker price and availability, and worklist stage counts. Clear a receipt line’s quantity to omit it.
- 4: open Today and follow a To receive row; compare it with the queue.
