# CALENDAR-1 · Board, calendar and resource timeline

**Owner walkthrough deferred until the Board v2 fix lands.**

Slice 0 established [ADR-0086](../../decisions/ADR-0086-board-calendar-and-resource-timeline.md) with the owner’s reference survey. Fable’s verdict was ACCEPT WITH AMENDMENTS; the orchestrator accepted A1–A14. The delivery order is 1a (Board form), 1b (pointer), 2 (Calendar), 3a (generic timeline) and 3b (Booking timeline).

## Design decisions

- The customer adds a view to a record type in Customize. Each archetype has fixed anatomy, a compact presentation and a bounded Semantic Query.
- A board drop enters a Task for the record’s declared transition. A calendar reads a date or interval. The timeline can change either eligible edge through Booking’s Change interval operation. Extend and Shorten each require explicit confirmation.
- The proposal extends ADR-0036 with one pointer gesture over server-rendered targets. The ordinary form supports the same choices using a keyboard, touch or JavaScript-disabled browser.
- Slice 1a uses the existing INTERACT-1 Task. It has no dependency on UI-COMPOSE-1 pop-ups. ADR-0082’s amendment re-read returned ACCEPT WITH AMENDMENTS. BOOKING-1 is applying A8, the `booking.resourceWindow/v1` contract. Slice 3b waits for BOOKING-1 slices 1a, 2 and 3. The Booking calendar separately requires its owner-collection window query.
- Each executable capability takes its reader rung at merge. This design allocates no rung or migration.

Calendar slice 2 can bind a typed point or interval, and timeline slice 3a a typed interval, by stable field ID and an expected-contract pin once the corresponding CUSTOMIZE-5 slice ships. The pin must match the field’s granularity and end convention. The view chooses its axis zone independently. For a two-date source, the view declares the convention and pins ADR-0083 A1 for derived midnight, business-day and inclusive-successor boundaries (first valid instant after a gap, earlier offset in a repeated hour). Slice 2 proves Toronto March 8 leave occupies March 8 alone on a Vancouver calendar through both paths. [ADR-0087](../../decisions/ADR-0087-tenant-date-time-and-interval-fields.md)

**Usability evidence for slice 1a (plan §8.6 item 4) is PENDING** the owner’s hands-on walkthrough or explicit waiver. The steps below are the lane’s test instructions.

## Gates

The record check and all 18 jobs passed at `662e09be`. The packet then incorporated the amended Booking contract and the next free ADR number under the docs-only re-run rule. The ADR specifies the acceptance evidence for the executable slices. [CI 44676435105](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44676435105)

The amendment merged at `2915711e`. The next completed main run containing it passed. [Main CI](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44707510265)

## Design walkthrough

1. In **What a drop can request**, move a card between two stages with two possible operations. Find the named choice, required confirmation and check of current state.
2. In the same section, extend 09:00–11:00 to noon while a second booking wins the hour. Trace the refusal to the original stored end. Follow **Change end** to see the same decision with JavaScript off. Moving the start instead must preserve the stored end.
3. In **Time windows, coverage and page budget**, find an interval that starts before the displayed month and ends inside it. Check how to reach entry 101, and what a shared resource can reveal to someone with availability-only access.
4. Run `scripts/check-records.sh` from the repository root. Expect exit status zero.

## Slice 1a · Board form

Board uses Surface reader 33 above Maps reader 32. It adds no migration. An [earlier browser run](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44762007884/job/136376706859) timed out after five tests. All 24 jobs passed at `4ea5ba00`. [Candidate CI](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44773881408)

The tenant fixture publishes an Opportunity board with a declared Open → Won transition. The first-party fixture publishes a Purchase order board with its existing Cancel order operation. Both use version 1 lifecycle-state grouping and cap each card at three key facts.

- At 390 px with JavaScript disabled, opening and reviewing the Move Task left the operation gateway count at zero. Confirm invoked the named operation once. [Chromium journey](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44773881408/job/136418564920)
- A second tab confirmed the stale review. It showed Won, refused the change, and left the stored revision at its single increment. [Two-tab regression](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44773881408/job/136418564920)
- The archived rung-32 Maps binary served the tenant before activation and returned `UNSUPPORTED_RUNTIME_CAPABILITY` after activation. The rung-33 binary served the same Board. [Serving-reader regression](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44773881408/job/136418564576)
- The archived and current compilers produced byte-identical release envelopes for the same Board-free tenant patch. The checked-in application release also reproduced. [Release comparison](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44773881408/job/136418564576) · [Application release](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44773881408/job/136418564886)

