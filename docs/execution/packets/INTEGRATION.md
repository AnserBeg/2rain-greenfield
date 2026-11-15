# INTEGRATION — the combined parity branch lands as `main`'s trunk (week 1 of the six-week test)

Status: **evidence_ready — arm owed.** M1-M8 merged and re-derived on `packet/INTEGRATION` ([PR #29](https://github.com/AnserBeg/2rain-greenfield/pull/29)), current with `origin/main` (merged 2026-11-14) and carrying the SALES-PARITY round-8 verification fix. The orchestrator `--no-ff` merges it into `main` after the Critical arm returns; this lane does not merge, push `main` or deploy. No production data.
Tier: **Critical-touching.** Against base `fe97b63b` three Critical paths differ: `inventory-posting-service.ts` (POSTING-FORWARD-DATE), `module-storage-materializer.ts` (RELATION-INSTALL, SALES-PARITY grants) and `release-verification-service.ts` (SALES-PARITY). The earlier text here, "no conflict hunk fell in a Critical path", spoke of conflicts only; the leaves' own diffs are in those paths, so the one arm is owed. No migration, `db/**`, RLS policy, trust-substrate, stock-serializer or release-activation file differs from `main`.
Base: `origin/main` `02217a67` (the merge parent; `fe97b63b` was the original base, and `main` has since changed only README, the DEP-AUDIT pin and records). Plan: the integration plan of 2026-10-05 (merge order, conflict groups, ADR-0066 conditions), verified as it went.

## Owner rulings

- I1 (the owner, 2026-10-05, "yes you can", answering "when I combine the pull requests into one branch for you, may I reset the stored release history?"): re-baseline the release lineage under ADR-0066. No production tenant exists (no `docs/execution/rulings/first-tenant.md`). Same class as PURCHASING-PARITY's ruling PD (`c9cb12a9`). R1 made it stand on `main`.
- I2 (the owner, 2026-10-05, "raise it"): package bytes 2 MiB -> 4 MiB (ADR-0070, PR #30); composition fields 30 -> 48, actions 12 -> 24, Task steps 5 -> 12, children 8 -> 12, header facts 6 -> 8, List columns 12 -> 16 (PR #31); List saved views stays 8.
- **R1 (the owner, 2026-11-14): "Yes, write week 1".** INTEGRATION becomes `main`'s trunk. Supersedes PR #29's "do not merge". Ruling I1's ADR-0066 re-baseline ("integration branch only") now stands on `main`; pre-tenant mode holds; a dev DB built from an older lineage runs `dev:reset`.
- **R2 (the owner, 2026-11-14): feature freeze until the week-6 decision.** No new distributor features, no nav relabeling, and the parked set is NOT folded in: UNITS, SPECIAL-ORDER+DROP-SHIP, STOCK-COUNTS, RETURNS, RETURNABLE-ASSETS, LOCATIONS-2, PRs #32-#34, the item page I-V1.

## Claims (Critical paths only; the arm tests these)

1. POSTING-FORWARD-DATE: no posting family commits an effective tenant business day after the recorded one; stored and natural replays return first; backdating stays bounded by the entity's window (`inventory-posting-service.ts`, `enforceForwardDate`; kernel note, 2026-09-30 amendment). The file is byte-identical to `aeef2b65`, where an owner-run round 1 found no production defect.
2. RELATION-INSTALL: `locateColumn` in `module-storage-materializer.ts` resolves a column element whose subject is a relation's own column (origin not `field`) by relation id and physical name, uniquely, and installs it nullable with no default. No verdict exists for this hunk.
3. SALES-PARITY 10-11: a column a later release adds to a company-scoped table (not fact, not period-lock) gets the creation-time column UPDATE grant when entity-owned mutable (`addColumn`); replaying a table's creation by another tenant revokes UPDATE only when a table-level grant exists, so later column grants survive (`createManagedTable`). Round 1 (`974ae755`) found no defect.
4. SALES-PARITY 9, 20, 21 (`release-verification-service.ts`): sentinel document numbers never read as or collide with a business number; verification reads only through gets and searches its gateway executes, and arranges records so cleanup and probes cannot leave one live; an assigned number is counted as written by the create. Claim text: `SALES-PARITY.md` claims 9, 20, 21.
5. The verifier equals `packet/SALES-PARITY` `9967abe5` (`git diff` empty). Its rounds 1-8 are recorded in that packet's record, not in `review-log.md` (no SALES-PARITY row there). Round 8 (`7d254902`) found two production defects, fixed at `fe864f66`; the kernel evaluation `43b0b473` landed after it; **round 9, the confirm, was owed and has no recorded verdict**.

## Leaves

| step | leaf | PR | SHA | state |
|---|---|---|---|---|
| M1 | POSTING-FORWARD-DATE | #9 | `1de2ac20` | merged `dd601465` |
| M2 | SUPPLY-WARNINGS (with #5-#8, #10, #11, #13, #16, #20, #22) | #26 | `c88f5bd2` | merged `5fd5e828` |
| M3 | STOCK-COUNTS' compact `app.authored.json` | — | `3e89d9aa` | ported `011e7576` |
| R | the ADR-0066 re-baseline | — | — | `65bddb4a` |
| M4-M7 | CATALOG-EXTRAS #24 `58747c42`; WAREHOUSE-MODE #18 `0ab2a0b6`; VALUATION #12 `1b25f96e` (I-V1); APPROVALS #14 `78045571` | | | merged `cb2ce225`, `b4fced9a`, `22c689b0`, `667b360e` |
| — | STRUCTURAL-LIMITS-RAISE #30 `5866dcd4`; COMPOSITION-BOUNDS-RAISE #31 `a206a03e` | | | merged `b80db603`, `3dac027d` |
| M8 | SALES-EXTRAS | #25 | `2547c4e7` | merged `8b863059` (I-M8) |
| T1 | `origin/main` (README, DEP-AUDIT, README-PRODUCT; #36-#38) | | `02217a67` | merged `d5d86090` |
| T2 | SALES-PARITY round-8 fix | #7 | `9967abe5` | merged `e7d48106` |

Parked by R2, not folded in: UNITS #17, SPECIAL-ORDER #28 (with DROP-SHIP #19), STOCK-COUNTS #23, RETURNS #15, RETURNABLE-ASSETS #27, LOCATIONS-2, #32-#34, the combined item page (I-V1).

## Re-derive sequence (after a merge that moves the package)

`generate-app-authored.ts`; `compile-app-release.ts --pre-tenant-rebaseline` (one entry); `check:app-release`, `check:demo-release`, `check:language-coverage`, `check:expected-red`; the inventory-contract golden and `coverage-decisions.json` with the code's own derivations; pins re-measured; `check:schema`. A derived-artifact conflict is re-derived, never picked. T1 and T2 moved no input of the package: the authored and compiled files are unchanged and `check:app-release` passes.

## Sizes and pins (measured; unchanged by T1 and T2)

Authored file 1,563,797 B (normalized 1,627,095 = 38.8% of 4 MiB); compiled 6,689,255 B; 1 lineage entry. 123 grouped and composed surfaces; 24 navigation leaves; 671 verification scenarios (573 executed, 98 derived); surface floor 22 / 20 / 22; 2,867 coverage obligations, 971 observed; 169 expected-red entries in 15 manifests. The SALES-PARITY fix moved none of these (the composed test's 671 / 573 pins pass). Floor 22 is ranked defaults and chained Tasks; 23-25 (DROP-SHIP, SPECIAL-ORDER, STOCK-COUNTS) are parked.

## Decisions (one line each)

- T1: `pnpm-workspace.yaml` and `pnpm-lock.yaml` are main's, the lockfile re-derived with `install --lockfile-only` (identical to main's; `--frozen-lockfile` passes). `ledger.md` and `review-log.md` auto-merged (three rows each).
- T2: merged `packet/SALES-PARITY` whole, not cherry-picked: the verifier then equals its tip, so the arm can treat rounds 1-8 as prior claims. Only `lanes.md` conflicted; both rows kept.
- The merge-tip CI (run 43684418232) failed only the dependency audit: zod `<4.6.6` (GHSA-mrhx-c7xc-m3w5, high) was newly published. Pre-authorized exact-pin bump `e0de6c87`: zod 4.1.12 -> 4.6.6, declared and overridden, advisory in a comment; the suites were re-run.
- Tier corrected above; claims written here because the arm reads numbered claims. No review-log row: the orchestrator writes it after the verdict.
- Test it yourself ran on a fresh dev container name (`dev-trunk-check`), so no retained database was touched; stopped with SIGINT to the node pid. The exited container and its volume remain (retained, not deleted).
- README figures re-measured on the merged tree with the method that reproduces main's own (authored-package array lengths, `git ls-files` lines, CI per-job totals, `test/evidence` entries), each dated.
- Earlier decisions (M3-M8, I-V1, the CI splits `browser-inventory`, `postgres-inventory`, `postgres-sales`, the one-step Task rule, the calendar fix, price-list orderKeys, the exact-pick aliases journey, the 1 GB lineage volume) stand as in this file's `git log`; each is test or CI plumbing, none in a Critical path.

## Gates

- Local at `e7d48106`: format, typecheck, lint, `check:app-release`, `check:demo-release`, `check:language-coverage` (2,867 obligations PASS), `check:schema` (28 applied, 28 verified), `check:expected-red` (169), unit 255, compiler 176, integration 259, agent 3, contracts 46, architecture 200 (Docker-backed files included). The same set is re-run after `e0de6c87`; the report states the result.
- CI at `e7d48106` ([run 43684418232](https://github.com/AnserBeg/2rain-greenfield/actions/runs/43684418232), 2026-11-15): 13 of 14 jobs green; Dependency and secret scans red on the zod advisory only (gitleaks clean). Totals: unit 255, compiler 176, integration 259, agent 3, architecture 200, contracts 46; PostgreSQL schema 163 + locale 1, inventory 83, commercial 14, sales 10, composed 24; browser 87, operations 12, inventory 11, composed 23; observability 11; performance 6.
- CI at the frozen SHA and the final tip: in the report. Nothing here is evidence for them.

## Test it yourself (observed 2026-11-15 on fixture `dev-trunk-check`; about ten minutes by hand)

`NORTH_STAR_DEV_DATABASE_CONTAINER=dev-trunk-check corepack pnpm dev`, open <http://127.0.0.1:4174>, Ctrl-C to stop. Observed: PO-000001 for Field notebook, 10 EA at 5.00 from Cascade Fastener Works: Place order -> Released; Receive lines -> RCV-000001, received 10, open 0; Stock by item on hand 10, available 10. SO-000001 (5 EA at 12.50, Lethbridge Millwork): Confirm; Reserve 4; Ship 4 -> SHP-000001; Stock by item on hand 6, available 6, open demand 1; the order shows shipped 4, open to ship 1. Invoice shipped quantities -> INV-000001, 52.50; Record payment 52.50 -> Paid, balance 0.00. Bill received quantities -> BILL-000001, 50.00; Record payment 50.00 -> Paid. Inventory value: Field notebook on hand 6, average cost CAD 5, known value CAD 30.00. Navigation lists 24 leaves, none ending "line list". The purchase order page shows its priced lines and receipts inside it.

## Owed and filed

- Owed: the Critical arm (prompt below); the orchestrator's `--no-ff` merge, `review-log.md` row and ledger update after it; `dev:reset` for any dev DB from an older lineage; the parked set after the week-6 decision.
- Filed, not fixed (frozen by R2): the navigation labels "Party list" and "Price list list"; grouping the navigation by module; the Receiving step reads "Needs attention" after a full receipt not yet billed; the editor refuses Save until a picked field finishes updating (a status line says so).
- Mirrors still owed to the leaf lanes: CATALOG-EXTRAS (aliases journey), SALES-EXTRAS (floor 22, Counter sales), APPROVALS (one-step Task rule), VALUATION and the item page (I-V1).

## Review prompt

Written after the freeze, below.
