# CUSTOMIZE-2 — added fields on the records people use

Base `c2c12e7f`. No Critical path touched.

## Claims

1. An added field is editable on create and update and readable on the record. Order editors and composed Details bind the field and select it through their own queries.
2. Optional first-party fields start under More details. Customize can promote them on both editors or include them in the list. Tenant record types retain their default list columns.
3. The compiler's existing entity-field projection makes the field writable through the two record mutations. The PostgreSQL journey reads through the assistant, updates through its governed plan, and reads the saved value on the composed purchase order.
4. Rolling back removes the field from the active release. Fresh approval and activation read back the previously saved value.
5. Approve and Activate show a status sentence during submission. Opening Customize again while its activation runs reports progress.

## Decisions

- The optional v6 `surface.form.fields` key carries a label and disclosure. Normalization refuses deferred required fields, duplicates and unselected fields. Surface readers declare floor 23 for this key. The first-party re-baseline reproduced the checked-in release byte for byte.
- Newly drafted fields record their screen binding in the patch. Earlier field patches reproduce their original release. Re-drafting the identical legacy field publishes its screens and reuses its column.
- First-party custom list columns are opt-in. Customize offers fields selected by the list query, including previously hidden custom columns.

## Gates

The unit regression failed on the original purchase order create form. PostgreSQL and both browser journeys run in GitHub CI.

```record-claim
{
  "schemaVersion": "northstar.record-claim/v1",
  "packet": "CUSTOMIZE-2",
  "base": "c2c12e7f7395900967bfb4d45731d54ce28435a0",
  "head": "3d663a8dda818aa5e26eee3ba1939b17dfd9a263",
  "changedPaths": [
    "apps/web/src/component-registry.ts", "apps/web/src/customize-screen.ts",
    "apps/web/src/document-editor.ts", "apps/web/src/surface-client.ts",
    "apps/web/test/browser/customize.composed-application.spec.ts", "packages/canonical-model/src/schemas.ts",
    "packages/canonical-model/src/surface-workspace.ts", "packages/compiler/src/projections.ts",
    "packages/customization/src/ai-draft.ts", "packages/customization/src/apply.ts",
    "packages/customization/src/patch.ts", "packages/customization/src/render.ts",
    "packages/customization/src/targets.ts", "packages/postgres-provider/src/customization-service.ts",
    "packages/runtime/src/request-runtime-view.ts", "test/fixtures/g2/language-conformance/coverage-decisions.json",
    "test/postgres/customization.test.ts", "test/postgres/request-runtime-view.test.ts",
    "test/unit/customization.test.ts", "test/unit/customize-screen.test.ts"
  ],
  "symbols": [
    {"path": "packages/customization/src/apply.ts", "name": "applyCustomizationPatches"},
    {"path": "packages/customization/src/targets.ts", "name": "customizationTargets"},
    {"path": "apps/web/src/customize-screen.ts", "name": "renderCustomizeScreen"}
  ]
}
```

## Test it yourself

In Customize, add the text field **Person ordering** to **Purchase order**, then draft, approve and activate. The same steps publish an existing query-only field. Open **Purchase orders → New**, choose a vendor and product, and fill **Person ordering** under **More details**. Save the draft and find the value in **Details**. Roll back the change, approve it again and activate it. Reopen the order to see the saved value.
