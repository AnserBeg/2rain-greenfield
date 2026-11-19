# CUSTOMIZE-3 — the launch customization set

Slice 1 includes the tested list-column work and saved list views in [PR #95](https://github.com/AnserBeg/2rain-greenfield/pull/95). Migration 0033 is the approved Critical path.

## Claims

1. Arrange a list offers stored standard and custom fields, and the list query selects newly visible values. This includes Party's generic list.
2. Customize and plain-English drafting prepare a saved view with its own columns, default sort and declared filter choices. Approval shows those choices before activation.
3. Saved tabs batch counts through the list query under current policy. The page, CSV and assistant use the view's declared settings. Rollback restores the prior list.
4. Migration 0033 adds the planned patch kinds to the closed vocabulary. Its check continues to require a valid digest, lineage and channel. The replay test applies the saved-view patch to a new first-party base.

## Decisions

- Each saved view keeps the record title. It pins filter choices from the list's declared options. The list keeps its standard tabs, and the first saved view adds an All tab when needed.
- The optional view layout rides v6 under ADR-0047 §7. Surfaces require reader 24 and the assistant projection requires reader 3 for releases carrying it (reader 2 already serves assistant confirmation). The first-party re-baseline reproduced the checked-in release byte for byte.
- The orchestrator approved 0033 after 0032. The migration retains the patch table's existing policies, grants and append-only rules. Integration will be logged as merged — unread.

## Gates

- Slice 0 passed all 16 jobs at `81e5937b`. [CI 44429125715](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44429125715). The candidate refreshed on UPGRADE-1 is in [CI 44434963983](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44434963983).
- Slice 1 passed focused compiler, reader refusal, export and scripted drafting tests, typecheck and lint. GitHub CI will run the PostgreSQL and browser journeys and upgrade replay.
- The migration control `unrecognized-patch-kind-admitted` checks that the database refuses a new unknown kind even with a matching digest.

```record-claim
{
  "schemaVersion": "northstar.record-claim/v1",
  "packet": "CUSTOMIZE-3",
  "base": "8b61740a17c18a6201f01c4345c0e6c215ee91d3",
  "head": "c6296bfa3ab1ed9deb28d3212ee94375293c9bdf",
  "changedPaths": [
    "apps/web/src/component-registry.ts", "apps/web/src/customize-screen.ts",
    "apps/web/src/list-declaration.ts", "apps/web/src/surface-launcher.ts",
    "apps/web/src/surface-runtime.ts", "apps/web/test/browser/customize.composed-application.spec.ts",
    "db/migrations/0033_customization_launch_patch_kinds.sql", "db/schema.snapshot.json",
    "packages/canonical-model/src/schemas.ts", "packages/canonical-model/src/surface-list.ts",
    "packages/compiler/src/projections.ts", "packages/customization/src/ai-draft.ts",
    "packages/customization/src/apply.ts", "packages/customization/src/patch.ts",
    "packages/customization/src/render.ts", "packages/customization/src/targets.ts",
    "packages/operations-agent/src/catalog.ts", "packages/operations-agent/src/session.ts",
    "packages/postgres-provider/src/module-runtime-interpreter.ts", "packages/runtime/src/list-behavior/index.ts",
    "packages/runtime/src/request-runtime-view.ts", "test/architecture/release-persistence-boundary.test.ts",
    "test/evidence/CUSTOMIZE-3.expected-red.json", "test/fixtures/g2/language-conformance/coverage-decisions.json",
    "test/postgres/customization.test.ts", "test/postgres/inventory-storage.test.ts",
    "test/postgres/migrations.test.ts", "test/postgres/module-storage-transition.test.ts",
    "test/postgres/request-runtime-view.test.ts", "test/postgres/trust-substrate.test.ts",
    "test/unit/customization-ai-draft.test.ts", "test/unit/customization.test.ts"
  ],
  "symbols": [
    {"path": "packages/customization/src/apply.ts", "name": "saveListView"},
    {"path": "apps/web/src/surface-launcher.ts", "name": "loadDeclaredListCounts"},
    {"path": "packages/runtime/src/list-behavior/index.ts", "name": "requireSharedListEcho"}
  ]
}
```

## Test it yourself

**Slice 0.** In Customize, add **Person ordering** to **Purchase order**, then draft, approve and activate. Save an order with that field filled. In **Arrange a list → Purchase orders → Choose columns**, clear **Hide Person ordering** and **Hide Notes**, then draft, approve and activate. The Purchase orders list shows both headings and the entered name. Roll back the arrangement and inspect the order to see its saved value.

**Slice 1.** In **Customize → Save a list view → Locations**, name the view **Warehouses**. Keep Code, move Name first and sort names descending. Set **Type** to **Warehouse**, then draft, review the diff, approve and activate. Open Locations and select **Warehouses**. Its count matches the filtered rows, Name is first and the rows are sorted. Roll back the view and reopen Locations to see its standard list.
