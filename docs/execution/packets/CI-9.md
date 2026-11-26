# CI-9 — PostgreSQL shard rebalance, a per-shard time budget, schema snapshots on CI, and a load-tolerant lock-timing wait

Base: origin/main at the time of the lane cut. Tier: CI infrastructure, Critical under rule 18 (CI gate). No product code changed.

CI tier: full https://github.com/AnserBeg/2rain-greenfield/actions/runs/45850267888

## Items

1. Rebalance. Six files moved between shards (package.json and `test/helpers/reachability-producers.ts` identical): `customization-inspection` 4 to 1, `presentation-list` 3 to 2 (added to shard 3's exclusion list), `customization-live` 8 to 4, `customization-governed-reads` 4 to 5, `customization-world` 5 to 8, `logical-fields` 3 to 9 (added to the exclusion list). No new shard.
2. Budget check. `test/helpers/postgres-shard-estimates.json` records an estimated CI time per file and a budget; `test/architecture/test-reachability.test.ts` fails by shard name when a shard sums past it (preflight's `reachability` step).
3. `.github/workflows/evidence.yml` in `mode=snapshots` (dispatch only, read-only token): regenerates `db/schema.snapshot.json` and the fresh-tenant replay snapshot on the pinned PostgreSQL image and uploads them. How to use it: `AGENTS.md` and `docs/execution/evidence-on-demand.md`.
4. Hygiene "shared gate holders coexist and exclude an exclusive gate": `waitForOutput` waited a fixed 5 s for the holder's `LOCK_READY`; the default is now a 60 s backstop on the same event, and the wait sits inside the `try` so a holder that is slow or never ready is still released by the `finally` (the TRAIN-S hang of 1 h 45 m was the holder left running).

## Evidence

- Full run on tip 365ad04e5, green in every job: https://github.com/AnserBeg/2rain-greenfield/actions/runs/45850267888. PostgreSQL shard job wall seconds: 1 948, 2 967, 3 629, 4 803, 5 829, 6 851, 7 1038, 8 890, 9 1188, 10 961, 11 896, 12 1080 (the TRAIN-S attempt 1 maximum was 1533 s). Shard 9 (date-time-field plus logical-fields) is only 12 s under 1200. One earlier dispatch (45849758052, tip d74e7b9a8) was cancelled: the standalone snapshot workflow could not be dispatched from a branch, so the job became a mode of evidence.yml.
- Snapshots mode dispatched on the tip: https://github.com/AnserBeg/2rain-greenfield/actions/runs/45850273838 (success; both files IDENTICAL to the committed ones; artifact `schema-snapshots-365ad04e58ec4f025b9c448470d4976ea9d2f99e` holds `db/schema.snapshot.json` and `test/postgres/fresh-tenant-full-replay-schema.snapshot.json`).

## Rule 8 reds (manifest `test/evidence/CI-9.expected-red.json`, 7 entries, each killed and restored locally)

Budget never fires; unrecorded file counts zero; real layout against a lowered budget; snapshot job regenerates with a stand-in; uploads one file; runs without the snapshots mode; pushes. The hygiene wait change has no red (a timing bound; the 5 s original was the defect).

## Rule 17

- Most general form: one estimates table and one budget for every general PostgreSQL shard; one dispatch input for every ref-based regeneration.
- Used unchanged: the shard and reachability producers, the two generators, the evidence workflow's concurrency, checkout and token rules.
- Narrower: the budget uses the median of two or three observations, so it guards a typical run, not a slow runner. Measured: runner speed varies up to about 1.7 times between runs (TRAIN-S attempt 2 ran shard 7 for 1781 s with the same files). Re-scored on a single slow run, several shards pass 1200 s whatever the layout. Only the 5 s fixed wait of `waitForKernelLockWait` is left unchanged. The 60 s default of `waitForOutput` applies to every caller without an explicit bound.

## Review focus

1. Estimates are medians over 2 to 3 runs; shard 9 (1188 s) has no margin; shards 10 and 12 are unchanged from their TRAIN-S positions and carry build-eval and workflow-record-created, whose times swing 650 to 1076 s and 432 to 720 s.
2. `select-controls` gate now requires `inputs.mode == 'controls'`; no default-mode controls dispatch was run on the tip.
3. The widened `waitForOutput` default and the moved `await` inside the try.
4. `evidence-on-demand.test.ts` pins: the input-use list now allows the mode conditions.
