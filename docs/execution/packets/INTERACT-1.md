# INTERACT-1 — purchase, receive and sell with fewer clicks

No owned Critical-path changes. Phase 3 of the loop UX plan.

## Claims

- Contract facts determine direct application; consequential tasks explicitly confirm a server preparation.
- Task stages and verified outcomes replace named regions in place, with ordinary page forms available.
- Existing live authorization, atomic posting and verified read-back remain authoritative.
- Stock impact rows use existing server read models and exact decimal arithmetic.
- Task defaults derive from selected rows; pickers show declared figures and stage counts share the batched loader.
- Today reads five To receive rows in the page snapshot.
- Save and place finishes verified draft saves before placement and retains plain recovery.

## Slices and gates

- 0: merged `b218bf03`, PR #88, [CI 44393050211](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44393050211) green.
- 1: merged `d775c078`, PR #93, [CI 44407145880](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44407145880) green.
- 2: merged `ca9812e7`, PR #96, [CI 44488258241](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44488258241) green.
- 3: merged `b21f3851`, PR #106, [CI 44522209346](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44522209346) green.
- 4: merged `e0242bc9`, PR #108, [CI 44529083449](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44529083449) green.
- 5: ready for full CI. Focused units pass; GitHub CI is the acceptance gate.

## Decisions

- The production scorecard replaces the test-only spike. [Baseline and spike measurements](../evidence/interact-1-spike.md).
- Additive v6 keys have compiler accept/refuse coverage; release lineage and coverage are re-derived (ADR-0066).
- Normal git metadata is read-only; isolated metadata in `/tmp` tracks this chartered worktree.
- Exact-minute browser fills canonicalize zero seconds without changing the instant (CI reproduction passed).
- Mid-packet checkpoint: no whole-app review trigger; no new correctness domain or fan-out.

- Save draft resets earlier placement intent; narrowed-role offers are checked live and invocation still authorizes.
- CI found line details intercepting Save draft; the save bar stays above them, with both actions checked.
- Inherited docs-only DECLUTTER; canonical inputs and prepared release bytes are unchanged.

```record-claim
{
  "schemaVersion": "northstar.record-claim/v1",
  "packet": "INTERACT-1",
  "base": "129e59c4a5cfbefcad42b9c14efa164b18b797e7",
  "head": "76cd99593132558f23394634408eb0bf25788d3c",
  "changedPaths": [
    "apps/web/release/app.authored.json",
    "apps/web/release/app.compiled.json",
    "apps/web/src/document-editor.ts",
    "apps/web/src/ledger-styles.ts",
    "apps/web/test/browser/loop-scorecard.composed-application.spec.ts",
    "apps/web/test/browser/loop-scorecard.ts",
    "apps/web/test/browser/order-entry.spec.ts",
    "apps/web/test/browser/purchase-pricing.spec.ts",
    "packages/canonical-model/src/schemas.ts",
    "packages/canonical-model/src/surface-workspace.ts",
    "packages/domain/src/app/order-entry.ts",
    "test/compiler/g2-module-conformance.test.ts",
    "test/fixtures/g2/language-conformance/coverage-decisions.json",
    "test/integration/surface-data-binding.test.ts",
    "test/unit/canonical-model/surface-launcher.test.ts"
  ],
  "symbols": [
    {
      "path": "apps/web/src/document-editor.ts",
      "name": "documentEditor"
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
- 5: fill a new PO or SO and use Save and place. Use Save draft when placement should wait; placement failure links to the saved draft.
