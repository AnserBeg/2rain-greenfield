# INTERACT-1 — purchase, receive and sell with fewer clicks

No owned Critical-path changes. Phase 3 of the loop UX plan.

## Claims

- Contract facts determine direct application; consequential tasks explicitly confirm a server preparation.
- Task stages and verified outcomes replace named regions in place, with ordinary page forms available.
- Existing live authorization, atomic posting and verified read-back remain authoritative.
- Stock impact rows use existing server read models and exact decimal arithmetic.

## Slices and gates

- 0: merged `b218bf03`, PR #88, [CI 44393050211](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44393050211) green.
- 1: merged `d775c078`, PR #93, [CI 44407145880](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44407145880) green.
- 2: ready for full CI. Local format, typecheck, lint and focused units pass.

## Decisions

- The production scorecard replaces the test-only spike. [Baseline and spike measurements](../evidence/interact-1-spike.md).
- Additive v6 keys have compiler accept/refuse coverage; release lineage and coverage are re-derived (ADR-0066).
- Normal git metadata is read-only; isolated metadata in `/tmp` tracks this chartered worktree.
- Exact-minute browser fills canonicalize zero seconds without changing the instant (CI reproduction passed).
- Task preview budgets: measured 2/46/3/0 in CI 44426260000; +5 statements buys governed stock/location reads. Confirmation unchanged.
- Accepted main includes AGENT-5 and recovery; the workflow design note leaves existing contracts unchanged.
- Mid-packet checkpoint: no whole-app review trigger; no new correctness domain or fan-out.

```record-claim
{
  "schemaVersion": "northstar.record-claim/v1",
  "packet": "INTERACT-1",
  "base": "7df1ea960f03528926be71e55cbbea7cfcbb77a3",
  "head": "27d6d6222e2a158f3ed9d8344c60cda7eefd959f",
  "changedPaths": [
    "apps/web/release/app.authored.json",
    "apps/web/release/app.compiled.json",
    "apps/web/src/ledger-styles.ts",
    "apps/web/src/surface-client.ts",
    "apps/web/src/surface-composition.ts",
    "apps/web/test/browser/composed-application.spec.ts",
    "apps/web/test/browser/inventory-documents.spec.ts",
    "apps/web/test/browser/inventory-warehouse-mode.spec.ts",
    "apps/web/test/browser/order-pages.spec.ts",
    "apps/web/test/browser/sale-fulfillment.composed-application.spec.ts",
    "packages/canonical-model/src/schemas.ts",
    "packages/canonical-model/src/surface-composition.ts",
    "packages/domain/src/inventory/workspace.ts",
    "packages/domain/src/purchasing/workspace.ts",
    "packages/domain/src/sales/workspace.ts",
    "test/compiler/g2-module-conformance.test.ts",
    "test/fixtures/g2/language-conformance/coverage-decisions.json",
    "test/helpers/assert-composed-inventory.ts",
    "test/performance/page-budgets.ts",
    "test/unit/canonical-model/surface-composition.test.ts",
    "test/unit/inventory-definition.test.ts",
    "test/unit/workspace-contract.test.ts"
  ],
  "symbols": [
    {
      "path": "apps/web/src/surface-composition.ts",
      "name": "stockImpactRows"
    },
    {
      "path": "test/helpers/assert-composed-inventory.ts",
      "name": "assertStockPostingActions"
    }
  ]
}
```

## Test it yourself

- 0: compare INTERACT_SPIKE in the linked browser job; receipt 2/0 and shipment 4/0 clicks/loads.
- 1: Receive on a released PO, enter actual cost, and confirm the server preparation; the record updates in place. Disable JavaScript to exercise Review and Confirm page forms.
- 2: inspect each receipt line’s On hand, Reserved and Available changes; edit quantity and confirm the current prepared action. Try a signed adjustment.
