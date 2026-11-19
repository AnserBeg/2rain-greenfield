# UI-COMPOSE-1 — Arrange forms and record pages, add pop-up actions and brand the app

The orchestrator accepted ADR-0079 with Fable’s amendments on 2026-11-19.

## Decisions

1. Compose eligible first-party and tenant inputs inside declared slots. Keep each input bound once, protect required and Tier B inputs, and confine block moves to the existing sections/childTables region.
2. Start from the legacy arrangement. Only the layout revision can write the composed surface thereafter. Derive base IDs without changing historical release bytes.
3. Append versioned layout, action and brand revisions. Verify the layout result digest, source bindings and target contract when replaying.
4. Each declaring capability takes the next rung above the implemented maximum at merge. Admission requires refusal by the preceding reader and reproduction of feature-absent releases.
5. A secondary pop-up inherits its target’s grants, guards, review and approval. The company chooses a tested Ledger colour scheme and display name. Generated documents pin their brand revision.

## Slices

- [Design with Fable’s amendments](../../decisions/ADR-0079-form-and-record-composition.md).
- 1a derives slot and field inventories from the active package and stores a layout only when the owner adopts a revision. No database migration.
- 1b adds disclosure, upgrade refusals and assistant discovery.
- Shell branding and pop-up actions can land in either order. Document branding follows DOCS-1 templates.

## Gates and test it yourself

Four focused tests fail on the preceding main and pass on slice 1a. They exercise persistent inventory, the before-and-after approval view, ordered replay, protected blocks and a generated Inspection with both reader requirements. The PostgreSQL journey runs the preceding serving reader and compares complete tenant compiler envelopes. The browser journey uses the Vendor picker in its new section at desktop and compact widths.

In Customize, choose **Arrange a form or record page**, then the purchase order create form. Draft a section named **Delivery**, approve it and activate. Open the same arrangement and move **Vendor** into **Delivery**. Approve and activate. Open **Purchase orders → New**. Under **Delivery**, type a vendor name and select a result. Roll back the latest change to restore the vendor’s previous placement.

```record-claim
{
  "schemaVersion": "northstar.record-claim/v1",
  "packet": "UI-COMPOSE-1",
  "base": "5a2c283a170f48bc7f0c6fd06e4762da760a6190",
  "head": "5c9dd94ebed70db3c137b7f6acf6a186b69968e9",
  "changedPaths": [
    "apps/web/src/component-registry.ts", "apps/web/src/customize-screen.ts", "apps/web/src/document-editor.ts",
    "apps/web/src/ledger-styles.ts", "apps/web/src/surface-composition.ts", "apps/web/src/surface-contract.ts",
    "apps/web/test/browser/customize.composed-application.spec.ts", "packages/canonical-model/src/index.ts", "packages/canonical-model/src/layout.ts",
    "packages/canonical-model/src/schemas.ts", "packages/canonical-model/src/surface-workspace.ts", "packages/compiler/src/projections.ts",
    "packages/customization/src/ai-draft.ts", "packages/customization/src/apply.ts", "packages/customization/src/index.ts",
    "packages/customization/src/layout-revision.ts", "packages/customization/src/patch.ts", "packages/customization/src/render.ts",
    "packages/customization/src/targets.ts", "packages/postgres-provider/src/customization-service.ts", "packages/postgres-provider/src/layout-admission.ts",
    "packages/postgres-provider/src/release-repository.ts", "packages/postgres-provider/src/request-runtime-view-service.ts", "packages/runtime/src/request-runtime-view.ts",
    "test/fixtures/g2/language-conformance/coverage-decisions.json", "test/fixtures/inspection-customization.ts", "test/fixtures/inspection-definition.ts",
    "test/helpers/language-coverage-packages.ts", "test/postgres/customization-validation.test.ts", "test/postgres/request-runtime-view.test.ts",
    "test/unit/customization.test.ts"
  ],
  "symbols": [
    {"path":"packages/canonical-model/src/layout.ts","name":"baseLayout"},
    {"path":"packages/customization/src/layout-revision.ts","name":"applyLayoutRevision"},
    {"path":"packages/postgres-provider/src/layout-admission.ts","name":"layoutBindingsProblem"}
  ]
}
```
