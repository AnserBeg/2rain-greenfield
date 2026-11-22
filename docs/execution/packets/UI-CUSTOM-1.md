# UI-CUSTOM-1 · Companies colour lists by rule, size columns and choose density, with no code

Charter: `/home/rvham/2rain-missions/charters/UI-CUSTOM-1-charter.md` (slice 1, plus the list sizing that rides with it).

**Slice 1 · BUILD checkpoint, 2026-11-22.** A company, or the in-app AI on its behalf, adds one Customize member, `addPresentationRevision`, to a list. The member does three things: it colours a cell or a whole row when a condition holds, it sizes columns by stable field ID, and it sets density for the list or for one saved view. The member is stored on the surface and compiled into the surface manifest. It renders on the server from rows the list has already read.

CI tier: full https://github.com/AnserBeg/2rain-greenfield/actions/runs/45062389207

## General blocks (rules 16 and 17)

- **Placement model.** A closed, versioned set of placement kinds:
  - form: formHeader, formSection, field;
  - list: listToolbar, listRow, listCell;
  - line table: lineTableToolbar, lineRow, lineCell;
  - boardCard, metricCard and homeSection.

  `surfacePlacements` derives each surface's placements from its compiled slots, list, layouts, line tables, board and launcher, never from a per-module list. Targets are canonical IDs, never labels. Slice 2 buttons reuse the model.
- **Condition block.** The block is the ADR-0076 kernel, unchanged and three-valued. It supports comparisons, field versus field, literals, presence and all/any/not. Each rule pins the type of every operand it reads.
  - **When a tone shows:** only `true` shows a tone. An unknown value shows none. A withheld or malformed value shows none and adds one quiet note to the list.
  - **Later consumers:** saved-view filters and button visibility can drive the same block later without reshaping it (audit gap 6). A date range is `all` of two comparisons. Today, the week and month bounds, and "me" are `field` operands with reserved runtime IDs (`CONTEXT_OPERAND_IDS`), the same route validation uses for the business date.
  - **Slice 1 refuses by name:** every context operand, and the linked-record `path` operand. Linked values belong to slice 3, through a governed query.
- **Tone rule.** Most general form: a condition on any value a surface reads drives success, attention, blocked, inProgress or neutral at a declared placement.
  - **Placements:** the schema accepts field, listCell, listRow, lineRow, lineCell, boardCard and metricCard. This release renders listCell and listRow and refuses the rest by name.
  - **Display:** every tone shows colour, dot and word. The word is also the accessible name. A row tone adds a tinted ground and a leading marker.
  - **Precedence:** the release's own rules come first, then declared order, one tone per target, at most 24 rules.
- **Declared sizing.**
  - **Columns:** width is narrow, normal, wide or auto, and text wraps or clips. Sizes are named, never pixels, and the compact projection drops them.
  - **Density:** per list and per saved view.
  - **Not yet:** the schema already names form field span and height and card size; it refuses them until slice 4.
- **Deliberately narrower in this slice:** no today, me or linked operands in tones. No company-chosen glyphs: a declared rule always shows its word.
- **Businesses:** distribution (on hand below reorder point), clinics (no-show rows) and rentals (units returned below units out). Each is a separate app with its own names and IDs in `test/unit/surface-presentation.test.ts`.

## Decisions

1. **The first-party Short mark is re-expressed byte-identically.** At render time the List's declared `progress.supply` derives a tone rule (`supplyTones`), which renders through the same path as company rules. Release bytes and floors are unchanged, and the exact-HTML witnesses pass unchanged.
2. **One member and one compiled key carry tones, sizing and density, at reader rung 49.** The rung is PROVISIONAL and is renumbered at merge. On this branch the binary also claims 45-48, which are claimed elsewhere. Admission requires declaration and floor to agree both ways, and requires the compiled key to equal what the declaration compiles to.
3. **Rule 10: choices are stored by ID.** The member stores rule, field and view IDs and the kernel condition. It stores no body digest, and labels render from the release. Each list has one current revision, with a predecessor for edit and retire. A retired revision is carried but never validated. Replay is structural: a removed operand or column is `RETIRED_TARGET`, and the conflict names that ID.
4. **Arranging stays free (the Board v2 pattern).** The strict checks run only on the authoring base. Elsewhere, a rule or size whose placement or value is gone stays inert, with a diagnostic naming the ID, so hiding a column never blocks arranging.
5. **Rule 2: no new read.** A tone reads only the viewer's already-projected row: no query, no join and no company boundary. Authorization is per query, and no per-role field narrowing exists to bypass. A withheld supplementary figure (`whenDenied: omit`) is absent from the row, so its rule is unreadable and shows no tone.
6. **The drafter keeps current rules.** It merges by rule ID, which derives from the reason. The diff names any rule it removes. Refusals are repairable.
7. **Not in this slice:** a visual Customize form. Authoring goes through the in-app AI drafter or the patch API.

