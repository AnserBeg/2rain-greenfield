# CUSTOMIZE-3 — the launch customization set

Slice 1 integrated the list-column work and saved list views from [PR #95](https://github.com/AnserBeg/2rain-greenfield/pull/95). Critical path: the approved patch-kind migration. The orchestrator resolved the numbering collision with CRITFIX-A.

## Claims

1. Arrange a list offers stored standard and custom fields, and the list query selects newly visible values. This includes Party's generic list.
2. Customize and plain-English drafting prepare a saved view with its own columns, default sort and declared filter choices. Approval shows those choices before activation.
3. Saved tabs batch counts through the list query under current policy. The page, CSV and assistant use the view's declared settings. Rollback restores the prior list.
4. Migration 0034 adds the planned patch kinds to the closed vocabulary. Its check requires a valid digest, lineage and channel.
5. Today cards count a declared direct list or sum its declared numeric measure before pagination. The UI drill-through and assistant use the same list and saved-view conditions. Approval, replay and rollback preserve the card definition.

## Decisions

- Each saved view keeps the record title. It pins filter choices from the list's declared options. The list keeps its standard tabs, and the first saved view adds an All tab when needed.
- The optional view layout rides v6 under ADR-0047 §7. Surfaces require reader 24 and the assistant projection requires reader 3 for releases carrying it (reader 2 already serves assistant confirmation). The first-party re-baseline reproduced the checked-in release byte for byte.
- The next-free migration rule assigns 0034 after CRITFIX-A at the candidate base. The migration retains the patch table's existing policies, grants and append-only rules.
- STOP at slice 2 for canonical language admission. The orchestrator approved compiler-proved validation examples and the verifier change that reads them. Plan §5.12 and ADR-0012 still require the dedicated Formula Rule projection for tenant validation and calculated fields. The v3 adoption explicitly deferred that family to a tenant-customization language event ([4c](4c.md#adoption-boundary)).
- [ADR-0074](../../decisions/ADR-0074-formula-rule-and-workflow-projection-admission.md) accepts joint optional v6 admission with mandatory reader floors, tenant-runner byte parity, and explicit validation and replay contracts. Slices 2–4 must prove these gates before serving either family.
- Slice 5 (candidate) subtracts the selected role’s grant for a named operation. Other roles still grant access. The actual Customize author sees active role keys and labels in their environment. A removal restores evaluation against current policy. Field restrictions remain a gap across query, read-back, exports and assistant output.
- Slice 6 restores the candidate preserved at `e97ebd9f` and adds a CRITFIX-B replay witness. Catalog measures are separate by currency. Re-baselined the pre-tenant first-party artifact. The surface, agent and query readers require 25, 4 and 3 when their projections carry the corresponding keys.

## Gates

- Slice 0 passed all 16 jobs at `81e5937b`. [CI 44429125715](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44429125715). The candidate refreshed on UPGRADE-1 is in [CI 44434963983](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44434963983).
- Slice 1 passed 24 focused tests, typecheck, lint and format. Regenerating the snapshot from 34 migrations reproduced the checked-in bytes.
- Combined candidate `e5d2c82b` passed all CI jobs, including the PostgreSQL replay and browser journeys. [CI 44457971677](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44457971677).
- Earlier CI passed the live saved-view PostgreSQL test and exposed the missing boot replay admission. The updated test passed locally and with all 71 shard-2 tests in [CI 44445972885](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44445972885).
- CI attempt 2 exposed an ambiguous form label. Saved-view selects now have explicit label associations. The browser journey checks the order of data columns outside the bulk-selection header and passed locally in 3.8 minutes on the combined UPGRADE-1 tree.
- `unrecognized-patch-kind-admitted` at `e5d2c82bbcc6`: killed with the declared reason (1 declared kill(s) failed as declared) and restored green (1 passing). [Controls 44457971797](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44457971797).
- Today metrics passed the hosted matrix at `5df9c9c8`. [CI 44471090769](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44471090769). Local scripted drafting passed. The local compiler sandbox hit its existing timeout.
- The silent-sum control checks the actual aggregate across both witness rows when only one row is on the page. [Controls 44472880285](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44472880285).

## Filed

- The full list/detail row also needs tenant controls for record-detail composition and formatting. F5 child aggregation remains pending a hard cardinality bound, visibility and absence rules, and a write concurrency protocol. [Archive](../current-plan-archive.md#filed-during-the-freeze).

```record-claim
{
  "schemaVersion": "northstar.record-claim/v1",
  "packet": "CUSTOMIZE-3",
  "base": "b62cbb9c753ab62fde2a46a7a028ff217fbd4f46",
  "head": "5df9c9c8d64001983805df98c8a80f8cd771fec4",
  "changedPaths": [
    "apps/web/release/app.authored.json", "apps/web/release/app.compiled.json",
    "apps/web/src/customize-screen.ts", "apps/web/src/list-declaration.ts",
    "apps/web/src/surface-launcher.ts", "apps/web/src/surface-runtime.ts",
    "apps/web/test/browser/customize.composed-application.spec.ts", "packages/canonical-model/src/normalize.ts",
    "packages/canonical-model/src/schemas.ts", "packages/canonical-model/src/surface-launcher.ts",
    "packages/compiler/src/compiler.ts", "packages/compiler/src/projections.ts",
    "packages/customization/src/ai-draft.ts", "packages/customization/src/apply.ts",
    "packages/customization/src/patch.ts", "packages/customization/src/render.ts",
    "packages/customization/src/targets.ts", "packages/domain/src/app/builder.ts",
    "packages/operations-agent/src/catalog.ts", "packages/operations-agent/src/session.ts",
    "packages/postgres-provider/src/customization-service.ts", "packages/postgres-provider/src/module-runtime-interpreter.ts",
    "packages/runtime/src/list-behavior/index.ts", "packages/runtime/src/request-runtime-view.ts",
    "packages/runtime/src/semantic-query-gateway.ts", "test/evidence/CUSTOMIZE-3.expected-red.json",
    "test/fixtures/g2/language-conformance/coverage-decisions.json", "test/postgres/customization.test.ts",
    "test/postgres/request-runtime-view.test.ts", "test/unit/customization-ai-draft.test.ts",
    "test/unit/customization.test.ts"
  ],
  "symbols": [
    {"path":"packages/customization/src/apply.ts","name":"addMetricCard"},
    {"path":"packages/canonical-model/src/surface-launcher.ts","name":"validateSurfaceLaunchers"},
    {"path":"packages/postgres-provider/src/customization-service.ts","name":"UPGRADE_PATCH_KINDS"}
  ]
}
```

## Test it yourself

**Slice 0.** In Customize, add **Person ordering** to **Purchase order**, then draft, approve and activate. Save an order with that field filled. In **Arrange a list → Purchase orders → Choose columns**, clear **Hide Person ordering** and **Hide Notes**, then draft, approve and activate. The Purchase orders list shows both headings and the entered name. Roll back the arrangement and inspect the order to see its saved value.

**Slice 1.** In **Customize → Save a list view → Locations**, name the view **Warehouses**. Keep Code, move Name first and sort names descending. Set **Type** to **Warehouse**, then draft, review the diff, approve and activate. Open Locations and select **Warehouses**. Its count matches the filtered rows, Name is first and the rows are sorted. Roll back the view and reopen Locations to see its standard list.

**ADR-0074.** Read the decision's mandatory reader floor table and first patch payloads. Check the `unknown` rows in the truth table and the old-reader and tenant-runner adoption gates. The decision itself has no UI change.

**Slice 5 (candidate).** As Manager, open **Customize → Restrict an action for a role**. Choose **Local Demo Full Release** and the Location Archive action. Draft, approve and activate. Open a Location as Buyer and check that Archive is gone. Draft removal from Customize, approve and activate to restore access under current policy.

**Slice 6.** In **Customize → Add a metric card to Today**, choose **Locations**, select **Set up metric** and name it **Location count**. Draft, approve and activate. Select the card on Today and compare its count with the destination list. For a sum, choose **Items** and **Price (CAD)**, then use its card to open the governed list. Roll back from Customize and verify that the latest card disappears.
