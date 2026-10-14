# INTEGRATION — the open draft PR chain combined on one branch, with an ADR-0066 re-baseline

Status: M1-M8 merged and re-derived on `packet/INTEGRATION` ([draft PR #29](https://github.com/AnserBeg/2rain-greenfield/pull/29), DO NOT MERGE) with the owner's two bound raises (#30 package bytes, #31 composition bounds) folded in first; CI at the head below. The branch exists for CI and evidence only; the owner decides what merges into `main`. No merge, no deployment, no production data.
Tier: outside the Critical set as a combination — every leaf carries its own review arm; this branch resolves conflicts and re-derives. No conflict hunk fell in the posting kernel, release verification or another Critical path, so no control is owed to a hunk here.
Base: `origin/main` at `fe97b63b`. Plan: the integration plan of 2026-10-05 (merge order, conflict groups, ADR-0066 conditions), verified as it went.

## Owner rulings

- I1 (the owner, 2026-10-05, "yes you can", answering "when I combine the pull requests into one branch for you, may I reset the stored release history?"): re-baseline the release lineage under ADR-0066 on the integration branch only. The leaves' lineages diverge after SUPPLY-WARNINGS' entry 8, so no union of them exists to append to, and the nine-entry lineage was 45.0 MB, replayed by every whole-application install. No production tenant exists (no `docs/execution/rulings/first-tenant.md`). Same class as PURCHASING-PARITY's ruling PD (`c9cb12a9`). It does not authorize a merge to `main`, a deployment or touching production data.
- I2 (the owner, 2026-10-05, "raise it", answering the census table): package bytes 2 MiB -> 4 MiB (authored and normalized; ADR-0070, PR #30); composition fields 30 -> 48, actions 12 -> 24, Task steps 5 -> 12, children 8 -> 12, header facts 6 -> 8, List columns 12 -> 16 (PR #31); List saved views stays 8 (Counter sales becomes its own worklist). It does not authorize a merge to `main` or a deployment.

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
| — | STRUCTURAL-LIMITS-RAISE (bytes, ADR-0070) | #30 | `5866dcd4` | merged `b80db603`, clean |
| — | COMPOSITION-BOUNDS-RAISE (six bounds) | #31 | `a206a03e` (code `5af8b9c4`) | merged `3dac027d`, clean |
| — | the aliases journey's exact pick (test) | — | — | `c2ac1383` (CATALOG-EXTRAS files it to mirror) |
| M8 | SALES-EXTRAS | #25 | `2547c4e7` | merged ``8b863059`` (I-M8; `6cb5829a`'s resolution replayed by rerere) |
| later | UNITS #17 `533b4628`; SPECIAL-ORDER #28 `95ec4f41` (with DROP-SHIP #19); STOCK-COUNTS #23 `550c723e`; RETURNS #15 `2603fc00`; RETURNABLE-ASSETS #27 `8a9dcad4`; SALES-PARITY round-8 fix (#7 `08142d0e`) | | | not now (SHAs as fetched 2026-10-05, still moving). Fold each in at its reviewed SHA with one `--no-ff` merge naming it, then the sequence below. |

## Re-derive sequence (after every merge)

1. `generate-app-authored.ts` (compact JSON since M3); 2. `compile-app-release.ts --pre-tenant-rebaseline` (one entry); 3. `check:app-release`, `check:demo-release`, `check:language-coverage`, `check:expected-red`; 4. the inventory-contract golden and `coverage-decisions.json`, each re-derived with the code's own derivations (a golden summary exactly as `inventory-contract.cases.ts` computes it; the ledger's exported digests, with every leaf's rationale sentence kept); 5. pins re-measured from the compile; 6. R1 sizes; 7. `check:schema` (Docker is native in WSL since 2026-10-05; `db/` is byte-identical to `main` through M8).
- A conflict in a derived artifact is re-derived, never picked; the full-replay snapshot keeps the current file at a merge and is regenerated at the head — on GitHub (`regen-snapshot`), or locally under the exclusive test lock as at M8.

## Sizes (R1: 2,097,152 B through M7; 4,194,304 B for each of authored and normalized since #30)

| after | authored file B | authored canonical B | normalized B | compiled B | entries |
|---|---|---|---|---|---|
| M2 | 1,998,246 | 1,301,584 | 1,355,964 | 44,967,616 | 9 |
| M3 | 1,301,585 | 1,301,584 | 1,355,964 | 44,967,616 | 9 |
| R | 1,301,585 | 1,301,584 | 1,355,964 | 5,715,247 | 1 |
| M4 | 1,333,650 | 1,333,649 | 1,389,276 | 5,852,447 | 1 |
| M5 | 1,340,529 | 1,340,528 | 1,396,176 | 5,870,435 | 1 |
| M6 | 1,378,192 | 1,378,191 | 1,434,861 | 5,977,607 | 1 |
| M7 | 1,440,469 | 1,440,468 | 1,499,742 | 6,237,235 | 1 |
| #30, #31 | 1,440,469 | 1,440,468 | 1,499,742 | 6,237,235 | 1 |
| M8 | 1,563,797 | 1,563,796 | 1,627,095 (38.8% of 4 MiB) | 6,689,255 | 1 |

## Pins from the compile (each a sum of the leaves' measured deltas)

| pin | R | M4 | M5 | M6 | M7 | M8 |
|---|---|---|---|---|---|---|
| grouped and composed surfaces | 103 | 106 (+3 CATALOG) | 107 (+1 WAREHOUSE) | 108 (+1 VALUATION) | 113 (+5 APPROVALS) | 123 (+9 price lists, +1 Counter sales) |
| navigation leaves | 18 | 18 | 19 | 20 | 22 | 24 (Price lists, Counter sales) |
| verification scenarios / executed / derived | 584 / 507 / 77 | 601 / 524 / 77 (+17 CATALOG) | same | same | 633 / 535 / 98 (+32/+11/+21 APPROVALS) | 671 / 573 / 98 (+38 SALES-EXTRAS) |
| surface floor grouped / flat / runtime | 21 / 19 / 21 | 21 / 20 / 21 | same | same | same | 22 / 20 / 22 |
| coverage obligations / observed | 2774 / 921 | 2797 / 938 | 2805 / 945 | 2805 / 945 | 2805 / 946 | 2867 / 971 |

## Surface floor numbering

Leaves took surface-manifest floors in parallel. Two leaves holding one number for two features would let a reader at that floor serve a payload whose meaning it lacks, so colliding rungs take integration-only numbers from 22 up, highest-first in the ladder. That is safe only because the one-entry lineage records no release carrying an old number and no runtime outside this branch reads one.

| feature (leaf) | leaf's number | integration number |
|---|---|---|
| datasets scoped by a field (INVENTORY-PARITY) / create values (INVENTORY-PARITY) / List figures (REPLENISHMENT) | 15 / 16 / 17 | 15 / 16 / 17 |
| launcher Task (WAREHOUSE-MODE) / omitted form fields (LOCATIONS) / searched children (CATALOG-EXTRAS) / supply (SUPPLY-WARNINGS) | 18 / 19 / 20 / 21 | 18 / 19 / 20 / 21 |
| ranked defaults and chained Tasks (SALES-EXTRAS) | 15 | 22 (on the branch since M8) |
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
- PostgreSQL commercial workflows ran 15 tests in 1,130 s (19m08s of 30, run 37395705040); SALES-EXTRAS adds three files of 84-98 s each (run 37312203740), about 24-25 minutes at the union, so its sales-side files (10 tests) run in `postgres-sales` (`ddc3a925`), commercial keeps the purchasing side and the shared totals (8 tests), each under the same 30-minute bound.
- M8 union fix in the web runtime (`component-registry.ts`): APPROVALS hid a bare capability command whenever a Task steps through its operation with the record's id; the counter sale's Tasks step through Confirm, so the order page lost its ordinary Confirm (the ORDER-PARITY next-step integration test went red). Only a one-step Task owns its operation now — every APPROVALS case is one step (Place order, Approve, Reject, Submit, Void); a Task chaining it with other work does not. Owed to the APPROVALS and SALES-EXTRAS lanes as a union note, not a leaf defect.
- Local suites run with `FORCE_COLOR` unset: this shell sets `FORCE_COLOR=3`, which turns `assert.throws(..., /regex/)` honesty controls red.
- I-M8 (resolved by I2): M8 had stopped at two schema bounds — the Sales orders List at 9 saved views (max 8) and the sales order page at 34 composition fields (max 30). Fields: 34 of the raised 48, the counter sale's 11-step Task under the raised 12; every fact stays on the order page. Views, option (a): Counter sales is a worklist of its own, `counter_sale_list` in `WORKLISTS` (`list-declarations.ts`), cut from Sales orders over its own clone of that List's query, as Expected receipts is: the Sales orders List's columns, figures and row actions, one view "All" of the orders whose counter flag is set, listed under Sales; Sales orders keeps its eight views and SALES-EXTRAS' `flagView` is gone. Users see the same rows, now at Sales → Counter sales: `counter-sale.test.ts` counts and lists the three counter orders there and not an ordinary order beside them; `receivables-counter-sale.spec.ts` opens it from the navigation; the three Sales orders count tests drop the tab; `surface-list.test.ts` pins the worklist. +1 surface, +1 navigation leaf, no verification scenario (a List over an existing entity adds none). Filed in SALES-EXTRAS' record for that lane to mirror (floor 22, the worklist); VALUATION's cost facts stay as merged.
- In M8 (from `89e56a78`), beyond unions: price-list entities move to orderKeys 40-60 (CATALOG-EXTRAS' alias holds 30); SALES-EXTRAS' `enumField` becomes `requiredEnumField` beside CATALOG-EXTRAS'; the flat grammar arm keeps Location (REPLENISHMENT's item form needs it) and leaves the price lists out — whole entities with their fields, relations, operations, permissions, queries, storage, assertions and nine surfaces, since dropping only the surfaces failed conformance (`COMPILER_ENTITY_PROJECTION_MISSING`); the floor checks read 22 and 21; the steps bound keeps #31's 12 with SALES-EXTRAS' comment; #31's bound test and SALES-EXTRAS' twelve-step test both stay.
- The aliases journey's `pick` (CATALOG-EXTRAS) took the first option CONTAINING the name; the results on focus, ordered by random ids, can list "Field notebook (duplicate)" first, and a click on an older answer's result that the typed term's answer does not offer is dropped by design (`surface-client.ts`). `c2ac1383` matches the option's `<strong>` label exactly (anchored, escaped regex); no assertion changed. Filed in CATALOG-EXTRAS' record with `8946190a`.

## Gates

- Local, every merge (no container): app/demo release checks; unit, compiler, integration, web contracts, agent, architecture without its three Docker-backed files, lint, format, typecheck, coverage, expected-red (168 entries in 15 manifests). At M7: unit 247/247, compiler 175/175, integration 257/257, contracts 46/46, agent 3/3, architecture 150/150. At #30: unit 248, compiler 176 (+1 each); at #31: unit 249. At M8 (`8b863059`): unit 255/255, compiler 176/176, integration 259/259, contracts 46/46, agent 3/3, coverage 2867 obligations / 971 observed PASS, expected-red OK; grammar 25/25, hygiene 11/11, reachability and CI contracts 36/36; architecture 200/200 with its Docker-backed files (`e7173d92`, Docker native in WSL); `counter-sale.test.ts` on PostgreSQL 1/1 (194 s locally).
- CI at R (run 37348030612): quality, browsers, scans, commercial green; composed failed only its two full-replay snapshot comparisons (the stale snapshot); schema failed the two calendar conflicts; perf `COMPILE_BUDGET_INDETERMINATE` (CPU idle 86.8%). Snapshot at R (evidence run 37348046646) equals the 9-entry one except the ordinal positions of 15 columns in two tables.
- CI at `7ef4ba0d` (run 37358401689): everything green but composed's two snapshot comparisons; schema 19m51s, commercial 13m34s, composed 17m6s of 30; browser 12m17s, operations 12m34s, composed browser 6m55s of 20.
- CI at `667b360e` (run 37363200821): composed 13 tests, 11 pass, the two snapshot comparisons fail; five jobs and the snapshot job were cancelled at 15 minutes without ever getting a runner (GitHub queue). The snapshot job re-run (37363200981) produced the snapshot committed in `1b271d1c`; at `1b271d1c` it is IDENTICAL (37366491602).
- CI at `1b271d1c` (run 37366491594): quality 11m53s of 15; schema 25m56s of 30 (tests 25m22s, the closest to its bound); browser 10m20s, composed browser 7m58s of 20; scans, observability green. Operations browser: 20/20 specs passed in 19.5 minutes but the job ran 20m40s and was cancelled at its 20-minute bound, so `41ad6b24` moves the inventory specs to `browser-inventory` (same bound). Perf, commercial and composed got no runner (cancelled at 15 minutes).
- CI at `b2f6ff87` (run 37370318617, attempt 2 after attempt 1 lost five runners): every job green except `browser-inventory`, where CATALOG-EXTRAS' aliases journey picked a line while the vendor's defaults re-rendered the editor (both attempts); `8946190a` waits for them, as the replenishment journey does. Schema 26m43s of 30.
- CI at `8946190a` ([run 37392181673](https://github.com/AnserBeg/2rain-greenfield/actions/runs/37392181673)): **all 12 jobs green**, reachability included. Quality 12m00s, scans 8m55s, perf 26s, reachability 15s of 15; schema 242/242 in 21m28s, composed 24/24 in 15m23s (longest test 146 s of its 300 s), commercial 21/21 in 18m47s of 30; browser 10m06s, operations 9m50s, inventory 10m18s, composed browser 7m04s of 20. Schema was the job nearest its bound (21-27 minutes of 30 across runs), hence `defcb0bb`.
- CI at `8869f00a` ([run 37395705040](https://github.com/AnserBeg/2rain-greenfield/actions/runs/37395705040)): **all 13 jobs green** with the PostgreSQL split. Schema and isolation 159/159 in 13m12s, inventory 83/83 in 10m40s (159 + 83 = the 242 before), commercial 21/21 in 19m08s, composed 24/24 in 18m34s, all of 30; quality 7m23s, scans 8m48s, perf 24s, reachability 18s of 15; browser 13m15s, operations 10m29s, inventory 9m46s, composed browser 7m59s of 20.

## Owed

- `dev:reset`: a development database built from any leaf's lineage needs `corepack pnpm --filter @north-star/api dev:reset` before it can run this release. `check:schema` passed at `e7173d92` (28 migrations applied and verified, no drift), and the full-replay snapshot was regenerated locally (`e7173d92`: the ordinal positions of 9 columns in 3 tables, nothing else).
- A combined item page (I-V1, queued as its own packet); then M9 onward (UNITS, SPECIAL-ORDER with DROP-SHIP, STOCK-COUNTS, RETURNS, RETURNABLE-ASSETS, the SALES-PARITY fix, and #32-#34 against this branch) at their reviewed SHAs.
- The lanes' mirrors, each filed in its record: CATALOG-EXTRAS (the aliases journey's wait and exact pick), SALES-EXTRAS (floor 22, Counter sales as a worklist), APPROVALS (the one-step Task rule).
