# INTEGRATION — the open draft PR chain combined on one branch, with an ADR-0066 re-baseline

Status: in progress on `packet/INTEGRATION` (draft PR, DO NOT MERGE). It exists for CI and evidence only; the owner decides what merges into `main`. No merge, no deployment, no production data.
Tier: outside the Critical set as a combination — every leaf carries its own review arm; this branch resolves conflicts and re-derives. A conflict hunk inside Critical code is named under Decisions and its controls run on GitHub (`run-controls`).
Base: `origin/main` at `fe97b63b`. Plan: the integration plan of 2026-10-05 (merge order, conflict groups, ADR-0066 conditions), verified as it went.

## Owner rulings

- I1 (the owner, 2026-10-05, "yes you can", answering "when I combine the pull requests into one branch for you, may I reset the stored release history?"): re-baseline the release lineage under ADR-0066 on the integration branch only. The leaves' lineages diverge after SUPPLY-WARNINGS' entry 8, so no union of them exists to append to, and the nine-entry lineage was 45.0 MB, replayed by every whole-application install. No production tenant exists (no `docs/execution/rulings/first-tenant.md`). Same class as PURCHASING-PARITY's ruling PD (`c9cb12a9`). It does not authorize a merge to `main`, a deployment or touching production data.

## Leaves

| step | leaf | PR | SHA | state |
|---|---|---|---|---|
| M1 | POSTING-FORWARD-DATE | #9 | `1de2ac20` | merged `dd601465`, clean |
| M2 | SUPPLY-WARNINGS (with #5-#8, #10, #11, #13, #16, #20, #22) | #26 | `c88f5bd2` | merged `5fd5e828`, clean |
| M3 | STOCK-COUNTS' compact `app.authored.json` | — | `3e89d9aa` | ported `011e7576`; authored file re-derived |
| R | the ADR-0066 re-baseline | — | — | `65bddb4a` |
| — | RETURNS' composed splits + 1 GB preset | — | `72beb936`, `45d0bfaf` | ported `3bcb1d25` (tests only) |
| M4 | CATALOG-EXTRAS | #24 | `58747c42` | pending |
| M5 | WAREHOUSE-MODE | #18 | `0ab2a0b6` | pending |
| M6 | VALUATION | #12 | `1b25f96e` | pending |
| M7 | APPROVALS | #14 | `78045571` | pending |
| M8 | SALES-EXTRAS | #25 | `2547c4e7` | pending |
| later | UNITS #17 `533b4628`; SPECIAL-ORDER #28 `95ec4f41` (with DROP-SHIP #19); STOCK-COUNTS #23 `550c723e`; RETURNS #15 `2603fc00`; RETURNABLE-ASSETS #27 `8a9dcad4`; SALES-PARITY round-8 fix (#7 `08142d0e`) | | | not now: mid-review or mid-build (SHAs as fetched 2026-10-05, still moving). Fold each in at its reviewed SHA with one `--no-ff` merge naming it, then the re-derive sequence below. |

## Re-derive sequence (after every merge)

1. `node --import tsx apps/web/scripts/generate-app-authored.ts` (compact JSON since M3).
2. `node --import tsx apps/web/scripts/compile-app-release.ts --pre-tenant-rebaseline` — the lineage stays one entry.
3. `check:app-release`, `check:demo-release`, `check:language-coverage` (over this run's unit, compiler, integration, contracts evidence), `check:expected-red`.
4. The inventory-contract golden, re-derived exactly as `inventory-contract.cases.ts` computes `releaseSummary(mustCompile())`.
5. Pins re-measured from the compile (below), never guessed.
6. `check:schema` — owed: it needs Docker, which the owner paused on 2026-10-05; `db/` is byte-identical to `main` through M8, so its result cannot differ from `main`'s.
7. R1: authored and normalized bytes against `maximumAuthoredBytes` / `maximumNormalizedBytes` (2,097,152 B, `packages/canonical-model/src/constants.ts`); a merge over either stops before its commit.

## Sizes (R1)

| after | authored file B | authored canonical B | normalized B | compiled B | entries |
|---|---|---|---|---|---|
| M2 | 1,998,246 | 1,301,584 | 1,355,964 | 44,967,616 | 9 |
| M3 | 1,301,585 | 1,301,584 | 1,355,964 | 44,967,616 | 9 |
| R | 1,301,585 | 1,301,584 | 1,355,964 | 5,715,247 | 1 |

## Surface floor numbering

Leaves took surface-manifest floors in parallel. Two leaves holding one number for two different features would let a reader at that floor serve a payload whose meaning it lacks, so colliding rungs take integration-only numbers from 22 up. That is safe here only because the one-entry lineage records no release carrying an old number, and no runtime outside this branch reads one.

| feature (leaf) | leaf's number | integration number |
|---|---|---|
| composition datasets scoped by a field (INVENTORY-PARITY) | 15 | 15 |
| a draft editor's create values (INVENTORY-PARITY) | 16 | 16 |
| List figures, band views, Record form references (REPLENISHMENT) | 17 | 17 |
| a launcher Task's tiles and scan box (WAREHOUSE-MODE) | 18 | 18 |
| a Record form's omitted fields, figures through a reference (LOCATIONS) | 19 | 19 |
| searches through children, figure choices, band cases (CATALOG-EXTRAS) | 20 | 20 |
| a List progress's supply (SUPPLY-WARNINGS) | 21 | 21 |

## Decisions

- M3 is a cherry-pick (`-x`) of `3e89d9aa` alone, not a merge of STOCK-COUNTS: only its generator and `.prettierignore` are taken, and `app.authored.json` is re-derived by the ported generator (same JSON value).
- R's bootstrap is re-derived from the current package (it now names the payables capability among its requirements); as in PD, the head's root moves with it while its normalized definition stays byte-identical to SUPPLY-WARNINGS' entry 8.
- No history-pinning test changes at R: PD moved every lineage-position claim to synthetic lineages, and the entries 2-8 since then added no test that reads recorded history by position.
- The full-replay snapshot is a derived artifact regenerated on GitHub (`regen-snapshot`) while Docker is paused, then committed alone; until then a merge keeps the current file rather than a textual union of two leaves' snapshots.
- The 1 GB volume is one exported preset, `LINEAGE_INSTALL_VOLUME`; every other database keeps 256 MB.
- Local suites run with `FORCE_COLOR` unset: this shell sets `FORCE_COLOR=3`, which colours assertion messages and turns `assert.throws(..., /regex/)` honesty controls red (seen once in compiler, 174/175; 175/175 without it).

## Gates

- At R (`65bddb4a`, no container): `check:app-release`, `check:demo-release` PASS; unit 218/218; compiler 175/175; integration 248/248; web contracts 40/40; language coverage PASS (2774 obligations, 921 observed, as SUPPLY-WARNINGS); expected-red 168 entries in 15 manifests OK; inventory-contract golden re-derives byte-identical.

## Owed

- `check:schema` and `dev:reset` (Docker paused): a development database built from any leaf's lineage needs `corepack pnpm --filter @north-star/api dev:reset` before it can run this release.
- The full-replay snapshot from GitHub at the integrated head.
