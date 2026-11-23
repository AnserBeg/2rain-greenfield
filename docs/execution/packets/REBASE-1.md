# REBASE-1 — pre-tenant re-baseline of the first-party release lineage

BUILD on `packet/REBASE-1`, base `origin/main` `7c2e73bf` (includes TRAIN-J's
record). Critical tier. Authority: ADR-0066 (no tenant exists, AGENTS.md).
This record covers `7c2e73bf..HEAD` as one unit (the WIP draft `9cc53385` and
the commit that finishes it).

## Why

`apps/web/release/app.compiled.json` was a 5-entry v2 lineage of 33,126,280 B
(about 6.6 MB per entry; GitHub warns at 50 MB, refuses at 100 MB). Every
historical entry must reproduce under today's compiler (ADR-0047), so each new
projection output fights historical reproduction. ADR-0066 permits resetting
it before the first tenant.

## What changed

- `apps/web/release/app.compiled.json`: rebuilt with
  `build:app-release -- --pre-tenant-rebaseline`. One entry, v1 envelope,
  6,956,283 B (was 33,126,280 B, 5 entries).
  - The bootstrap is byte-identical to main's. The normalized definition is
    byte-identical to the old head's.
  - Every projection's semantic digest and artifact root is identical to the
    old head's except `storage-transition`, which now plans from the bootstrap
    instead of from the retired fourth entry. The release root therefore
    changes (`d3a66c78…` to `47bf8078…`), which ADR-0066 and rule 13 allow
    before the first tenant ("the root may change; a parsed chunk may not
    change without a rung" — no parsed chunk changed).
- Demo release: `apps/web/release/shell.compiled.json` has no lineage (one
  release, no `applications`), so "treated the same way" is a no-op;
  `check:demo-release` passes on it unchanged.
- Two tests and the git-workflow skill (below). No kernel, planner, runtime or
  compiler source changed.

## Critical checks

1. **Older-reader proofs (rule 13).** Every archived-binary proof
   (`test/helpers/archived-runtime-process.ts` and its users) pins a
   predecessor SHA. Almost all of them also read that SHA's own release with
   `git show <sha>:apps/web/release/app.compiled.json`
   (`readReportsPredecessor`, `request-runtime-view`), so resetting today's
   working-tree lineage cannot reach them. The ones that read today's lineage
   use only its head (`parseCompiledApplication(...).application`, or
   `applications.at(-1) ?? bootstrap`) and compile a successor after it, which
   works identically on one entry. Exactly one proof assumed a lineage
   position: STOCK-COUNTS in `request-runtime-view` searched today's lineage
   for the archived reader's head. It is adapted (below). Each named proof was
   run locally with the one-entry lineage: see "Local runs".
2. **Floors and rungs unchanged.** Compared old head and new head projection by
   projection: every `requiredRuntimeCapability` is identical
   (surface-manifest 43, query-catalog 6, agent-discovery 2, the rest 1). The
   runtime floors and rungs are code constants; no source file changed.
3. **check:app-release and check:demo-release pass.** New size 6,956,283 B.
   Re-running the documented command on the committed tree reproduces the file
   byte for byte (`git diff --exit-code apps/web/release` clean).
4. **Lineage readers at runtime and boot.** Every production reader goes
   through `parseCompiledApplication`, which maps a v1 envelope to
   `applications: [application]` (release repository, boot-check, upgrade
   replay, the composed runtime, `compile-app-release.ts`,
   `customization-service.ts` `[bootstrap, ...applications]`,
   `scripts/start-production.mjs` via the composed runtime). The test helpers
   that read raw JSON use `applications ?? [application]` or
   `applications?.at(-1) ?? application`
   (`generate-fresh-tenant-full-replay-schema.ts`, `dev-environment`,
   `governed-storage-target`, `compiled-view`, the browser specs). The one raw
   `.applications.at(-1)` left (communication-threads) is fixed. Tests that
   need history (fresh install over intermediates, profile edges, appended
   successors) construct it with `appendSameProfileSuccessor`,
   `appendCompanyColumnSuccessor`, `platformLabelVariant` or
   `nextPlatformRelease`; the compiler history claims
   (`compiler-semantic-profile` `readLineage`) run on a synthetic lineage. Those
   synthetic fixtures landed with RECEIPT (`92551696`) and assert their own
   non-vacuity (for example `applications.length >= 3` "even after a one-entry
   re-baseline", `adoptedIndex > 0`, exactly one shared-definition pair).
5. **Every changed test** — see the table.

## Changed tests

Also re-derived, not edited: the full-replay schema snapshot (see CI).

| Test | Proved before | Proves now |
| --- | --- | --- |
| `test/postgres/request-runtime-view.test.ts` "STOCK-COUNTS: the archived rung-34 reader serves the prior release and refuses the shipped count release by name" | Found the archived reader's (`7900ebd0`) head inside the checked-in lineage, served the lineage up to the entry after it, and expected the refusal literal `surface-manifest requires version 35 and this runtime supports 34`. | The checked-in lineage no longer holds that head, so the shipped release is staged as its direct successor with `nextPlatformRelease(old, today's authored package)` (same definition bytes and same projection manifests as the checked-in head). The archived reader still answers an item query on the prior release, persisted byte for byte, and still refuses the successor by name with `UNSUPPORTED_RUNTIME_CAPABILITY`. The demanded version is now read from the successor's own manifest (it names query-catalog 6 against its 4; surface-manifest is asserted above 34), so neither a later rung nor the next re-baseline re-pins a literal. Retired, with reason: the exact "rung 35" literal named the STOCK-COUNTS entry, which ADR-0066 discards. |
| `test/postgres/communication-threads.test.ts` "shared communication writer" | Read the head as `JSON.parse(file).applications.at(-1)`, which only works on a v2 lineage. | Reads `applications?.at(-1) ?? application`, the same head on either envelope. Same assertions. |

No other test pinned a count or position of the real lineage (swept with
`grep -rn applications` over `apps packages scripts test`).

## Re-baseline as a routine one-commit step

The exact commands are in `.agents/skills/git-workflow/SKILL.md`, "Pre-tenant
re-baseline (ADR-0066)":

```
corepack pnpm --filter @north-star/web build:app-release -- --pre-tenant-rebaseline
corepack pnpm check:app-release
corepack pnpm check:demo-release
corepack pnpm --filter @north-star/api dev:reset   # your dev database
```

Commit the one-entry lineage with the change that needed it, body
`Re-baseline: <reason>`. No test edit is owed. AI-UNDO-1 slice 2 can emit its
new agent-discovery key and re-baseline in the same commit. `dev:reset` is owed
by each operator on their own dev database after merge; it was not run in the
lane (the lane has no dev database).

## Rule 17

(a) The general form is "a re-baseline is a cheap, repeatable procedure", not
"shrink the file once". (b) It works unchanged for any future first-party
change before the first tenant: one command, no test edits, because history
claims run on synthetic lineages and the head is read envelope-agnostically.
(c) Left narrower: nothing in the kernel; the planner refusals and transition
machinery stay (ADR-0066). After the first-tenant ruling the permission ends.

## Local runs

Sequential, load checked (1-min load stayed under 6), on the one-entry lineage:

- typecheck, lint pass; unit 489/489; compiler 190/190; integration 342/342;
  agent 84/84 (WIP session); architecture 236/236 (this session).
- `check:app-release`, `check:demo-release` pass. The documented command
  re-run on the committed tree reproduces `apps/web/release` byte for byte.
- PostgreSQL, named archived-reader files: `request-runtime-view` 18/18
  (STOCK-COUNTS reader), `report-company-reader` 2/2 (preceding reader answers
  a query, then refuses by name), `customization-validation` 8/8 (record
  button pop-up and preceding serving readers), `billing-terms` 15/15
  (preceding declaration, publication and cycle readers), and
  `communication-threads` 20/20 (WIP session).
- Not finished locally, left to CI: `date-time-field` (its first test hit its
  30-minute timeout while still progressing, under load from other lanes; the
  orchestrator stopped whole-file local runs), `booking-serving`,
  `customization-inspection`, `document-attachments`, `customization`, and
  `composed-application`. Those tests either read archived releases with
  `git show <sha>:...` or build their own lineage from today's head.

## CI

CI tier: full https://github.com/AnserBeg/2rain-greenfield/actions/runs/45090295561

That first run, on `6f1c4180`, was red in two places, both fixed after it:

- The quality job failed in `check-record-ci-tier.mjs`, because this line was
  missing. Reachability failed only because quality did.
- In `composed-application`, "composed product activates through the
  kernel..." and "a fresh install replays a synthetic storage history..."
  failed against `test/postgres/fresh-tenant-full-replay-schema.snapshot.json`.
  That snapshot was a full replay of the old 5-entry lineage. Columns that
  history added later sat at later ordinal positions. A one-entry install
  creates them in definition order.

The snapshot was regenerated with its generator
(`node --import tsx test/helpers/generate-fresh-tenant-full-replay-schema.ts`),
not edited by hand. Compared with the old snapshot, ignoring
`ordinal_position`, every collection holds the same rows: 873 columns, 323
column privileges, 271 constraints, 248 indexes, 164 policies, 50 relations,
29 triggers and the rest. Only column order moved.

Every other shard of that run was green, including every PostgreSQL shard,
which covers `date-time-field`, `booking-serving`, `customization`,
`customization-inspection` and `document-attachments`, and every browser
runner, which covers the archived `552b13d8` reader in
`customize-inspection`.
