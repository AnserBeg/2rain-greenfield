# CUSTOMIZE-4 — tenant-authored Goods Receipt Inspection

Status — rebased from checkpoint `c8110053` over CUSTOMIZE-3 and CRITFIX-B. The approved patch-lineage migration is the Critical path.

## Claims to verify

1. One ordered change set carries a record type, links, lines and lifecycle through one diff, approval and lineage row. An unknown member or inverse dependency is refused.
2. A company-owned header and its lines use company-scoped reads and writes. Tenant-shared types use unscoped requests and can link to tenant-shared targets.
3. The document editor selects declared header links and saves the header before its lines. An active child restricts parent archive. Lists search and filter by linked labels and records.
4. A lifecycle supplies the status and available actions. Quarantine and Release act on the inspection; the assistant asks for confirmation.
5. Inspection is authored in the Customize screen and as an ordered patch fixture. Its implementation uses the same surfaces, operations and storage as other tenant record types.

## Decisions

- Floor 25 admits create-time header links and shared or lifecycle-less editors, including their declared List relation columns. CUSTOMIZE-3 uses floor 24 for saved views. See ADR-0072.
- Links are chosen at creation and restrict archiving a target with active dependents. Multiple inspections can refer to the same receipt, so Inspection needs no new uniqueness rule.
- List search matches linked labels. Selecting a linked value narrows the list by that record's ID.
- Sequential save (ADR-0072) leaves the header and each successful row change committed if a later step fails. Use **Retry save** to resume pending operations, or correct the flagged values and save the remaining changes. If read-back was withheld, reopen the existing record after read access is restored and verify the saved rows before continuing. Archive the lines before archiving their parent.
- The visual path publishes a record type, then drafts its lines, links and lifecycle together. A plain-English request can draft both steps as one change set.
- The approved migration replaces the SQL kind allowlist with a bounded identifier and matches it to the JSON payload. The versioned parser still refuses unknown kinds at write and replay. The add-only vocabulary includes CUSTOMIZE-3’s `saveListView`; four other identifiers reserved in its migration await parser contracts.

- Deploy rule: keep deployed code at or above the newest patch-parser and surface-reader floors any tenant has used.

## Gates

- The hosted PostgreSQL journey drafts Inspection from one scripted request and verifies the assistant’s confirmation and governed Quarantine write. The browser journey builds it through Customize and uses the generated form and record. Results pending.
- The first-party release uses an ADR-0066 re-baseline. The prior pushed checkpoint is preserved by an annotated tag and remains in branch history.

## Gaps

- Next packet — receiving event subscription (rung 4) for automatically starting an inspection. Keep the resulting writes inside Tier A.
- Tenant-authored validation predicates for transition guards await CUSTOMIZE-3’s Formula Rule projection. Current transitions enforce their declared source state.

```record-claim
{
  "schemaVersion": "northstar.record-claim/v1",
  "packet": "CUSTOMIZE-4",
  "base": "5f12be07640e5bade0937d3bc7c1bc26b08d4c87",
  "head": "2fd86fef7272294b6d388d89b42a6dc076947f3b",
  "changedPaths": [
    "apps/web/release/app.compiled.json", "apps/web/src/component-registry.ts",
    "apps/web/src/customize-screen.ts", "apps/web/src/document-editor.ts",
    "apps/web/src/gateway-error-codes.ts", "apps/web/src/list-declaration.ts",
    "apps/web/src/message-catalog.ts", "apps/web/src/surface-runtime.ts",
    "apps/web/test/browser/customize.composed-application.spec.ts", "apps/web/test/browser/message-catalog.spec.ts",
    "db/migrations/0036_customization_patch_kind_identifier.sql", "db/schema.snapshot.json",
    "packages/canonical-model/src/schemas.ts", "packages/canonical-model/src/surface-list.ts",
    "packages/canonical-model/src/surface-workspace.ts", "packages/compiler/src/conformance.ts",
    "packages/compiler/src/projections.ts", "packages/compiler/src/storage.ts",
    "packages/customization/src/ai-draft.ts", "packages/customization/src/apply.ts",
    "packages/customization/src/candidate.ts", "packages/customization/src/patch.ts",
    "packages/customization/src/render.ts", "packages/customization/src/targets.ts",
    "packages/operations-agent/src/catalog.ts", "packages/operations-agent/src/session.ts",
    "packages/postgres-provider/src/customization-service.ts", "packages/runtime/src/request-runtime-view.ts",
    "test/architecture/release-persistence-boundary.test.ts", "test/evidence/CUSTOMIZE-3.expected-red.json",
    "test/evidence/CUSTOMIZE-4.expected-red.json", "test/fixtures/g2/language-conformance/coverage-decisions.json",
    "test/fixtures/inspection-customization.ts", "test/postgres/customization.test.ts",
    "test/postgres/inventory-storage.test.ts", "test/postgres/migrations.test.ts",
    "test/postgres/module-storage-transition.test.ts", "test/postgres/request-runtime-view.test.ts",
    "test/postgres/trust-substrate.test.ts", "test/unit/customization-ai-draft.test.ts",
    "test/unit/customization.test.ts"
  ],
  "symbols": [
    {"path": "packages/customization/src/patch.ts", "name": "parseCustomizationPatch"},
    {"path": "packages/customization/src/apply.ts", "name": "applyCustomizationPatches"},
    {"path": "packages/runtime/src/request-runtime-view.ts", "name": "SUPPORTED_RUNTIME_CAPABILITIES"}
  ]
}
```

## Test it yourself

After integration, open Customize, add a company-owned **Goods Receipt Inspection** with a **Name** field, approve and activate it. From **Lines, links and actions**, give it an **Inspection results** table and add **Goods receipt**, **Supplier**, **Item** and **Location** links. Declare **Pending**, **Quarantined** and **Released**, then add **Quarantine** and **Release** with those endpoints. Approve and activate. Create an inspection with a receipt and a result line. The record shows the linked receipt and result. Confirm **Quarantine** and check that **Release** appears.
