# COMPOSITION-BOUNDS-RAISE — six v6 composition bounds raised so full parity fits

Status: **ruled — owner ruling 2026-10-05, "raise it"; ADR-0070 Accepted.**
ADR-0070 lives in the companion packet `STRUCTURAL-LIMITS-RAISE` (PR #30,
against `main`) until INTEGRATION folds that in. Draft PR against
`packet/INTEGRATION`; the INTEGRATION agent folds it in, this lane merges
nothing. Tier: Behavioral, outside the AGENTS.md §4 Critical set. Stops: 0.
Base `8c8cfab1` (`packet/INTEGRATION`), executable head `4f178953`.

The owner answered the orchestrator's table with "raise it": package bytes
2 MiB -> 4 MiB (PR #30); record page fields 30 -> 48; page actions 12 -> 24;
Task steps 5 -> 12; page children 8 -> 12; header facts 6 -> 8; List columns
12 -> 16; List views stays 8.

## Claims

1. Exactly six bounds in `packages/canonical-model/src/schemas.ts` change,
   and nothing else: `compositionAction.steps` 5 -> 12 (line 903),
   `presentation.header.facts` 6 -> 8 (980), `SurfaceCompositionSchema.fields`
   30 -> 48 (1087), `.children` 8 -> 12 (1088), `.actions` 12 -> 24 (1089),
   `SurfaceListSchema.columns` 12 -> 16 (1729).
2. For each, a real page at exactly the new maximum passes
   `normalizeApplicationPackage`, and one more is refused with
   `CANON_SCHEMA_INVALID` at that bound's own path, identically twice.
3. Each raise only admits more: no golden vector, release root or recorded
   lineage entry moves.

## Census (2026-10-05)

Every `.max(n)`/`.min(n)` in `schemas.ts` (247 distinct bounds) and every
`STRUCTURAL_LIMITS_V0` bound. Each application was built with its own ref's
code, in memory, from `git archive` copies: INTEGRATION `8c8cfab1`,
SALES-EXTRAS, UNITS, SPECIAL-ORDER, STOCK-COUNTS, RETURNS, RETURNABLE-ASSETS,
SALES-PARITY and LOCATIONS-2. Counted members are INTEGRATION plus what each
leaf adds over its merge-base with INTEGRATION.

| Bound | Was | Used at parity | Now |
|---|---|---|---|
| page `fields` | 30 | 34 — sales order: 28 + SALES-EXTRAS' credit facts and counter flag | 48 |
| page `actions` | 12 | 16 — purchase order: 12 + SPECIAL-ORDER 3 + STOCK-COUNTS 1 | 24 |
| Task `steps` | 5 | 11 — SALES-EXTRAS' counter sale (that branch sets 12 itself) | 12 |
| page `children` | 8 | 8 of 8 on both order pages | 12 |
| header `facts` | 6 | 6 of 6 on five record pages | 8 |
| List `columns` | 12 | 12 of 12 on the item stock and sales order Lists | 16 |
| List `views` | 8 | 9 — sales order List (+ Counter view) | 8, unchanged |

Also at or above 75%, unchanged: List `rowActions` 3/3, print `totals` 7/8,
progression `next` 5/6, block `columns` 6/8, figure `sums` 6/8, band `cases`
3/4, scan `targets` 6/8, `LabelSchema` 232/240 (one long description), decimal
precision 38/38 and scale 18/18 (71 quantity fields use the maximum by
design). Every `STRUCTURAL_LIMITS_V0` family count is under a quarter of its
bound; the byte maximums are PR #30.

## Decisions

- Values leave room for the remaining parity items (units on lines, lot, approvals, item page stock and valuation figures, received-on, reports and dashboard), not an open-ended raise. ADR-0070.
- Task steps take SALES-EXTRAS' own value 12, so that leaf's identical line merges cleanly.
- List saved views stays 8: Counter sales moves to its own worklist (coordinator).
- Boundary pages pad real members with fresh ids; facts reuse columns the header and blocks do not show; List columns pad non-title columns, because the composition validator rightly refuses duplicates and a second title.
- Expected paths are computed from the authored app's surface order, so new surfaces from merged leaves do not move the test.
- The former "twelve-action" APPROVAL-PO test pinned 13 as refused; it now pins 25.
- Separate packet from STRUCTURAL-LIMITS-RAISE because these schemas exist only on INTEGRATION (coordinator).
- Review: not owed — outside the Critical set. The owner's ruling is the gate.

## Gates

- Local at `4f178953`: LOCAL_GATES_PENDING
- Controls (evidence only, scratch copy of INTEGRATION): each bound one lower
  or back at its old value reds the boundary test, all six; restored clean.
- A page with all six at their new maximums at once normalizes and compiles
  (scratch measurement on INTEGRATION's compiler).
- CI: CI_PENDING. `scripts/check-records.sh`: PASS.

## Test it yourself

About three minutes, no Docker, in the packet worktree.

```sh
cd /home/rvham/2rain-greenfield-bounds
git log --oneline -3
git diff 8c8cfab1 HEAD -- packages/canonical-model/src/schemas.ts | grep '^[-+] '
FORCE_COLOR=0 node --import tsx --test test/unit/canonical-model/surface-composition.test.ts
corepack pnpm check:app-release && corepack pnpm check:demo-release && echo RELEASES-UNCHANGED
git diff --stat 8c8cfab1 HEAD -- apps/web/release test/fixtures
```

Expect: six `-`/`+` line pairs (5 -> 12, 6 -> 8, 30 -> 48, 8 -> 12,
12 -> 24, 12 -> 16); the test file reports `# pass 8`, including "the parity
composition bounds admit exactly their maximum and refuse one more";
`RELEASES-UNCHANGED` prints; the last command prints nothing.

## Filed

- Document-editor `lineFields` is 11 of 15 at parity; units on lines and lot bring it near 15. Watch it.
- `LabelSchema` 232 of 240 is one item-stock dataset description; shorten the prose rather than raise it.

Review: not owed — outside the Critical set.

```record-claim
{
  "schemaVersion": "northstar.record-claim/v1",
  "packet": "COMPOSITION-BOUNDS-RAISE",
  "base": "8c8cfab1c54ac1b51b4617e45f8e2f0ddd1dfa1b",
  "head": "4f178953de8047f5aff6dd315f54af05aa2cae6f",
  "changedPaths": [
    "packages/canonical-model/src/schemas.ts",
    "test/unit/canonical-model/surface-composition.test.ts"
  ],
  "symbols": [
    { "path": "packages/canonical-model/src/schemas.ts", "name": "SurfaceCompositionSchema" },
    { "path": "packages/canonical-model/src/schemas.ts", "name": "SurfaceListSchema" },
    { "path": "packages/canonical-model/src/schemas.ts", "name": "compositionAction" },
    { "path": "test/unit/canonical-model/surface-composition.test.ts", "name": "COMPOSITION_BOUNDS" },
    { "path": "test/unit/canonical-model/surface-composition.test.ts", "name": "padMembers" }
  ]
}
```
