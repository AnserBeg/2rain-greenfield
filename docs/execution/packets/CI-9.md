# CI-9 — PostgreSQL shard rebalance, a per-shard time budget, schema snapshots on CI, and a load-tolerant lock-timing wait

Base: origin/main at the time of the lane cut. Tier: CI infrastructure, Critical under rule 18 (CI gate). No product code changed.

CI tier: pending full

## Items

1. Rebalance. Six files moved between shards (package.json and `test/helpers/reachability-producers.ts` identical): `customization-inspection` 4 to 1, `presentation-list` 3 to 2 (added to shard 3's exclusion list), `customization-live` 8 to 4, `customization-governed-reads` 4 to 5, `customization-world` 5 to 8, `logical-fields` 3 to 9 (added to the exclusion list). No new shard.
2. Budget check. `test/helpers/postgres-shard-estimates.json` records an estimated CI time per file and a budget; `test/architecture/test-reachability.test.ts` fails by shard name when a shard sums past it (preflight's `reachability` step).
3. `.github/workflows/schema-snapshots.yml`: dispatch only, read-only; regenerates `db/schema.snapshot.json` and the fresh-tenant replay snapshot on the pinned PostgreSQL image and uploads them. How to use it: `AGENTS.md` and `docs/execution/evidence-on-demand.md`.
4. Hygiene "shared gate holders coexist and exclude an exclusive gate": `waitForOutput` waited a fixed 5 s for the holder's `LOCK_READY`; the default is now a 60 s backstop on the same event, and the wait sits inside the `try` so a holder that is slow or never ready is still released by the `finally` (the TRAIN-S hang of 1 h 45 m was the holder left running).

Results, measured shard times, rule 8 reds and rule 17 answers: see `/home/rvham/2rain-missions/CI-9.result.txt`.
