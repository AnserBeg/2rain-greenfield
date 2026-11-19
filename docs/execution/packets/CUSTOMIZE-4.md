# CUSTOMIZE-4 — tenant-authored Goods Receipt Inspection

Status — Candidate for integration. The orchestrator approved the patch-kind migration and ruled that the visual journey should publish the entire module in a single draft. The migration is the Critical path.

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
- The visual form produces the same ordered change set as the plain-English path. Compiler and drafter refuse a link added after the source type's creation change. Recorded prefixes remain replayable.
- The approved migration replaces the SQL kind allowlist with a bounded identifier and matches it to the JSON payload. The versioned parser still refuses unknown kinds at write and replay. The golden vocabulary check retains CUSTOMIZE-3's `saveListView` and `addMetricCard`.

- Deploy rule: keep deployed code at or above the newest patch-parser and surface-reader floors any tenant has used.

## Gates

- [Hosted PostgreSQL](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44467955198) passed at `19e8d8e0`, including the one-request draft, linked records, owned lines and an assistant-confirmed Quarantine with unchanged stock movements. The source scan found no Inspection-specific first-party branches.
- [Earlier CI](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44471387731) at `dca983be` passed quality and build. The [controls](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44471387669) passed at that SHA.
- The first-party release uses an ADR-0066 re-baseline. The prior pushed checkpoint is preserved by an annotated tag and remains in branch history.

## Gaps

- Next packet — receiving event subscription (rung 4) for automatically starting an inspection. Keep the resulting writes inside Tier A.
- Option 1, after CUSTOMIZE-3 and CRITFIX-C — extend `#archiveRestrict` and witness arrangement in `release-verification-service.ts` to verify a new relation on an already-published source table. Arrange the target and create the linked source under the same candidate scope and storage mapping with the installed FK in effect. Prove archive restriction and clean up both witnesses after the check. Regress with a live Inspection table and a second release adding Location. The browser reported a foreign-key violation on create or update for `custom_goods_receipt_inspection_location` (`nsm_k_hrt7fu3juqx46ogaqnwwux3km7wwmhdsldr7vzcvgmutofheocja`). The failing row was not captured. [CI 44474332075](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44474332075/job/135391225387)
- Tenant-authored validation predicates for transition guards await CUSTOMIZE-3's Formula Rule projection. Current transitions enforce their declared source state.

```record-claim
{
  "schemaVersion": "northstar.record-claim/v1",
  "packet": "CUSTOMIZE-4",
  "base": "81ba7405e7512a806882f9ea3cff51af8c7115d9",
  "head": "d9445168f753115aec696ded740a2ccab1f8afd8",
  "changedPaths": [
    "apps/web/package.json", "apps/web/src/component-registry.ts",
    "apps/web/src/customize-screen.ts", "apps/web/src/document-editor.ts",
    "apps/web/src/gateway-error-codes.ts", "apps/web/src/list-declaration.ts",
    "apps/web/src/message-catalog.ts", "apps/web/src/surface-runtime.ts",
    "apps/web/test/browser/customize.composed-application.spec.ts", "apps/web/test/browser/message-catalog.spec.ts",
    "apps/web/test/surface-runtime-contract.test.ts", "db/migrations/0036_customization_patch_kind_identifier.sql",
    "db/schema.snapshot.json", "packages/canonical-model/src/schemas.ts",
    "packages/canonical-model/src/surface-list.ts", "packages/canonical-model/src/surface-workspace.ts",
    "packages/compiler/src/conformance.ts", "packages/compiler/src/projections.ts",
    "packages/compiler/src/storage.ts", "packages/customization/src/ai-draft.ts",
    "packages/customization/src/apply.ts", "packages/customization/src/candidate.ts",
    "packages/customization/src/patch.ts", "packages/customization/src/render.ts",
    "packages/customization/src/targets.ts", "packages/operations-agent/src/catalog.ts",
    "packages/operations-agent/src/session.ts", "packages/postgres-provider/src/customization-service.ts",
    "packages/runtime/src/request-runtime-view.ts", "pnpm-lock.yaml",
    "test/architecture/release-persistence-boundary.test.ts", "test/evidence/CUSTOMIZE-3.expected-red.json",
    "test/evidence/CUSTOMIZE-4.expected-red.json", "test/fixtures/g2/language-conformance/coverage-decisions.json",
    "test/fixtures/inspection-customization.ts", "test/postgres/customization.test.ts",
    "test/postgres/inventory-storage.test.ts", "test/postgres/migrations.test.ts",
    "test/postgres/module-storage-transition.test.ts", "test/postgres/trust-substrate.test.ts",
    "test/unit/customization-ai-draft.test.ts", "test/unit/customization.test.ts"
  ],
  "symbols": [
    {"path": "packages/customization/src/patch.ts", "name": "parseCustomizationPatch"},
    {"path": "packages/customization/src/apply.ts", "name": "applyCustomizationPatches"},
    {"path": "packages/runtime/src/request-runtime-view.ts", "name": "SUPPORTED_RUNTIME_CAPABILITIES"}
  ]
}
```

## Test it yourself

On an isolated test instance, open **Customize → A new record type**. Name it **Goods Receipt Inspection**, choose company ownership, and leave **Name** as the first field. In the same form add an **Inspection results** line table with **Characteristic** (text), **Measured value** (whole number) and **Pass** (yes or no). Under **Links**, choose **Goods receipt**, **Supplier** (Party), **Item** and **Location**. Under **States and actions**, use **Pending** as initial and add **Passed**, **Failed**, **Conditional**, **Quarantined** and **Released**. Add actions from Pending to the four result states and **Release** from Quarantined to Released. Draft, review the single diff, approve and activate. Open the new list, save an inspection with a linked receipt and a result, and check both on its page. Confirm **Quarantine** and check that **Release** appears.
