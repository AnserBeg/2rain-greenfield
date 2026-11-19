# CUSTOMIZE-3 — the launch customization set

Slice 1 integrated the list-column work and saved list views from [PR #95](https://github.com/AnserBeg/2rain-greenfield/pull/95). Critical path: the approved patch-kind migration. The orchestrator resolved the numbering collision with CRITFIX-A.

## Claims

1. Arrange a list offers stored standard and custom fields, and the list query selects newly visible values. This includes Party's generic list.
2. Customize and plain-English drafting prepare a saved view with its own columns, default sort and declared filter choices. Approval shows those choices before activation.
3. Saved tabs batch counts through the list query under current policy. The page, CSV and assistant use the view's declared settings. Rollback restores the prior list.
4. Migration 0034 adds the planned patch kinds to the closed vocabulary. Its check requires a valid digest, lineage and channel. CUSTOMIZE-4 moved kind admission to the versioned parser and bound the stored identifier to the digested payload.
5. Today cards count a declared direct list or sum its declared numeric measure before pagination. The UI drill-through and assistant use the same list and saved-view conditions. Approval, replay and rollback preserve the card definition.
6. An operation restriction subtracts one role’s grants. Other roles keep their existing grants. Release activation and replay check the role in the destination environment.
7. Literal validation (F1/F3) adds a guard to bound create and update operations. Create checks after defaults. Update checks when a watched value changes. Form and assistant show the pinned message, and rollback restores the prior rules.
8. Cross-field validation compares same-record values and one declared, authorized parent field. Its guard checks create and changes to watched values under the same transaction.
9. Calculated display fields use exact-decimal add, subtract and multiply. The elected record page, list, CSV, assistant and read-back use the server result. The declaration carries no storage field or mutation input.

## Decisions

- Each saved view keeps the record title. It pins filter choices from the list's declared options. The list keeps its standard tabs, and the first saved view adds an All tab when needed.
- The optional view layout rides v6 under ADR-0047 §7. Surfaces require reader 24 and the assistant projection requires reader 3 for releases carrying it (reader 2 already serves assistant confirmation). The first-party re-baseline reproduced the checked-in release byte for byte.
- The next-free migration rule assigns 0034 after CRITFIX-A at the candidate base. The migration retains the patch table's existing policies, grants and append-only rules.
- STOP at slice 2 for canonical language admission. The orchestrator approved compiler-proved validation examples and the verifier change that reads them. Plan §5.12 and ADR-0012 still require the dedicated Formula Rule projection for tenant validation and calculated fields. The v3 adoption explicitly deferred that family to a tenant-customization language event ([4c](4c.md#adoption-boundary)).
- [ADR-0074](../../decisions/ADR-0074-formula-rule-and-workflow-projection-admission.md) accepts joint optional v6 admission with mandatory reader floors, tenant-runner byte parity, and explicit validation and replay contracts. Slices 2–4 must prove these gates before serving either family.
- Slice 5 subtracts the selected role’s grant for a named operation. Other roles still grant access. The actual Customize author sees active role keys and labels in their environment. A removal restores evaluation against current policy. Field restrictions remain a gap across query, read-back, exports and assistant output.
- [ADR-0075](../../decisions/ADR-0075-literal-validation-and-ordered-comparison.md) defines the optional v6 F1/F3 validation position. It keeps the existing inline predicate profile and uses the tenant business calendar. Declaring releases require operation reader 3. Validation keeps its own draft and approval alongside the Inspection builder’s grouped changes. The historical proof runs in PostgreSQL shard 3. Customize has its own browser job, and the release tests are spread across the existing PostgreSQL jobs. The secret scan covers the same Git history in two jobs. The boot-lock test polls from a fresh database snapshot.
- Slice 6 restores the candidate preserved at `e97ebd9f` and adds a CRITFIX-B replay witness. Catalog measures are separate by currency. Re-baselined the pre-tenant first-party artifact. The surface, agent and query readers require 25, 4 and 3 when their projections carry the corresponding keys.
- [ADR-0076](../../decisions/ADR-0076-cross-field-and-to-one-validation.md) admits the F2 and F4 positions on v6. Declaring releases require operation reader 4. The Sales order credit-limit example still needs a declared Customer relation and typed currency contract.
- [ADR-0077](../../decisions/ADR-0077-exact-decimal-calculated-display.md) admits the F6 read position on v6. Declaring releases require query reader 4. A display needs a direct read that already selects its operands.

## Gates

- Saved views and columns passed [CI 44457971677](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44457971677) and the closed patch-kind [control 44457971797](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44457971797).
- Today metrics passed [CI 44471090769](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44471090769) and the sum-before-pagination [control 44472880285](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44472880285).
- The ADR amendment passed [CI 44481530303](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44481530303) and the record checker. GitHub canceled the merge run when CRITFIX-C advanced main.
- Slice 2 passed [CI 44583050908](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44583050908) and [control 44583050933](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44583050933). PostgreSQL exercised the previous serving reader, tenant-runner envelope equality, grandfathering, and rollback. The browser and assistant exercised the same pinned rule.
- Slice 5 passed [CI 44510381381](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44510381381) and [four mutation controls](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44510308624). Migration 0040 follows activation recovery and the snapshot was rebuilt from all 40 migrations. Standard surface actions check current permission before being offered. The service stages the release and the patch audit row records the author.
- Slice 3 passed [CI 44600403784](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44600403784) and [control 44600403727](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44600403727). The actual older reader refused operation reader 4. The compiler, PostgreSQL, Customize and assistant exercised the field and path positions.
- Slice 4 candidate evidence is pending.

## Filed

- The full list/detail row also needs tenant controls for record-detail composition and formatting. F5 child aggregation remains pending a hard cardinality bound, visibility and absence rules, and a write concurrency protocol. [Archive](../current-plan-archive.md#filed-during-the-freeze).

```record-claim
{
  "schemaVersion": "northstar.record-claim/v1",
  "packet": "CUSTOMIZE-3",
  "base": "31d16d2d381b54ff1f2a7100d9264e7b2679a899",
  "head": "57bb745bfd4ff589559a9ee78f863904b4288f2c",
  "changedPaths": [
    "apps/web/src/customize-screen.ts", "apps/web/test/browser/customize-formulas.composed-application.spec.ts", "package.json", "packages/canonical-model/src/calculated-display-bindings.ts", "packages/canonical-model/src/calculated-display-projection.ts",
    "packages/canonical-model/src/calculated-display-schema.ts", "packages/canonical-model/src/calculated-display.ts", "packages/canonical-model/src/formula-validation-projection.ts", "packages/canonical-model/src/index.ts", "packages/canonical-model/src/normalize.ts",
    "packages/canonical-model/src/schemas.ts", "packages/compiler/src/calculated-display-plan.ts", "packages/compiler/src/compiler.ts", "packages/compiler/src/projections.ts", "packages/customization/src/ai-draft.ts",
    "packages/customization/src/apply.ts", "packages/customization/src/calculated-display-draft.ts", "packages/customization/src/index.ts", "packages/customization/src/patch.ts", "packages/customization/src/render.ts",
    "packages/customization/src/targets.ts", "packages/operations-agent/src/catalog.ts", "packages/postgres-provider/src/customization-service.ts", "packages/postgres-provider/src/module-runtime-interpreter.ts", "packages/postgres-provider/src/release-repository.ts",
    "packages/postgres-provider/src/request-runtime-view-service.ts", "packages/runtime/src/calculated-display.ts", "packages/runtime/src/request-runtime-view.ts", "test/architecture/repository-hygiene.test.ts", "test/evidence/CUSTOMIZE-3.expected-red.json",
    "test/fixtures/g2/language-conformance/coverage-decisions.json", "test/helpers/archived-customization-runtime.ts", "test/helpers/language-coverage-packages.ts", "test/helpers/reachability-producers.ts", "test/postgres/customization-display.test.ts",
    "test/postgres/customization-validation.test.ts", "test/unit/calculated-display.test.ts", "test/unit/customization-ai-draft.test.ts"
  ],
  "symbols": [
    {"path":"packages/canonical-model/src/calculated-display-bindings.ts","name":"bindCalculatedDisplayField"},
    {"path":"packages/compiler/src/calculated-display-plan.ts","name":"compileCalculatedDisplayFields"},
    {"path":"packages/runtime/src/calculated-display.ts","name":"withCalculatedDisplay"}
  ]
}
```

## Test it yourself
**Slice 0.** In Customize, add **Person ordering** to **Purchase order**, then draft, approve and activate. Save an order with that field filled. In **Arrange a list → Purchase orders → Choose columns**, clear **Hide Person ordering** and **Hide Notes**, then draft, approve and activate. The Purchase orders list shows both headings and the entered name. Roll back the arrangement and inspect the order to see its saved value.
**Slice 1.** In **Customize → Save a list view → Locations**, name the view **Warehouses**. Keep Code, move Name first and sort names descending. Set **Type** to **Warehouse**, then draft, review the diff, approve and activate. Open Locations and select **Warehouses**. Its count matches the filtered rows, Name is first and the rows are sorted. Roll back the view and reopen Locations to see its standard list.
**ADR-0074.** Read the decision's mandatory reader floor table and first patch payloads. Check the `unknown` rows in the truth table and the old-reader and tenant-runner adoption gates. The decision itself has no UI change.
**Slice 5.** As Manager, open **Customize → Restrict an action for a role**. Choose **Local Demo Full Release** and the Location Archive action. Draft, approve and activate. Open a Location as Buyer and check that Archive is gone. Draft removal from Customize, approve and activate to restore access under current policy.
**Slice 2.** In **Customize → Add validation → Item**, choose **Description** and **Require a value**, enter a message, then draft, approve and activate. Open **New item**, fill SKU, name and base unit, and save with Description blank. The form keeps your entries and shows your message. Fill Description and save. Roll back in Customize and verify that another item saves with Description blank.
**Slice 6.** In **Customize → Add a metric card to Today**, choose **Locations**, select **Set up metric** and name it **Location count**. Draft, approve and activate. Select the card on Today and compare its count with the destination list. For a sum, choose **Items** and **Price (CAD)**, then use its card to open the governed list. Roll back from Customize and verify that the latest card disappears.
**Slice 3.** In **Customize → Add validation → Location → Compare fields**, choose **Location name**, **Different from**, and the parent Location name. Draft, approve and activate. Create a Location with a parent, then try the parent’s exact name. Change the name, save, then roll back and verify that the original name is accepted.
**Slice 4.** In **Customize → Add a calculated display field → Item**, name it **Margin CAD** and choose **Price (CAD)**, **Subtract**, and **Standard cost (CAD)**. Choose **Items** as the optional list, then draft, approve and activate. Compare the margin on an item, in Items and in its CSV. Roll back to remove the display.
