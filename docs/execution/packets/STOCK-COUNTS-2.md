# STOCK-COUNTS-2 — count one location, review, post, correct and reverse

Critical. Review status after integration is merged — unread.

## Claims

1. Start prepares a location's cycle or annual count, or lists the original count's items for a correction. Quick and opening counts start empty. Blind counts conceal expected and variance until review.
2. Review freezes the exact ledger quantities and variances. Post rechecks each item under the stock locks at the count's effective instant and refuses stale evidence or duplicate items.
3. A posted count admits one compensation at its location. A reversal derives the exact inverse of each original movement. Reviewed, cancelled and posted evidence is guarded against generic edits.
4. Post preserves the physical counts, type and mode at exact database precision. A committed retry returns the original effect and rebuilds the v4 digest with the accepted invocation's authorization evidence.
5. Tasks render and verify their stages in place. Post and Reverse show the existing stock impact rows.

## Decisions

- Carries the corrections from parked PR #23, including the route refusal for reopening a reversal.
- The workflow and optional storage fields use the compiled application release. The platform migration stream is unchanged.
- The existing Inventory transactions list shows authored adjustments and transfers. Count companions appear with their count's movements.
- The shared release verifier runs the rebuilt release through its existing plan and scoped probes.
- Assistant plans snapshot count lines before Start, Review and Post. The domain declares when a draft line edit is reversible. The route tests run in CI-2's inventory balances shard.
- Stock counts take reader rung 35, after replayed layouts at rung 34.
- No whole-app review trigger. This vertical extends the existing inventory correctness domain.

## Controls

- `count-expected-unchecked` and `count-repeats-an-item` cover stale variance and duplicate counted items.
- `count-second-compensation-allowed` and `count-companion-fence-removed` cover duplicate effects.
- `count-physical-quantity-last-decimal` and `count-replay-digest-uses-current-policy` cover exact evidence and replay.

## Gates

- [Hosted CI 44810544016](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44810544016) on the executable tip.
- [Expected-red controls 44810544178](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44810544178).
- `scripts/check-records.sh` passed. The hosted schema snapshot matches the committed snapshot byte for byte.
- The PostgreSQL inventory suite includes the workflow and kernel cases. The inventory browser job includes the count journey.

## Test it yourself

1. From the checkout, run `node scripts/run-with-test-lock.mjs shared -- node --import tsx test/helpers/order-entry-fixture.ts --serve` and open the printed URL.
2. Open Stock → Stock counts → New. Choose Calgary warehouse and Physical count, enter a narrative, remove the blank line and save. Start counting. The Field notebook line shows expected 10. Edit its physical count to 9, save, then Review.
3. Open Post, choose Review Post, and verify that On hand previews 10 → 9. Confirm Post and check the posted movement is −1.
4. Choose Correct and give a narrative. Open the linked correction, enter 10, save, review and post it. Open Reverse, give a reason and confirm. Check stock is back to 9. An unposted count can be cancelled. A blind count hides expected and variance through counting.

## Filed

- Count variances between −1 and 0 reach the existing v2 posting-decimal refusal tracked as `dec-negfrac`.

