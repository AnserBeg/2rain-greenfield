# INTERACT-1 — purchase, receive and sell with fewer clicks

No owned Critical-path changes. Phase 3 of the loop UX plan.

## Claims

- Contract facts determine direct application; consequential tasks still explicitly confirm a server preparation.
- Native task stages and verified outcomes replace named regions in place. Page submits remain available.
- The existing live gateway and read-back remain the writer and verifier; ADR-0071 bounds task reads.

## Slices and gates

- 0: merged `b218bf03`, PR #88, all 16 jobs green in [CI 44393050211](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44393050211). [Measured spike](../evidence/interact-1-spike.md).
- 1: ready for CI. Local format, typecheck, lint and focused units pass. Full ADR-0036 amendment is in the PR.
- 2–5: committed drafts; integration follows CI in order.

## Decisions

- The production transport replaces the test-only spike; the executable scorecard now measures production task stages.
- Exact-minute browser fills canonicalize zero seconds without changing their instant (CI reproduction passed).
- Read-only normal git metadata requires isolated metadata in `/tmp`, tracking only this worktree.
- Mid-packet checkpoint: no whole-app review trigger; no new correctness domain or fan-out.

```record-claim
{
  "schemaVersion": "northstar.record-claim/v1",
  "packet": "INTERACT-1",
  "base": "8ba38fb9af241dc2ed3a82dc928b873b3c44e067",
  "head": "5bef7df186af40eb7af0e00b44705cde81d90598",
  "changedPaths": [
    "apps/web/src/app-server.ts",
    "apps/web/src/surface-client.ts",
    "apps/web/src/surface-composition.ts",
    "apps/web/src/surface-runtime.ts",
    "apps/web/test/browser/complete-task.ts",
    "apps/web/test/browser/customer-defaults.spec.ts",
    "apps/web/test/browser/inventory-catalog-aliases.spec.ts",
    "apps/web/test/browser/inventory-locations.spec.ts",
    "apps/web/test/browser/inventory-warehouse-mode.spec.ts",
    "apps/web/test/browser/loop-scorecard.composed-application.spec.ts",
    "apps/web/test/browser/loop-scorecard.ts",
    "apps/web/test/browser/meta-sales.spec.ts",
    "apps/web/test/browser/order-entry.spec.ts",
    "apps/web/test/browser/order-pages.spec.ts",
    "apps/web/test/browser/payables.spec.ts",
    "apps/web/test/browser/price-list-pricing.spec.ts",
    "apps/web/test/browser/purchase-approvals.spec.ts",
    "apps/web/test/browser/purchase-pricing.spec.ts",
    "apps/web/test/browser/receivables-counter-sale.spec.ts",
    "apps/web/test/browser/receivables-credit.spec.ts",
    "apps/web/test/browser/receivables.spec.ts",
    "apps/web/test/browser/receiving.composed-application.spec.ts",
    "test/integration/surface-data-binding.test.ts"
  ],
  "symbols": [
    {
      "path": "apps/web/src/surface-composition.ts",
      "name": "taskCanApplyDirectly"
    }
  ]
}
```

## Test it yourself

- Slice 0: compare `INTERACT_SPIKE` in the linked browser job; receipt 2/0 and shipment 4/0 clicks/loads.
- Slice 1: open a released PO, Receive, enter actual cost, and confirm the server preparation; the order updates in place. With JavaScript disabled, use Review then Confirm.
