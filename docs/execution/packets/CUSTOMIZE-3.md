# CUSTOMIZE-3 — the launch customization set

Slice 1 includes the tested list-column work and saved list views in [PR #95](https://github.com/AnserBeg/2rain-greenfield/pull/95). STOP at `origin/main` `ef080dad`: CRITFIX-A landed `0033_definer_search_paths.sql`, so the saved-view candidate cannot integrate under the approved migration number.

## Claims

1. Arrange a list offers stored standard and custom fields, and the list query selects newly visible values. This includes Party's generic list.
2. Customize and plain-English drafting prepare a saved view with its own columns, default sort and declared filter choices. Approval shows those choices before activation.
3. Saved tabs batch counts through the list query under current policy. The page, CSV and assistant use the view's declared settings. Rollback restores the prior list.
4. Migration 0033 adds the planned patch kinds to the closed vocabulary. Its check continues to require a valid digest, lineage and channel. The replay test applies the saved-view patch to a new first-party base.

## Decisions

- Each saved view keeps the record title. It pins filter choices from the list's declared options. The list keeps its standard tabs, and the first saved view adds an All tab when needed.
- The optional view layout rides v6 under ADR-0047 §7. Surfaces require reader 24 and the assistant projection requires reader 3 for releases carrying it (reader 2 already serves assistant confirmation). The first-party re-baseline reproduced the checked-in release byte for byte.
- The orchestrator approved 0033 after 0032. The migration retains the patch table's existing policies, grants and append-only rules. Integration will be logged as merged — unread.
- Migration ruling requested. Recommend 0034 for this packet's enumerated extension and 0035 for CUSTOMIZE-4's bounded identifier check. The alternative is to make CUSTOMIZE-4's bounded check the shared 0034 prerequisite for both packets.
- Slice 2 needs a Critical ruling. The approval verifier's `#createInput` supplies fixed generated values through the real create operation. Literal bounds need a satisfying witness, and a no-past-date rule needs the same captured business date as the gateway.
- Slice 4 needs the Formula IR projection admission in ADR-0012. A calculated display value requires resolved dependencies and server, query, reporting and assistant projections.
- Slice 5 is open. First-party operations such as Close and Reopen share a permission ID, so an action restriction must identify the operation. Field visibility must also govern query and read-back results.
- Slice 6's independent candidate `e97ebd9f` uses the governed list count and exact top-level sums. CAD, USD and EUR are separate Items measures. Its focused compiler, assistant and upgrade-replay tests pass. PostgreSQL and browser evidence is pending.

## Gates

- Slice 0 passed all 16 jobs at `81e5937b`. [CI 44429125715](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44429125715). The candidate refreshed on UPGRADE-1 is in [CI 44434963983](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44434963983).
- Slice 1 passed focused compiler, reader refusal, export and scripted drafting tests, typecheck and lint. GitHub CI will run the PostgreSQL and browser journeys and upgrade replay.
- [CI 44441030550](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44441030550) caught a declaration emit error in the list-count helper. The explicit return type passed local declaration emit.
- [CI 44442711383](https://github.com/rainerp-com/2rain-greenfield/actions/runs/44442711383) passed the live saved-view PostgreSQL test and found that boot's UPGRADE-1 admission omitted `saveListView`. The replay gate now admits that kind.
- The targeted upgrade reproduction passed locally. [CI 44445972885](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44445972885) passed all 71 shard-2 tests. The current candidate includes UPGRADE-1 recovery and awaits the migration ruling before fresh CI.
- CI attempt 2 exposed an ambiguous form label. Saved-view selects now have explicit label associations. The browser journey checks the order of data columns outside the bulk-selection header and passed locally in 3.8 minutes on the combined UPGRADE-1 tree.
- The migration control `unrecognized-patch-kind-admitted` checks that the database refuses a new unknown kind even with a matching digest.

## Filed

- The full list/detail row also needs tenant controls for record-detail composition and formatting. F5 child aggregation remains pending a hard cardinality bound, visibility and absence rules, and a write concurrency protocol. [Archive](../current-plan-archive.md#filed-during-the-freeze).

```record-claim
{
  "schemaVersion": "northstar.record-claim/v1",
  "packet": "CUSTOMIZE-3",
  "base": "7df1ea960f03528926be71e55cbbea7cfcbb77a3",
  "head": "70bc029de235d52e74adecbc67c62f5712609a26",
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
    "packages/postgres-provider/src/customization-service.ts", "packages/postgres-provider/src/module-runtime-interpreter.ts",
    "packages/runtime/src/list-behavior/index.ts",
    "packages/runtime/src/request-runtime-view.ts", "test/architecture/release-persistence-boundary.test.ts",
    "test/evidence/CUSTOMIZE-3.expected-red.json", "test/fixtures/g2/language-conformance/coverage-decisions.json",
    "test/postgres/customization.test.ts", "test/postgres/inventory-storage.test.ts",
    "test/postgres/migrations.test.ts", "test/postgres/module-storage-transition.test.ts",
    "test/postgres/request-runtime-view.test.ts", "test/postgres/trust-substrate.test.ts",
    "test/unit/customization-ai-draft.test.ts", "test/unit/customization.test.ts"
  ],
  "symbols": [
    {"path": "packages/customization/src/apply.ts", "name": "saveListView"},
    {"path": "packages/postgres-provider/src/customization-service.ts", "name": "UPGRADE_PATCH_KINDS"},
    {"path": "apps/web/src/surface-launcher.ts", "name": "loadDeclaredListCounts"},
    {"path": "packages/runtime/src/list-behavior/index.ts", "name": "requireSharedListEcho"}
  ]
}
```

## Test it yourself

**Slice 0.** In Customize, add **Person ordering** to **Purchase order**, then draft, approve and activate. Save an order with that field filled. In **Arrange a list → Purchase orders → Choose columns**, clear **Hide Person ordering** and **Hide Notes**, then draft, approve and activate. The Purchase orders list shows both headings and the entered name. Roll back the arrangement and inspect the order to see its saved value.

**Slice 1.** In **Customize → Save a list view → Locations**, name the view **Warehouses**. Keep Code, move Name first and sort names descending. Set **Type** to **Warehouse**, then draft, review the diff, approve and activate. Open Locations and select **Warehouses**. Its count matches the filtered rows, Name is first and the rows are sorted. Roll back the view and reopen Locations to see its standard list.