```record-claim
{
  "schemaVersion": "northstar.record-claim/v1",
  "packet": "STOCK-COUNTS-2",
  "base": "9beaabd99c2a7343fba1b444dd6a858d9f0d4599",
  "head": "5859eda6f99134f8f66edf7329002274a57df510",
  "changedPaths": [
    "apps/web/release/app.authored.json", "apps/web/release/app.compiled.json", "apps/web/release/current-policy-bindings.json", "apps/web/src/document-editor.ts",
    "apps/web/test/browser/composed-application.spec.ts", "apps/web/test/browser/customize-inspection.composed-application.spec.ts", "apps/web/test/browser/inventory-stock-counts.spec.ts", "apps/web/test/surface-runtime-contract.test.ts",
    "package.json", "packages/canonical-model/src/schemas.ts", "packages/canonical-model/src/surface-workspace.ts", "packages/compiler/src/conformance.ts",
    "packages/compiler/src/projections.ts", "packages/dev-tooling/src/predicate-dispatch-tripwire/index.ts", "packages/domain/src/app/builder.ts", "packages/domain/src/app/capability-children.ts",
    "packages/domain/src/app/list-declarations.ts", "packages/domain/src/app/order-entry.ts", "packages/domain/src/app/record-references.ts", "packages/domain/src/inventory/definition.ts",
    "packages/domain/src/inventory/workspace.ts", "packages/operations-agent/src/session.ts", "packages/postgres-provider/src/inventory-count-read-model.ts", "packages/postgres-provider/src/inventory-posting-capability-executor.ts",
    "packages/postgres-provider/src/inventory-posting-error.ts", "packages/postgres-provider/src/inventory-posting-service.ts", "packages/postgres-provider/src/module-runtime-interpreter.ts", "packages/postgres-provider/src/serving-gateways.ts",
    "packages/postgres-provider/src/stock-count-route.ts", "packages/runtime/src/request-runtime-view.ts", "test/agent/business-map.test.ts", "test/architecture/repository-hygiene.test.ts",
    "test/architecture/surface-grammar-conformance.test.ts", "test/architecture/test-reachability.test.ts", "test/compiler/inventory-contract.cases.ts", "test/evidence/STOCK-COUNTS-2.expected-red.json",
    "test/fixtures/g2/language-conformance/coverage-decisions.json", "test/helpers/application-without-line-create-values.ts", "test/helpers/assert-composed-inventory.ts", "test/helpers/reachability-producers.ts",
    "test/postgres/address-connector.test.ts", "test/postgres/composed-application.test.ts", "test/postgres/customization-display.test.ts", "test/postgres/customization-formulas.test.ts",
    "test/postgres/customization-inspection.test.ts", "test/postgres/customization-validation.test.ts", "test/postgres/customization.test.ts", "test/postgres/document-attachments.test.ts",
    "test/postgres/document-numbering.test.ts", "test/postgres/fresh-tenant-full-replay-schema.snapshot.json", "test/postgres/inventory-posting.test.ts", "test/postgres/inventory-stock-count.test.ts",
    "test/postgres/inventory-stock-counts.test.ts", "test/postgres/inventory-terminal-state.test.ts", "test/postgres/request-runtime-view.test.ts", "test/unit/canonical-model/field-numbering.test.ts",
    "test/unit/canonical-model/surface-list.test.ts", "test/unit/customization.test.ts", "test/unit/inventory-definition.test.ts", "test/unit/workspace-contract.test.ts"
  ],
  "symbols": [
    {"path": "packages/postgres-provider/src/inventory-posting-service.ts", "name": "assertCountExpectedIsLedger"}, {"path": "packages/postgres-provider/src/inventory-posting-service.ts", "name": "validateStockCountCommand"},
    {"path": "packages/postgres-provider/src/inventory-posting-service.ts", "name": "exactRowSql"}, {"path": "packages/postgres-provider/src/inventory-posting-service.ts", "name": "digestCoversAuthorization"},
    {"path": "packages/postgres-provider/src/stock-count-route.ts", "name": "stockCountBinding"}, {"path": "packages/postgres-provider/src/stock-count-route.ts", "name": "executeStockCountChange"},
    {"path": "packages/postgres-provider/src/stock-count-route.ts", "name": "deriveReversalLines"}, {"path": "packages/postgres-provider/src/inventory-count-read-model.ts", "name": "inventoryCountReadModel"},
    {"path": "packages/canonical-model/src/surface-workspace.ts", "name": "LINE_CREATE_VALUES_SURFACE_FLOOR"}, {"path": "packages/domain/src/inventory/workspace.ts", "name": "inventoryDocumentWorkspace"}
  ]
}
```
