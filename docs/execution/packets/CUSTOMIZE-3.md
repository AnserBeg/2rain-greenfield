# CUSTOMIZE-3 — the launch customization set

Slice 1 integrated the list-column work and saved list views from [PR #95](https://github.com/AnserBeg/2rain-greenfield/pull/95). Critical path: the approved patch-kind migration. The orchestrator resolved the numbering collision with CRITFIX-A.

## Claims

1. Arrange a list offers stored standard and custom fields, and the list query selects newly visible values. This includes Party's generic list.
2. Customize and plain-English drafting prepare a saved view with its own columns, default sort and declared filter choices. Approval shows those choices before activation.
3. Saved tabs batch counts through the list query under current policy. The page, CSV and assistant use the view's declared settings. Rollback restores the prior list.
4. Migration 0034 adds the planned patch kinds to the closed vocabulary. Its check requires a valid digest, lineage and channel.
5. Today cards count a declared direct list or sum its declared numeric measure before pagination. The UI drill-through and assistant use the same list and saved-view conditions. Approval, replay and rollback preserve the card definition.
6. An operation restriction subtracts one role’s grants. Other roles keep their existing grants. Release activation and replay check the role in the destination environment.
7. Literal validation (F1/F3) adds a guard to bound create and update operations. Create checks after defaults. Update checks when a watched value changes. Form and assistant show the pinned message, and rollback restores the prior rules.

## Decisions

- Each saved view keeps the record title. It pins filter choices from the list's declared options. The list keeps its standard tabs, and the first saved view adds an All tab when needed.
- The optional view layout rides v6 under ADR-0047 §7. Surfaces require reader 24 and the assistant projection requires reader 3 for releases carrying it (reader 2 already serves assistant confirmation). The first-party re-baseline reproduced the checked-in release byte for byte.
- The next-free migration rule assigns 0034 after CRITFIX-A at the candidate base. The migration retains the patch table's existing policies, grants and append-only rules.
- STOP at slice 2 for canonical language admission. The orchestrator approved compiler-proved validation examples and the verifier change that reads them. Plan §5.12 and ADR-0012 still require the dedicated Formula Rule projection for tenant validation and calculated fields. The v3 adoption explicitly deferred that family to a tenant-customization language event ([4c](4c.md#adoption-boundary)).
- [ADR-0074](../../decisions/ADR-0074-formula-rule-and-workflow-projection-admission.md) accepts joint optional v6 admission with mandatory reader floors, tenant-runner byte parity, and explicit validation and replay contracts. Slices 2–4 must prove these gates before serving either family.
- Slice 5 subtracts the selected role’s grant for a named operation. Other roles still grant access. The actual Customize author sees active role keys and labels in their environment. A removal restores evaluation against current policy. Field restrictions remain a gap across query, read-back, exports and assistant output.
- [ADR-0075](../../decisions/ADR-0075-literal-validation-and-ordered-comparison.md) defines the optional v6 F1/F3 validation position. It keeps the existing inline predicate profile and uses the tenant business calendar. Declaring releases require operation reader 3.
- Slice 6 restores the candidate preserved at `e97ebd9f` and adds a CRITFIX-B replay witness. Catalog measures are separate by currency. Re-baselined the pre-tenant first-party artifact. The surface, agent and query readers require 25, 4 and 3 when their projections carry the corresponding keys.

## Gates

- Saved views and columns passed [CI 44457971677](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44457971677) and the closed patch-kind [control 44457971797](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44457971797).
- Today metrics passed [CI 44471090769](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44471090769) and the sum-before-pagination [control 44472880285](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44472880285).
- The ADR amendment passed [CI 44481530303](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44481530303) and the record checker. GitHub canceled the merge run when CRITFIX-C advanced main.
- Slice 2 candidate exercises actual compiler accept/refuse, the previous serving reader, archived and current tenant-runner envelope equality, an unchanged existing row, the browser rule journey, assistant discovery and rollback.
- Slice 5 passed [CI 44510381381](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44510381381) and [four mutation controls](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44510308624). Migration 0040 follows activation recovery and the snapshot was rebuilt from all 40 migrations. Standard surface actions check current permission before being offered. The service stages the release and the patch audit row records the author.

## Filed

- The full list/detail row also needs tenant controls for record-detail composition and formatting. F5 child aggregation remains pending a hard cardinality bound, visibility and absence rules, and a write concurrency protocol. [Archive](../current-plan-archive.md#filed-during-the-freeze).

```record-claim
{
  "schemaVersion": "northstar.record-claim/v1",
  "packet": "CUSTOMIZE-3",
  "base": "881768043d00d894b44a64486c43aa10b85ed7cb",
  "head": "9025a422f8e0d53eb6c1e2f83258b3575841e14e",
  "changedPaths": [
    ".github/workflows/ci.yml", ".github/workflows/evidence.yml", "apps/web/src/component-registry.ts", "apps/web/src/customize-screen.ts",
    "apps/web/src/document-editor.ts", "apps/web/src/surface-composition.ts", "apps/web/src/surface-runtime.ts", "apps/web/src/validation-refusal.ts",
    "apps/web/test/browser/customize.composed-application.spec.ts", "package.json", "packages/canonical-model/src/formula-validation-bindings.ts", "packages/canonical-model/src/formula-validation-projection.ts",
    "packages/canonical-model/src/formula-validation-schema.ts", "packages/canonical-model/src/formula-validation.ts", "packages/canonical-model/src/index.ts", "packages/canonical-model/src/normalize.ts",
    "packages/canonical-model/src/schemas.ts", "packages/compiler/src/compiler.ts", "packages/compiler/src/diff.ts", "packages/compiler/src/formula-validation-examples.ts",
    "packages/compiler/src/formula-validation-plan.ts", "packages/compiler/src/formula-validation-witness.ts", "packages/compiler/src/projections.ts", "packages/compiler/src/protocol.ts",
    "packages/compiler/src/verification.ts", "packages/customization/src/ai-draft.ts", "packages/customization/src/apply.ts", "packages/customization/src/patch.ts",
    "packages/customization/src/render.ts", "packages/customization/src/targets.ts", "packages/customization/src/validation-draft.ts", "packages/operations-agent/src/catalog.ts",
    "packages/postgres-provider/src/customization-service.ts", "packages/postgres-provider/src/module-runtime-interpreter.ts", "packages/postgres-provider/src/release-repository.ts", "packages/postgres-provider/src/release-verification-service.ts",
    "packages/postgres-provider/src/request-runtime-view-service.ts", "packages/runtime/src/formula-validation.ts", "packages/runtime/src/request-runtime-view.ts", "test/architecture/repository-hygiene.test.ts",
    "test/evidence/CUSTOMIZE-3.expected-red.json", "test/fixtures/g2/language-conformance/coverage-decisions.json", "test/helpers/archived-customization-runtime.ts", "test/helpers/check-language-coverage.ts",
    "test/helpers/language-coverage-packages.ts", "test/helpers/reachability-producers.ts", "test/postgres/customization-validation.test.ts", "test/unit/customization-ai-draft.test.ts",
    "test/unit/formula-validation.test.ts"
  ],
  "symbols": [
    {"path":"packages/canonical-model/src/formula-validation-bindings.ts","name":"bindLiteralValidation"},
    {"path":"packages/compiler/src/formula-validation-plan.ts","name":"compileLiteralFormulaRules"},
    {"path":"packages/runtime/src/formula-validation.ts","name":"observeValidationRefusals"}
  ]
}
```

## Test it yourself

**Slice 0.** In Customize, add **Person ordering** to **Purchase order**, then draft, approve and activate. Save an order with that field filled. In **Arrange a list → Purchase orders → Choose columns**, clear **Hide Person ordering** and **Hide Notes**, then draft, approve and activate. The Purchase orders list shows both headings and the entered name. Roll back the arrangement and inspect the order to see its saved value.

**Slice 1.** In **Customize → Save a list view → Locations**, name the view **Warehouses**. Keep Code, move Name first and sort names descending. Set **Type** to **Warehouse**, then draft, review the diff, approve and activate. Open Locations and select **Warehouses**. Its count matches the filtered rows, Name is first and the rows are sorted. Roll back the view and reopen Locations to see its standard list.

**ADR-0074.** Read the decision's mandatory reader floor table and first patch payloads. Check the `unknown` rows in the truth table and the old-reader and tenant-runner adoption gates. The decision itself has no UI change.

**Slice 5.** As Manager, open **Customize → Restrict an action for a role**. Choose **Local Demo Full Release** and the Location Archive action. Draft, approve and activate. Open a Location as Buyer and check that Archive is gone. Draft removal from Customize, approve and activate to restore access under current policy.

**Slice 2.** In **Customize → Add a validation rule → Item**, choose **Description** and **Required**, enter a message, then draft, approve and activate. Open **New item**, fill SKU, name and base unit, and save with Description blank. The form keeps your entries and shows your message. Fill Description and save. Roll back in Customize and verify that another item saves with Description blank.

**Slice 6.** In **Customize → Add a metric card to Today**, choose **Locations**, select **Set up metric** and name it **Location count**. Draft, approve and activate. Select the card on Today and compare its count with the destination list. For a sum, choose **Items** and **Price (CAD)**, then use its card to open the governed list. Roll back from Customize and verify that the latest card disappears.
