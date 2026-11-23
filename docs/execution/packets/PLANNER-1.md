# PLANNER-1 — map stops and schedule work on a dispatch desk

**Slice 0 · docs only · 2026-11-21.** Fable returned REVISE on `11d0e030`. The orchestrator accepted the amendment at `467535a4` with the clarifications recorded in the ADR. The owner selected Google Maps for display. [Amended ADR](../../decisions/ADR-0092-map-resource-assignment-and-planner-workspace.md)

## Amendments

| Finding | Design decision |
| --- | --- |
| A1 | Map and Planner have closed archetypes, named slots and compact projections. Plan §12.2 includes both and resource timeline. [Grammar](../../decisions/ADR-0092-map-resource-assignment-and-planner-workspace.md#1-draw-the-map-on-the-server) |
| A2 | The owner selected Google Maps JS. PLANNER-1 binds live browser display and a network-free raster fake through the company-scoped viewport seam. [Provider and disclosure](../../decisions/ADR-0092-map-resource-assignment-and-planner-workspace.md#2-let-connect-1-own-imagery-and-disclosure) |
| A3 | Apply the day, saved filters and route before the 100-stop cap. Pan/zoom queries the visible area. Page by group, stop order and key, with route-local pin numbers and a prompt to narrow. [Map limits](../../decisions/ADR-0092-map-resource-assignment-and-planner-workspace.md#5-bound-the-read-before-drawing) |
| A4 | Slice 1 ships the §2a amendment for map-region pan/zoom and drag-to-pan, canonical URLs, three size presets, linked overlay pins and script-off navigation back to the map. |
| A5 | One date drives all panels. The day opens on a 06:00–18:00 axis with 48 quarter-hour starts. Show on map seeks the authorized stop across pages. [Desk](../../decisions/ADR-0092-map-resource-assignment-and-planner-workspace.md#4-compose-the-desk-and-review-one-assignment) |
| A6 | Slice 2 ships Schedule, Reschedule, Reassign and Unassign as one-job forms, including Needs time on an assigned row. Booking keeps its single-edge Change interval contract. |
| A7 | Route-order v1 supports a sortable field (truck and interval start by default on the desk) and an explicit next-stop link. The latter has bounded edge, splice, cycle and fork rules. |
| A8 | A job type declares an O1 assignment operation with a stable ID, write/confirm action, protected field pair and schema-backed Customize member. Views bind its released contract. [Operation and forms](../../decisions/ADR-0092-map-resource-assignment-and-planner-workspace.md#declare-the-operation-on-the-job-type) |
| A9 | Exclusive capacity uses Booking. Ordinary diary review shows only visible overlapping work as an advisory. |
| A10 | Shared rows carry a standing hidden-work notice. One Restricted map group covers all unreadable targets. A hidden next stop leaves no leg or list hint. |
| A11 | Slice 3 widens behaviour eight under §2a. A drop selects the offered resource and start, then opens Schedule for explicit review. |
| A12 | Per-slice, same-tenant/two-company controls isolate map/list/legend/fit/leg/image, queue, rows/bars, writer and decision fences. No new planner table is planned. [Controls](../../decisions/ADR-0092-map-resource-assignment-and-planner-workspace.md#delivery-after-the-targeted-check) |
| A13 | Builder and drafter name unsupported multi-resource jobs, to-many crews, related addresses, live position, bulk moves, bar-body drag and whole-plan publishing. A Route may have its own draft/published lifecycle. |
| A14 | Each slice names its executable dependencies, rungs and stops. Retiring a referenced child refuses the candidate. Escalate a whole-desk budget over 40 statements. |
| A15 | Take the next free ADR number on freshly fetched main at merge and update every reference. The ledger and walkthrough identify `11d0e030` as the reviewed tip. |

**S1–S5 adopted.** Measure the 160-stop day against the 100-segment cap, allow saved resource filters, offer Schedule in the map list, report “7 of 12 on the map” at compact width, and keep company/viewer data out of the public basemap cache key.

## Slices and acceptance cases

1. **Map.** Consume CONNECT-1 Address and implement the viewport seam in the ADR-0080 single-writer framework. The checkpoint uses Demo Maps only, without network or credentials. Live display uses Google Maps JS with the new app-specific browser key. Sortable-field order ships first.
2. **Any-resource timeline.** First tasks are the slice 1 review ride-alongs, from the Fable review of `b9685be2`. 4a and 4b: red tests for the authoring-base digest and for skipped validation of retired revisions. 4d: tests for the `map_viewport_read` grant and the server half of the browser display path. 4e: `test/evidence/PLANNER-1.expected-red.json`. 5: a served two-company Party or Location Map with company scope `none`, plus a company chooser. 6: a warning or named limit for the 512-candidate ceiling, with the narrowing hint shown only for real controls. 8: cursor anchors and viewport handles in ADR-0081's process-local table. 9: a `map` eval scorer that also checks the order field. 10: a Maps JS version-retirement signal and a WebKit check before live display. Then: after CALENDAR-1 3a and executable ADR-0087 intervals, bind a truck type and a technician type. Exercise all four forms, race two dispatchers and retry a lost response. Expect one change and receipt. Stop if the writer cannot protect the field pair on every path.
3. **Planner.** After slices 1–2 and CALENDAR-1 1b, schedule by drop and keyboard on separate fixtures. Verify the route, queue and bar after confirm, then advance the common day. Run compact, company and whole-page budget gates.

## Test it yourself

From the packet checkout, run `git diff --stat 630e2aa6 11d0e030` for the reviewed design and `git diff --stat 11d0e030 HEAD` for this amendment. Read the [dispatch walkthrough](../../decisions/ADR-0092-map-resource-assignment-and-planner-workspace.md#4-compose-the-desk-and-review-one-assignment) against these design checkpoints (under ten minutes).

1. Open Today's north route. The stop list and pins use the same stop numbers. Pan north and the area query can reach a stop beyond the first 100. With script off a pin still opens its Record.
2. Schedule a located pickup on truck 12 at 09:00, enter 10:30 and confirm. The pickup leaves the queue, appears on the 09:00 row and joins the truck's line from its stored start. Overlap review describes only jobs the dispatcher can read.
3. Reassign the pickup to truck 7, reschedule it, then unassign it. Each form shows both old and proposed values. A stale second dispatcher sees the permitted current state. A failed background still leaves the list and forms usable.

## Gates

Full CI on `ffbe80a8` failed on the basemap inline style, and `955f5d83` failed on a banned word (`source`) in the gateway. The fix moves sizing into the hash-pinned loader, keeps `'unsafe-inline'` (see ADR-0036) and renames the pin field to `provenance`. The run on the merged tip is in the lane result.

CI tier: full https://github.com/AnserBeg/2rain-greenfield/actions/runs/45065546519

## Slice 1 build checkpoint · 2026-11-21

The collection Map serves rental deliveries, field-service visits and distribution pickups. The owner selected Google Maps JS behind the viewport seam. The licensed basemap runs in an isolated browser frame, with the ordered links and accessible list in the parent. CI uses Demo Maps. Main took rungs 40–44 (record buttons, billing allocation, company access indexes, report sources, grouped reports), and BILLING takes 45 in TRAIN-I. One rung, 46, covers the Map member and its viewport binding, so an older reader refuses both by one name. The older-reader proof is pinned at TRAIN-K integration to the preceding main `44c4b6ac` (REBASE-1 record). The Map proof runs in shard 5. Slice 3 will compose registered views with shared context and quick-create, including a phone desk without a map.

| Gate | Evidence at this checkpoint |
| --- | --- |
| Paging and order | Seven-row and 100-row page limits and the visible overflow count pass. Native PostgreSQL passed numeric route order, day, company isolation, area rank, cursor restart and the candidate ceiling. A separate run published the Sales Map and returned the EUR order while excluding the CAD order. |
| §2a | The PostgreSQL-backed Chromium dispatch journey passed linked pins, route order, cancelled and completed drags, newest reply, focus, Back, three sizes, compact list-first Tab order and script-off pin-to-Record navigation. |
| Company and image | Chromium observed the dedicated display origin as the Google referrer and refused frame access to the ERP page. Nine imagery checks passed, including concurrent reservations. Isolated removals of the company binding, public cache sharing, single-stop coarsening, single-call rule and seven raster/deadline checks each failed their test. The served test checks prefetch, company swap and cache reuse against quota rows. |
| Dispatcher message | Hardcoding 100 made the seven-row overflow assertion fail. The checked-in renderer uses the visible count. Fable review fixes (`d8bed226`): the adapter's `MAP_PROVIDERS` descriptors decide display, credit, imagery and the browser frame. A third provider declared only there drives display and credit, and forcing `raster` reds that test. Declared labels and titles replace the dispatch words; removing the title lookup reds the Parties-by-Territory test. First-seen group styles and the Next refit each red when removed. Sentences never pluralize a declared label, for example "Showing 100 of 620 in this filter — choose a Route or Day". GENERALIZE backlog: CONNECT-1's settings form, address context, Customize installation list and configure check still name providers. They should move to the same descriptors. |
| Compatibility and SPEED-1 | Native PostgreSQL matched the prior release root, definition, manifest and artifacts byte for byte. The archived reader served a pre-Map row and refused the Map release by name. Sparse and 100-stop pages each used 2 transactions, 33 statements, 3 authorization reads and zero repeats. Full-page p95 was 178 ms over five requests. The combined local test reached its 15-minute limit while publishing the sales fixture. The sales case passed independently. |
| Customize, replay and drafter | Seven focused Map tests passed, including label-only upgrade for active and retired revisions and both schema-generated draft order directions. The exhaustive replay inventory and its conflicting/compatible Map case also passed. |
| Rule 12 | AI-BUILD-1 slices 1–2 are on main, so the eval exception has ended. After merging main at `5710c05a`, `addMapViewRevision` is a choice-shaped `DRAFTER_KINDS` member with schema-generated input and description. `MAP_VIEW_DRAFTER_GUIDANCE` adds its guidance sentence. The converter builds the revision from listed Map targets, and `customization-ai-draft-slice2` passes. Eval follow-up cases P01 (dev) and P02 (held-out) use a new `map` outcome. |
| A1 and CI | The orchestrator landed the Map grammar and four slots at `1fe5b169`. The slice uses the CI-5 shard split from main at `352e43b7`. |

**Try it yourself** · `node --import tsx --test --test-concurrency=1 test/unit/map-imagery.test.ts test/unit/customization-map.test.ts` exercises the fake raster, scope checks, page sizes, route filters, Customize and replay.

```record-claim
{
  "schemaVersion": "northstar.record-claim/v1", "packet": "PLANNER-1",
  "base": "37bfd47311c58060000cebca49d5f55174e3874a", "head": "af0ceac0779584f7d4ad2fa055c19d0c82903f42",
  "changedPaths": [
    ".agents/skills/ux-grammar/SKILL.md", "apps/api/src/composition-root.ts", "apps/web/package.json", "apps/web/src/app-server.ts", "apps/web/src/component-registry.ts", "apps/web/src/customize-screen.ts", "apps/web/src/google-basemap.ts", "apps/web/src/ledger-styles.ts", "apps/web/src/map-display-origins.ts", "apps/web/src/map-view.ts",
    "apps/web/src/surface-client.ts", "apps/web/src/surface-contract.ts", "apps/web/src/surface-runtime.ts", "apps/web/src/workspace-entry.ts", "apps/web/test/browser/planner-map.spec.ts", "apps/web/test/browser/surface-grammar.spec.ts", "docs/decisions/ADR-0036-minimum-client-capability.md", "docs/decisions/ADR-0080-connector-framework.md", "docs/decisions/ADR-0092-map-resource-assignment-and-planner-workspace.md", "docs/execution/ledger.md",
    "docs/execution/packets/CONNECT-1.md", "docs/execution/packets/PLANNER-1.md", "docs/greenfield-north-star-erp-platform-plan.md", "package.json", "packages/canonical-model/src/address.ts", "packages/canonical-model/src/constants.ts", "packages/canonical-model/src/index.ts", "packages/canonical-model/src/map-view.ts", "packages/canonical-model/src/map-viewport.ts", "packages/canonical-model/src/schemas.ts",
    "packages/canonical-model/src/surface-workspace.ts", "packages/compiler/src/address.ts", "packages/compiler/src/projections.ts", "packages/customization/src/ai-draft-kinds.ts", "packages/customization/src/ai-draft.ts", "packages/customization/src/apply.ts", "packages/customization/src/authoring-rules.ts", "packages/customization/src/board-revision.ts", "packages/customization/src/index.ts", "packages/customization/src/map-revision.ts",
    "packages/customization/src/patch.ts", "packages/customization/src/targets.ts", "packages/customization/src/upgrade-diagnostics.ts", "packages/customization/src/upgrade-replay.ts", "packages/dev-tooling/src/surface-grammar-conformance/index.ts", "packages/dev-tooling/src/surface-runtime-seam.ts", "packages/postgres-provider/src/address-geocodes.ts", "packages/postgres-provider/src/address-provider.ts", "packages/postgres-provider/src/current-policy.ts", "packages/postgres-provider/src/map-admission.ts",
    "packages/postgres-provider/src/map-imagery.ts", "packages/postgres-provider/src/map-page.ts", "packages/postgres-provider/src/module-runtime-interpreter.ts", "packages/postgres-provider/src/release-repository.ts", "packages/postgres-provider/src/request-runtime-view-service.ts", "packages/postgres-provider/src/serving-gateways.ts", "packages/runtime/src/address-gateway.ts", "packages/runtime/src/request-runtime-view.ts", "packages/runtime/src/semantic-query-gateway.ts", "test/agent/build-bakeoff-run.ts",
    "test/agent/build-eval-cases.ts", "test/agent/build-eval.ts", "test/architecture/repository-hygiene.test.ts", "test/architecture/ux-grammar-skill.test.ts", "test/evidence/CALENDAR-1-board-v2.expected-red.json", "test/evidence/CONNECT-1.expected-red.json", "test/fixtures/g2/language-conformance/coverage-decisions.json", "test/helpers/planner-map-fixture.ts", "test/helpers/reachability-producers.ts", "test/postgres/planner-map.test.ts",
    "test/postgres/request-runtime-view.test.ts", "test/unit/customization-map.test.ts", "test/unit/customization-upgrade.test.ts", "test/unit/map-imagery.test.ts"
  ],
  "symbols": [{"path":"apps/web/src/map-view.ts","name":"readMapSlots"},{"path":"packages/customization/src/map-revision.ts","name":"applyMapRevision"},{"path":"packages/postgres-provider/src/map-admission.ts","name":"mapBindingsProblem"},{"path":"packages/postgres-provider/src/module-runtime-interpreter.ts","name":"readMapCandidates"},{"path":"packages/postgres-provider/src/address-provider.ts","name":"mapProviderDescriptor"}]
}
```
