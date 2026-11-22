# UI-CUSTOM-1 · Companies colour lists by rule, size columns and choose density, with no code

Charter: `/home/rvham/2rain-missions/charters/UI-CUSTOM-1-charter.md` (slice 1 plus the list sizing that rides with it).

**Slice 1 · BUILD checkpoint, 2026-11-22.** A company, or the in-app AI on its behalf, adds one Customize member, `addPresentationRevision`, to a list. It colours a cell or a whole row when a condition holds, sizes columns by stable field ID and sets the list's density. The member is stored on the surface, compiled into the surface manifest beside the list and rendered server-side from the rows the list already read.

## General blocks (rules 16 and 17)

- **Placement model.** A closed, versioned set of placement kinds: formHeader, formSection, field, listToolbar, listRow, listCell, lineTableToolbar, lineRow, lineCell, boardCard, metricCard and homeSection. `surfacePlacements` derives each surface's placements from its compiled slots, list, layouts, line tables, board and launcher. Nothing is hand-listed per module. Targets are canonical IDs, never labels. Slice 2 buttons reuse it.
- **Condition block.** This is the ADR-0076 kernel (`ValidationPredicate`, `inspectValidation`), unchanged and three-valued. It supports comparisons, field versus field, literals, presence and all/any/not. Each rule pins its operand types, as validation bindings do. Only `true` shows a tone. An unknown value shows none. A withheld or malformed operand shows none and adds one quiet "could not be judged" note to the list.
  - The same block can later drive saved-view filters and button visibility without reshaping (audit gap 6).
  - A date range is `all` of two comparisons.
  - Relative dates and the current user are `field` operands with reserved runtime IDs (`CONTEXT_OPERAND_IDS`: today, week and month bounds, current principal). The business date already uses this route in validation.
  - Slice 1 refuses every context operand and the linked-record `path` operand by name. Slice 3 owns linked values through a governed query.
- **Tone rule.** The most general form: a condition on any value a surface reads drives one of success, attention, blocked, inProgress or neutral at a declared tone placement. The schema already accepts field, listCell, listRow, lineRow, lineCell, boardCard and metricCard. This release renders listCell and listRow and refuses the rest by name (`RENDERED_TONE_PLACEMENTS`).
  - Every tone shows colour, dot and word. The word is the rule's reason and its accessible name.
  - A row tone is a tinted ground, a leading marker and the word in the title cell.
  - Precedence is declared order. The release's own derived rules come first. There is one tone per target and at most 24 rules.
- **Declared sizing.** Column width (narrow, normal, wide or auto) and wrap or truncate, by field ID. Density is set per list and per saved view. The compact projection drops widths. Form field spans and heights, and card sizes, are already in the schema and refused by name until slice 4.
- **Deliberately narrower:** no today, me or linked operand in tones yet (see above). No company-authored glyph marks: a declared rule always shows its word.
- **Businesses served:** distribution (on hand below reorder point), clinics (a no-show visit row), rentals (units returned below units out). These are three apps with different names and IDs in `test/unit/surface-presentation.test.ts`.

## Decisions

1. **The first-party Short mark is re-expressed byte-identically.**
   - The List's declared `progress.supply` derives a tone rule at render time (`supplyTones`). It renders through the same `tonePill` path as company rules.
   - Release bytes and floors are unchanged.
   - The existing exact-HTML witnesses pass unchanged: `test/integration/surface-data-binding.test.ts`, `test/postgres/order-lists-supply.test.ts`, the `[data-short-mark]` browser locators and the `shortMarked` value table.
   - The generic renderer names no field. The derived rule carries its own glyph and marker attribute.
2. **One member and one compiled key, at reader rung 49** for tones, sizing and density.
   - Rung 49 is **PROVISIONAL** and is renumbered at merge. This branch's binary claims 45-48 without implementing them, which is safe on this branch only.
   - Admission requires declaration and floor to agree both ways (`PRESENTATION_READER_MISMATCH`). It also requires the compiled key to equal what the declaration compiles to (`presentation-admission.ts`).
3. **Rule 10.**
   - The member stores rule IDs, field IDs, view IDs and the kernel condition. It stores no body digest. Labels render from the release.
   - One current revision per list. Editing and retiring both take the predecessor.
   - A retired revision is carried and never validated.
   - Replay (ADR-0085 A20) is structural. A removed operand or column is `RETIRED_TARGET` naming that field ID, and the rule stops applying.
4. **Rule 2.** A tone reads only the viewer's already-projected row: no new query, join or company boundary. A field the role may not read is absent from the row, so no tone and no leak follow.

## Gates and test it yourself

- **Unit** (`test/unit/surface-presentation.test.ts`):
  - placement derivation;
  - three-valued tones, including the withheld case;
  - refusals by name: a value the list does not read, a linked record, today, a type mismatch, the metricCard placement;
  - field add, relabel, stale revision and retired-not-validated;
  - clinic and rental apps;
  - rung 49 compiled and admission tamper.
- **Upgrade allowlist** (`test/unit/customization-upgrade.test.ts`): a relabelled base replays clean; a base without the operand names it.
- **Running server** (`test/postgres/presentation-list.test.ts`):
  - two companies in one tenant;
  - the cell and row tones follow on hand below reorder point and clear when stock rises;
  - South's low row never appears for North;
  - the archived `1092e14d` (preceding main) serving binary answers a query, then refuses rung 49 by capability name.
- **Drafter** (rule 12): `DRAFTER_KINDS.addPresentationRevision` is generated from `PresentationDraftSchema`, and the coverage guard includes it. AI-BUILD-1 cases P01-P05 (list cell, list row, sizing, and unsupported "flash" and "today") are added. Live grading is pending with AI-BUILD-1.

**Try it yourself.** Add a record type **Stock item** with On hand and Reorder point. Ask the assistant: "make items with on-hand below reorder point red". Approve and activate. Open the list: a row with 2 on hand and reorder point 5 shows a red **Low stock** pill. Change on hand to 12 and the pill is gone.

CI tier: full (pending)
