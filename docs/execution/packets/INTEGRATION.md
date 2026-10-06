# INTEGRATION — the open draft PR chain combined on one branch, with an ADR-0066 re-baseline

Status: M1-M7 merged and re-derived on `packet/INTEGRATION` ([draft PR #29](https://github.com/AnserBeg/2rain-greenfield/pull/29), DO NOT MERGE), full CI green at `8946190a`; M8 (SALES-EXTRAS) blocked by two canonical schema bounds (stop, below). The branch exists for CI and evidence only; the owner decides what merges into `main`. No merge, no deployment, no production data.
Tier: outside the Critical set as a combination — every leaf carries its own review arm; this branch resolves conflicts and re-derives. No conflict hunk fell in the posting kernel, release verification or another Critical path, so no control is owed to a hunk here.
Base: `origin/main` at `fe97b63b`. Plan: the integration plan of 2026-10-05 (merge order, conflict groups, ADR-0066 conditions), verified as it went.

## Owner rulings

- I1 (the owner, 2026-10-05, "yes you can", answering "when I combine the pull requests into one branch for you, may I reset the stored release history?"): re-baseline the release lineage under ADR-0066 on the integration branch only. The leaves' lineages diverge after SUPPLY-WARNINGS' entry 8, so no union of them exists to append to, and the nine-entry lineage was 45.0 MB, replayed by every whole-application install. No production tenant exists (no `docs/execution/rulings/first-tenant.md`). Same class as PURCHASING-PARITY's ruling PD (`c9cb12a9`). It does not authorize a merge to `main`, a deployment or touching production data.

## Leaves

| step | leaf | PR | SHA | state |
|---|---|---|---|---|
| M1 | POSTING-FORWARD-DATE | #9 | `1de2ac20` | merged `dd601465`, clean |
| M2 | SUPPLY-WARNINGS (with #5-#8, #10, #11, #13, #16, #20, #22) | #26 | `c88f5bd2` | merged `5fd5e828`, clean |
| M3 | STOCK-COUNTS' compact `app.authored.json` | — | `3e89d9aa` | ported `011e7576` |
| R | the ADR-0066 re-baseline | — | — | `65bddb4a` |
| — | RETURNS' composed splits + 1 GB preset | #15 | `72beb936`, `45d0bfaf` | ported `3bcb1d25` (tests only) |
| M4 | CATALOG-EXTRAS | #24 | `58747c42` | merged `cb2ce225` |
| M5 | WAREHOUSE-MODE | #18 | `0ab2a0b6` | merged `b4fced9a`; calendar fix `7ef4ba0d` |
| M6 | VALUATION | #12 | `1b25f96e` | merged `22c689b0` (decision I-V1) |
| M7 | APPROVALS | #14 | `78045571` | merged `667b360e` |
| M8 | SALES-EXTRAS | #25 | `2547c4e7` | BLOCKED (I-M8); resolution replayed on `7d20e905` at local `wip/integration-m8-sales-extras-2` `6cb5829a` (supersedes `89e56a78`) |
| later | UNITS #17 `533b4628`; SPECIAL-ORDER #28 `95ec4f41` (with DROP-SHIP #19); STOCK-COUNTS #23 `550c723e`; RETURNS #15 `2603fc00`; RETURNABLE-ASSETS #27 `8a9dcad4`; SALES-PARITY round-8 fix (#7 `08142d0e`) | | | not now (SHAs as fetched 2026-10-05, still moving). Fold each in at its reviewed SHA with one `--no-ff` merge naming it, then the sequence below. |

## Re-derive sequence (after every merge)

1. `generate-app-authored.ts` (compact JSON since M3); 2. `compile-app-release.ts --pre-tenant-rebaseline` (one entry); 3. `check:app-release`, `check:demo-release`, `check:language-coverage`, `check:expected-red`; 4. the inventory-contract golden and `coverage-decisions.json`, each re-derived with the code's own derivations (a golden summary exactly as `inventory-contract.cases.ts` computes it; the ledger's exported digests, with every leaf's rationale sentence kept); 5. pins re-measured from the compile; 6. R1 sizes; 7. `check:schema` — owed while Docker is paused; `db/` is byte-identical to `main` through M7.
- A conflict in a derived artifact is re-derived, never picked; the full-replay snapshot keeps the current file at a merge and is regenerated on GitHub (`regen-snapshot`) at the head.

## Sizes (R1: 2,097,152 B for each of authored and normalized)

| after | authored file B | authored canonical B | normalized B | compiled B | entries |
|---|---|---|---|---|---|
| M2 | 1,998,246 | 1,301,584 | 1,355,964 | 44,967,616 | 9 |
| M3 | 1,301,585 | 1,301,584 | 1,355,964 | 44,967,616 | 9 |
| R | 1,301,585 | 1,301,584 | 1,355,964 | 5,715,247 | 1 |
| M4 | 1,333,650 | 1,333,649 | 1,389,276 | 5,852,447 | 1 |
| M5 | 1,340,529 | 1,340,528 | 1,396,176 | 5,870,435 | 1 |
| M6 | 1,378,192 | 1,378,191 | 1,434,861 | 5,977,607 | 1 |
| M7 | 1,440,469 | 1,440,468 | 1,499,742 | 6,237,235 | 1 |
| M8 (blocked) | 1,548,116 | 1,548,115 | 1,610,354 with the two over-bound arrays trimmed in memory only | — | — |

## Pins from the compile (each a sum of the leaves' measured deltas)

| pin | R | M4 | M5 | M6 | M7 |
|---|---|---|---|---|---|
| grouped and composed surfaces | 103 | 106 (+3 CATALOG) | 107 (+1 WAREHOUSE) | 108 (+1 VALUATION) | 113 (+5 APPROVALS) |
| navigation leaves | 18 | 18 | 19 | 20 | 22 |
| verification scenarios / executed / derived | 584 / 507 / 77 | 601 / 524 / 77 (+17 CATALOG) | same | same | 633 / 535 / 98 (+32/+11/+21 APPROVALS) |
| surface floor grouped / flat / runtime | 21 / 19 / 21 | 21 / 20 / 21 | same | same | same |
| coverage obligations / observed | 2774 / 921 | 2797 / 938 | 2805 / 945 | 2805 / 945 | 2805 / 946 |

## Surface floor numbering

Leaves took surface-manifest floors in parallel. Two leaves holding one number for two features would let a reader at that floor serve a payload whose meaning it lacks, so colliding rungs take integration-only numbers from 22 up, highest-first in the ladder. That is safe only because the one-entry lineage records no release carrying an old number and no runtime outside this branch reads one.

| feature (leaf) | leaf's number | integration number |
|---|---|---|
| datasets scoped by a field (INVENTORY-PARITY) / create values (INVENTORY-PARITY) / List figures (REPLENISHMENT) | 15 / 16 / 17 | 15 / 16 / 17 |
| launcher Task (WAREHOUSE-MODE) / omitted form fields (LOCATIONS) / searched children (CATALOG-EXTRAS) / supply (SUPPLY-WARNINGS) | 18 / 19 / 20 / 21 | 18 / 19 / 20 / 21 |
| ranked defaults and chained Tasks (SALES-EXTRAS) | 15 | 22 (prepared in `89e56a78`; not on the branch) |
| DROP-SHIP, SPECIAL-ORDER, STOCK-COUNTS | 15, 16, 17 | 23, 24, 25 planned; measure at fold-in |

## Decisions

- M3 cherry-picks `3e89d9aa` alone (`-x`); `app.authored.json` is re-derived by the ported generator (same JSON value).
- R's bootstrap is re-derived from the current package (it names the payables capability); as in PD the head's root moves while its normalized definition stays byte-identical to SUPPLY-WARNINGS' entry 8. No history-pinning test changed: PD made every lineage-position claim synthetic.
- The 1 GB volume is one preset, `LINEAGE_INSTALL_VOLUME` (cites `28461658`); every other database keeps 256 MB. APPROVALS split the rollback-edge test as RETURNS did; RETURNS' copy (ported first, on the preset) is kept, not both.
- POSTING-FORWARD-DATE moved the composed tenant's calendar to America/Edmonton; three tests from the leaves (item stock, replenishment, catalog extras) provisioned a second company at UTC and got `INVENTORY_TENANT_CALENDAR_CONFLICT` on CI. `7ef4ba0d` passes them the tenant's calendar, as #9 did for its own test. Test-only.
- I-V1: INVENTORY-PARITY's stock page stays the item page (item get, Posted stock entry), because REPLENISHMENT, LOCATIONS, CATALOG-EXTRAS and WAREHOUSE-MODE build on it. VALUATION's item-page composition, its `inventory_value_get` data source and entry are not taken; its figures stay on the Inventory value List; its contract test and browser spec say so. A combined item page is owed to the owner and the VALUATION lane.
- APPROVALS made `CompositionData.offeredActionIds` required; INVENTORY-PARITY's field-scoped section test supplies it.
- Coverage rationales carry every leaf's sentence plus one INTEGRATION sentence (M4 and M5 first dropped CATALOG-EXTRAS' and WAREHOUSE-MODE's; restored at M7).
- CATALOG-EXTRAS' aliases journey now waits for the vendor's defaults before picking a line (`8946190a`, one assertion added; owed upstream to that lane).
- The operations browser job passed its 20-minute bound at the union; its inventory and item stock specs run in a fourth browser job, `browser-inventory`, under the same bound (`41ad6b24`, after the SALES-PARITY split `3c07a451`). No timeout moves.
- PostgreSQL schema and isolation ran 21-27 of its 30 minutes; its fifteen inventory files (about 640 s of 1,240 s test time in run 37392181673) run in `postgres-inventory` (`defcb0bb`, after the commercial split `db519249`), under the same bound.
- Local suites run with `FORCE_COLOR` unset: this shell sets `FORCE_COLOR=3`, which turns `assert.throws(..., /regex/)` honesty controls red.
- I-M8 (M8 stop, AGENTS.md STOP list (a)): every conflict resolves, and with the two over-bound arrays trimmed in memory the union normalizes and compiles (6,635,311 B, one entry), so these two bounds are all that block it. (a) Counter sales as a List of its own is in-language: a worklist over a clone of the Sales orders query (`WORKLISTS`, `list-declarations.ts:1410`, as Expected receipts is), which leaves Sales orders at 8 views (`schemas.ts:1844`, max 8). (b) is not: `SurfaceCompositionSchema.fields` is max 30 (`packages/canonical-model/src/schemas.ts:1090`) and the sales order page needs 34 (24 + SALES-EXTRAS' 5 credit facts and counter flag + VALUATION's 4 cost facts). Header facts (max 6), blocks (3 x 8), print totals, alerts and progression all name `fields` columns, so they add no room; a child dataset (`schemas.ts:926`, max 8) lists rows of an entity that points at the record (`parent`) or holds its id in a text field (`fieldScope`), checked in `surface-composition.ts:483-541`, and no entity carries one order's cost total or its customer's credit. No related-panel region exists. Options: (1) raise `fields` to 40, one line plus an owner ruling, additive (every package valid today stays valid), every fact stays on the page; (2) keep credit status on the order page and leave limit, open balance, on order and available credit to the customer page, where SALES-EXTRAS already shows them (34 - 4 = 30), with no language change but a product change; (3) move cost and margin to a linked "Cost and margin" record page of the order (+1 surface, +1 navigate action; VALUATION's contract test and browser spec move), with no language change but a product change. Recommended: (a) plus (1). (a) is not built yet because (b) blocks M8 either way. Lanes to mirror later: SALES-EXTRAS (Counter sales as a worklist; the credit facts per the ruling), VALUATION (the cost facts per the ruling).
- In `89e56a78`, beyond unions: price-list entities move to orderKeys 40-60 (CATALOG-EXTRAS' alias holds 30); SALES-EXTRAS' `enumField` becomes `requiredEnumField` beside CATALOG-EXTRAS'; the flat grammar arm keeps Location (REPLENISHMENT's item form needs it) and leaves the nine price-list surfaces out; the floor checks read 22 and 21.

## Gates

- Local, every merge (no container): app/demo release checks; unit, compiler, integration, web contracts, agent, architecture without its three Docker-backed files, lint, format, typecheck, coverage, expected-red (168 entries in 15 manifests). At M7: unit 247/247, compiler 175/175, integration 257/257, contracts 46/46, agent 3/3, architecture 150/150.
- CI at R (run 37348030612): quality, browsers, scans, commercial green; composed failed only its two full-replay snapshot comparisons (the stale snapshot); schema failed the two calendar conflicts; perf `COMPILE_BUDGET_INDETERMINATE` (CPU idle 86.8%). Snapshot at R (evidence run 37348046646) equals the 9-entry one except the ordinal positions of 15 columns in two tables.
- CI at `7ef4ba0d` (run 37358401689): everything green but composed's two snapshot comparisons; schema 19m51s, commercial 13m34s, composed 17m6s of 30; browser 12m17s, operations 12m34s, composed browser 6m55s of 20.
- CI at `667b360e` (run 37363200821): composed 13 tests, 11 pass, the two snapshot comparisons fail; five jobs and the snapshot job were cancelled at 15 minutes without ever getting a runner (GitHub queue). The snapshot job re-run (37363200981) produced the snapshot committed in `1b271d1c`; at `1b271d1c` it is IDENTICAL (37366491602).
- CI at `1b271d1c` (run 37366491594): quality 11m53s of 15; schema 25m56s of 30 (tests 25m22s, the closest to its bound); browser 10m20s, composed browser 7m58s of 20; scans, observability green. Operations browser: 20/20 specs passed in 19.5 minutes but the job ran 20m40s and was cancelled at its 20-minute bound, so `41ad6b24` moves the inventory specs to `browser-inventory` (same bound). Perf, commercial and composed got no runner (cancelled at 15 minutes).
- CI at `b2f6ff87` (run 37370318617, attempt 2 after attempt 1 lost five runners): every job green except `browser-inventory`, where CATALOG-EXTRAS' aliases journey picked a line while the vendor's defaults re-rendered the editor (both attempts); `8946190a` waits for them, as the replenishment journey does. Schema 26m43s of 30.
- CI at `8946190a` ([run 37392181673](https://github.com/AnserBeg/2rain-greenfield/actions/runs/37392181673)): **all 12 jobs green**, reachability included. Quality 12m00s, scans 8m55s, perf 26s, reachability 15s of 15; schema 242/242 in 21m28s, composed 24/24 in 15m23s (longest test 146 s of its 300 s), commercial 21/21 in 18m47s of 30; browser 10m06s, operations 9m50s, inventory 10m18s, composed browser 7m04s of 20. Schema was the job nearest its bound (21-27 minutes of 30 across runs), hence `defcb0bb`.

## Owed

- `check:schema` and `dev:reset` (Docker paused): a development database built from any leaf's lineage needs `corepack pnpm --filter @north-star/api dev:reset` before it can run this release.
- The owner's call on I-M8 (recommended: Counter sales as a worklist plus composition `fields` 30 -> 40); a combined item page (I-V1, queued as its own packet); then M9 onward.
