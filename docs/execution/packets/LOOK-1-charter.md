# LOOK-1 — charter: every screen in the Ledger look the owner chose

You are the BUILD lane. Chartered 2026-11-17 by the orchestrator; starts when LOOP-1 has merged its last slice. Worktree
`/home/rvham/2rain-greenfield-look-1`, branch `packet/LOOK-1`. Read `AGENTS.md`, `mission-cadence`, `git-workflow`, `ux-grammar`,
[loop-ux-plan.md](../loop-ux-plan.md) (phase 2), the spec [docs/design/ledger-spec.md](../../design/ledger-spec.md), and open the
mockup [docs/design/ledger-final.html](../../design/ledger-final.html) in a browser. Verify paths with `ls`/`grep`.

## Owner ruling (2026-11-17; do not reopen)
"Go with ledger base plus those three": the Ledger look, plus (1) a next-step card with one primary button on every record that has a
next action, (2) work queues with counts at the top of the sidebar, (3) per-line progress bars where a line has an ordered and a done
quantity. The final mockup and the spec are the target. Where the mockup and the spec disagree, the spec wins; ask only if both are
silent.

## Outcome
Every screen the app generates, including a record type a tenant adds through Customize, renders in the Ledger look. A side-by-side
screenshot of the app and the mockup for the seven mockup screens shows the same design. No screen keeps the old look.

## Slices (merge each to `main` on CI green)
1. **Tokens and type.** Replace the design tokens with the spec's colour, type, spacing and density tokens, light and dark, compact
   and comfortable. Fonts are self-hosted through the asset route SPEED-1 builds (no external font host); if it has not landed,
   coordinate with SPEED-1 rather than inlining. Amend the ux-grammar pins this supersedes (the baby-blue ramp, type sizes) in the same
   merge, each with one line naming the owner ruling.
2. **Shell.** The spec's sidebar (work queues with counts, then area groups, real icons), page header, breadcrumb, search, the
   workspace bar, and the demo "Acting as" strip restyled per the spec.
3. **Record page.** Title with status badge (kinds and glyphs per the spec), the next-step card from the authored progression's next
   action with a sentence template, the stepper, facts grid, lines table with progress bars, totals block, linked documents, activity.
4. **Lists, tasks, forms, empty states.** The spec's table, dialog with impact line where a figure exists, the create form (first
   fields, then "More details"), validation summary, empty states.
5. **The proof.** A browser test that renders the seven mockup screens from the seed, plus a tenant-added Equipment record
   (customization draft, approve, activate), screenshots each at 1440 and 390 in light and dark, and fails on raw codes or a missing
   generic part. Commit the screenshots under `docs/execution/evidence/` with the mockup's for comparison.

## Decided (do not reopen)
- Through the generator: renderer, tokens, message catalog and the authored definition only. No hand-built screen; no branch on an
  operation or entity id.
- Sentence templates take only the record's own fields and computed figures; no per-screen prose.
- Queue counts and progress figures come from the batched page loader SPEED-1 builds. Do not add a query per widget. If a figure
  has no declared source yet, render the part without it and file the gap.
- No new client behaviour beyond ADR-0036; motion only as the spec allows, honouring reduced motion.

## You decide alone (one line each in the record)
Component and file layout, the icon set (inline SVG, no dependency), sentence-template wording, the order of slices 3 and 4.

## STOP (five lines: what, two options, recommendation)
A language or schema version change; a ux-grammar pin you cannot amend under the owner ruling (name it); an ADR-0036 limit; a page
that would need its own hand-written screen; a CI red you cannot fix honestly.

## Lease
`apps/web/src/**` (rendering, tokens, styles, components; not `customize-screen.ts`'s service binding), `packages/domain/src/**`
(labels, icons, progression templates), `.agents/skills/ux-grammar/SKILL.md` (pin amendments), `test/browser/**`,
`docs/execution/packets/LOOK-1.md`, `docs/execution/evidence/**`. SPEED-1 owns the data-loading functions in
`surface-composition.ts` and `surface-runtime.ts`, `app-server.ts` and the asset route; AGENT-3 owns the assistant panel. Merge `main`
often.

## Gates and conduct
As in [LOOP-1](LOOP-1-charter.md) "Gates and conduct", and keep SPEED-1's per-page budget green: the look may not add transactions or
statements to a page. Commits carry `Packet: LOOK-1`. Record `docs/execution/packets/LOOK-1.md`, at most 80 lines.

## Report (≤ 25 lines) after each slice, then stop at the end
`LANE: BUILD · PACKET: LOOK-1 · SHA · BASE`; per slice: merge SHA, CI run, screenshots (app vs mockup), the budget table, "Test it
yourself".