**Try it yourself.** Run `corepack pnpm dev` and open the demo tenant with a draft purchase order. The browser regression also creates a tenant Opportunity with Open and Won stages and uses the same controls at 390 px.

1. Open **Customize → Add view**, choose **Purchase orders**, then **Add Board view**. Name it **Orders by stage**, leave the stage positions in their offered order, and choose **Draft Board**. The diff should name the stages and the cancellation action.
2. Approve the diff and activate it. Open **Purchase orders → Orders by stage**. Each card links to its order and shows up to three key facts. An empty stage has a heading. At 390 px, use **Select stage** to switch columns.
3. Disable JavaScript, reload, and open the Board in two tabs. In both tabs, Tab to **Move card** on the same draft and press Enter. Select **Cancelled · Cancel order**, then **Review move**. The order should still be in Draft.
4. In the first tab, read the named consequence and confirm. The order should appear in Cancelled. Confirm the stale review in the second tab. It should show the current permitted stage and ask for a fresh decision. The order revision should have advanced once.

```record-claim
{
  "schemaVersion": "northstar.record-claim/v1",
  "packet": "CALENDAR-1",
  "base": "032b87c00df3ee22184685050b9cecc01c62cc59",
  "head": "adcf3a158ad773cdee4256471a1df04d75fc6b2f",
  "changedPaths": [
    ".agents/skills/ux-grammar/SKILL.md", "apps/web/src/board.ts", "apps/web/src/component-registry.ts",
    "apps/web/src/customize-screen.ts", "apps/web/src/ledger-styles.ts", "apps/web/src/surface-contract.ts",
    "apps/web/src/surface-runtime.ts", "apps/web/src/workspace-entry.ts", "apps/web/test/browser/customize.composed-application.spec.ts",
    "apps/web/test/browser/surface-grammar.spec.ts", "docs/execution/packets/CALENDAR-1.md", "docs/greenfield-north-star-erp-platform-plan.md",
    "packages/canonical-model/src/board.ts", "packages/canonical-model/src/constants.ts", "packages/canonical-model/src/index.ts",
    "packages/canonical-model/src/schemas.ts", "packages/canonical-model/src/surface-workspace.ts", "packages/compiler/src/projections.ts",
    "packages/customization/src/ai-draft.ts", "packages/customization/src/apply.ts", "packages/customization/src/board-revision.ts",
    "packages/customization/src/index.ts", "packages/customization/src/patch.ts", "packages/customization/src/render.ts",
    "packages/customization/src/targets.ts", "packages/dev-tooling/src/surface-grammar-conformance/index.ts", "packages/dev-tooling/src/surface-runtime-seam.ts",
    "packages/postgres-provider/src/board-admission.ts", "packages/postgres-provider/src/module-runtime-interpreter.ts", "packages/postgres-provider/src/release-repository.ts",
    "packages/postgres-provider/src/request-runtime-view-service.ts", "packages/runtime/src/request-runtime-view.ts", "packages/runtime/src/semantic-query-gateway.ts",
    "test/architecture/ux-grammar-skill.test.ts", "test/fixtures/g2/language-conformance/coverage-decisions.json", "test/postgres/customization-validation.test.ts",
    "test/postgres/request-runtime-view.test.ts", "test/unit/customization.test.ts"
  ],
  "symbols": [
    {"path": "apps/web/src/board.ts", "name": "boardTask"},
    {"path": "packages/customization/src/board-revision.ts", "name": "applyBoardRevision"},
    {"path": "packages/postgres-provider/src/board-admission.ts", "name": "boardBindingsProblem"}
  ]
}
```

## Board v2 fix

Required by the [view revision member shape ruling](../../decisions/ADR-0086-board-calendar-and-resource-timeline.md) after the independent Board review (verdict REVISE). The Board member becomes v2 with its own reader rung, and v1 is removed outright. Required proofs:

- With a Board active, and again after retiring it, adding a field and arranging the list on that type both still compile.
- A label-only base change to a stage, a fact column or an operation replays clean.
- A removed operation or field yields a typed conflict naming its ID (`RETIRED_TARGET`, `INCOMPATIBLE_TYPE` or `MOVED_MEMBER`), not `WHOLE_PACKAGE_FAILURE`.
- UPGRADE-2's compatible-base case relabels something the Board binds.
- Permission proofs (review finding 3):
  - a company-scoped read and move;
  - a cross-company negative;
  - no Move card without the transition grant;
  - a forged confirm returns 403;
  - a narrowed transition disappears;
  - a validation refusal leaves the card in place;
  - an automation-only edge is never offered.
- The scan-ceiling and timeout partial renders (finding 5).
- The understated-floor serving branch (finding 6).