## Gates and test it yourself

- **Unit:** placements; three-valued tones, including a withheld value; refusals by name (an unread value, a linked record, today and me, a type mismatch, an unrendered placement); field add, relabel and hidden columns with the rule active; a stale revision, and a retired revision that is not validated; clinic and rental apps; rung 49 and an admission tamper.
- **Upgrade allowlist:** a relabelled base replays clean. A base missing the operand names it.
- **Running server** (`test/postgres/presentation-list.test.ts`, green locally before CI):
  - two companies share one tenant;
  - the cell and row tones follow on hand below reorder point, and clear when stock rises;
  - South's rows never appear for North;
  - the archived `1092e14d` reader answers a query, then refuses rung 49 by capability name;
  - its compiler, given a company-owned chain as recorded, produces releases byte-identical to the current compiler.
- **Drafter** (rule 12): generated from `PresentationDraftSchema`. The AI-RELY-1 gate scores cases P01-P05: cell, row, sizing, and unsupported "flash" and "today". Live grading is pending with AI-BUILD-1.
- **Regression controls** (rule 8): all 7 entries in the [expected-red manifest](../../../test/evidence/UI-CUSTOM-1-s1.expected-red.json) reproduced locally.

**Try it yourself.** Add a record type **Stock item** with On hand and Reorder point. Ask the assistant: "make items with on-hand below reorder point red". Approve and activate. On the list, a row with on hand 2 and reorder point 5 shows a red **Low stock** pill. Change on hand to 12: the pill disappears.

```record-claim
{
  "schemaVersion": "northstar.record-claim/v1", "packet": "UI-CUSTOM-1",
  "base": "1092e14d22890d172ac8e68099fdd78093898339", "head": "dade06d3bb0fb57dd077ad8e91e4789cb0e48623",
  "changedPaths": [
    "apps/web/src/component-registry.ts", "apps/web/src/customize-screen.ts", "apps/web/src/ledger-styles.ts", "apps/web/src/list-declaration.ts", "apps/web/src/surface-contract.ts", "package.json",
    "packages/canonical-model/src/index.ts", "packages/canonical-model/src/schemas.ts", "packages/canonical-model/src/surface-presentation-schema.ts", "packages/canonical-model/src/surface-presentation.ts",
    "packages/canonical-model/src/surface-workspace.ts", "packages/compiler/src/projections.ts", "packages/customization/src/ai-draft-kinds.ts", "packages/customization/src/ai-draft.ts", "packages/customization/src/apply.ts",
    "packages/customization/src/authoring-rules.ts", "packages/customization/src/index.ts", "packages/customization/src/patch.ts", "packages/customization/src/presentation-revision.ts", "packages/customization/src/render.ts",
    "packages/customization/src/targets.ts", "packages/customization/src/upgrade-diagnostics.ts", "packages/customization/src/upgrade-replay.ts", "packages/postgres-provider/src/customization-service.ts",
    "packages/postgres-provider/src/presentation-admission.ts", "packages/postgres-provider/src/release-repository.ts", "packages/runtime/src/request-runtime-view.ts", "test/agent/build-bakeoff-run.ts",
    "test/agent/build-eval-cases.ts", "test/agent/build-eval.ts", "test/architecture/repository-hygiene.test.ts", "test/evidence/UI-CUSTOM-1-s1.expected-red.json", "test/fixtures/g2/language-conformance/coverage-decisions.json",
    "test/helpers/reachability-producers.ts", "test/postgres/presentation-list.test.ts", "test/postgres/request-runtime-view.test.ts", "test/unit/customization-ai-draft-gates.test.ts", "test/unit/customization-upgrade.test.ts",
    "test/unit/surface-presentation.test.ts"
  ],
  "symbols": [
    {"path":"packages/canonical-model/src/surface-presentation.ts","name":"compilePresentation"},
    {"path":"packages/canonical-model/src/surface-presentation.ts","name":"presentRow"},
    {"path":"apps/web/src/list-declaration.ts","name":"supplyTones"}
  ]
}
```
