# STOCK-COUNTS-fixes — fractional posting, blind recounts and reader admission

Critical posting kernel. This packet closes Fable findings F1–F5 on STOCK-COUNTS-2.

## Claims

1. Fractional counts post signed variances below one, and a reversal restores the original balance exactly. The kernel still refuses negative zero.
2. Returning to counting clears the three review figures and retains physical entries. Counting mode is fixed after Start, including during a recount.
3. The rung-34 reader answers an item query on the prior release and names the unsupported surface capability on the stock-count release. The test checks the prior release's persisted definition and artifact bytes.
4. Workflow commands and evidence require the existing rung 35 even without editor defaults. The standalone inventory definition keeps its earlier evidence shape when document entry is absent.
5. Each transition requires its own grant. A company-scoped principal cannot use another company's count or read its lines in the same tenant and environment.

## Decisions

- Blind counting relies on a counter role with count entry and without posted-stock read. Supervisors can separately hold stock read and the grants to Review or Return to counting.
- Correct and Reverse use the existing create and post permissions and the normal intervening transition grants. They have no separate grant.
- Return to counting clears the reviewed figures in open and blind counts while keeping the physical entries and advancing each affected line revision.
- Reader 35 already covers the released stock-count definition. This packet corrects its compiler trigger and introduces no migration.

## Controls

- `stock-count-negative-fraction` checks downward posting and reversal in the kernel. `stock-count-reopen-keeps-figures`, `stock-count-mode-still-editable` and `stock-count-can-reset-to-draft` cover recount evidence and mode.
- `stock-count-reader-follows-editor-only` checks the stock workflow without line defaults. The PostgreSQL proof uses the preceding archived loader and a governed query.
- The route-owner, reversal-completeness, duplicate-product, negative-physical, blind-book and Post-grant controls isolate the checks from neighbouring layers.

## Gates

CI tier: full https://github.com/AnserBeg/2rain-greenfield/actions/runs/44844516542

Expected-red run for the executable head: https://github.com/AnserBeg/2rain-greenfield/actions/runs/44844296951

## Try it yourself

Start a blind cycle count as a supervisor. Enter a physical quantity half a unit below the book, review it, then return it to counting. A counter can still see and enter the physical count, while expected and variance are blank and the stock lists refuse their role. Review and post the recount. Check the half-unit movement, then reverse it as a supervisor and compare the balance.

```record-claim
{
  "schemaVersion": "northstar.record-claim/v1",
  "packet": "STOCK-COUNTS-fixes",
  "base": "67e4efce31eb663f12d6f161aa91c0ce1220dffc",
  "head": "7b05412d3817033ab52684ea2d63d08143bb79cf",
  "changedPaths": [
    "packages/compiler/src/conformance.ts", "packages/compiler/src/projections.ts",
    "packages/domain/src/inventory/definition.ts", "packages/postgres-provider/src/inventory-posting-service.ts",
    "packages/postgres-provider/src/module-runtime-interpreter.ts", "packages/postgres-provider/src/stock-count-route.ts",
    "test/architecture/surface-grammar-conformance.test.ts", "test/compiler/inventory-contract.cases.ts",
    "test/evidence/STOCK-COUNTS-fixes.expected-red.json", "test/helpers/application-before-stock-count-workflow.ts",
    "test/helpers/application-without-line-create-values.ts", "test/helpers/archived-runtime-process.ts",
    "test/helpers/order-entry-fixture.ts", "test/postgres/address-connector.test.ts",
    "test/postgres/billing-terms.test.ts", "test/postgres/customization-display.test.ts",
    "test/postgres/customization-formulas.test.ts", "test/postgres/customization-inspection.test.ts",
    "test/postgres/customization-validation.test.ts", "test/postgres/customization.test.ts",
    "test/postgres/document-attachments.test.ts", "test/postgres/inventory-stock-count.test.ts",
    "test/postgres/inventory-stock-counts.test.ts", "test/postgres/request-runtime-view.test.ts",
    "test/unit/customization.test.ts", "test/unit/inventory-definition.test.ts"
  ],
  "symbols": [
    {"path": "packages/compiler/src/conformance.ts", "name": "hasStockCountWorkflow"},
    {"path": "packages/domain/src/inventory/definition.ts", "name": "inventoryModuleDefinition"},
    {"path": "packages/postgres-provider/src/inventory-posting-service.ts", "name": "canonicalDecimalPattern"},
    {"path": "packages/postgres-provider/src/module-runtime-interpreter.ts", "name": "requireStockCountCountingMode"},
    {"path": "packages/postgres-provider/src/stock-count-route.ts", "name": "executeStockCountChange"},
    {"path": "test/helpers/application-before-stock-count-workflow.ts", "name": "withoutStockCountWorkflow"},
    {"path": "test/helpers/archived-runtime-process.ts", "name": "archivedServingQuery"}
  ]
}
```
