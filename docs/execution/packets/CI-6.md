# CI-6 — PostgreSQL shard 10 and a lighter catch-all shard

Tested tip `ad7946032ae1ebd567bb9b259fc40784183e765b` on base `5710c05ae2529b742bf15f8f484c75c0b3930180`. Tier: CI infrastructure, not Critical. No product code, migration or test body changed. CI-5 has no packet record, so this one follows CI-4 and CI-5's commit `6545ae7f8`.

CI tier: full https://github.com/AnserBeg/2rain-greenfield/actions/runs/44991394141

## Claims

1. PostgreSQL shard 3 runs every file that no other shard names. It now also excludes `build-eval`, `booking-serving` and `boot-capabilities`. On main run 44982854424 these three took 13m 09s of shard 3's 22m 51s.
2. A new shard 10 runs `build-eval`, `agent-dev-tasks` and `address-authority`. Shard 2 adds `booking-serving`. Shard 4 adds `boot-capabilities` and `request-runtime-view`. Shard 9 adds `declared-list`. Shards 6, 7 and 8 each give up the files listed above. Shards 1 and 5 are unchanged.
3. `document-templates` stays in shard 3. Shard 3 is the only shard that builds `dist`, and the production-launcher subtest skips when `dist/apps/api/src/main.js` is absent. Moving the file would turn that subtest into a silent skip.
4. Every job keeps its 30-minute limit. Each test file still runs in exactly one shard. Reachability expects an evidence artifact from shard 10, and the developer aggregates (`test`, `test:postgres`, `scripts/run-matrix.sh`) run shard 10.

## Evidence

Per-file times come from the top-level TAP `duration_ms` values in each job log. Each top-level test is matched to the one file that declares its name. Job times come from the job's start and end timestamps.

| Shard | Main 44982854424 (before) | REPORTS 44986880683 (before) | CI-6 44991394141 (after) |
|---|---:|---:|---:|
| 1 | 17m 34s | 15m 38s | 15m 08s |
| 2 | 12m 41s | 12m 44s | 15m 12s |
| 3 (catch-all) | 22m 51s | 29m 01s | 12m 26s |
| 4 | 12m 32s | 9m 27s | 13m 04s |
| 5 | 7m 14s | 9m 07s | 7m 05s |
| 6 | 19m 06s | 11m 54s | 9m 57s |
| 7 | 21m 20s | 13m 12s | 9m 53s |
| 8 | 14m 32s | 26m 41s | 10m 59s |
| 9 | 11m 57s | 12m 34s | **23m 01s** |
| 10 (new) | — | — | 16m 53s |

The REPORTS shard 3 figure includes that branch's `report-company-reader`, which took 7m 14s. CI-6 run 44991394141 passed every job on attempt 1.

**Shard 9 missed the 18-minute target.** On the CI-6 run, `date-time-field` alone took 19m 41s. It took 11m 29s on main and 12m 05s on REPORTS. CI-5 had already measured it at 17m 32s alone. Adding `declared-list` (2m 50s) to the shard took away the margin that a slow runner needs. The follow-up is to move `declared-list` back to shard 6, which took 9m 57s here, or into shard 7 or 8. That would restore the isolation CI-5 chose on purpose, which its workflow comment records. It would still leave shard 9 at about 20 minutes on this runner, though. Meeting 18 minutes on slow runners means splitting `date-time-field` itself, which changes a test body and is outside CI-6's scope. Neither follow-up has run in CI.

The heaviest files measured on main were:

| File | Before | After |
|---|---:|---:|
| `build-eval` | 7m 53s | shard 10 |
| `booking-serving` | 2m 58s | shard 2 |
| `boot-capabilities` | 2m 18s | shard 4 |
| `agent-dev-tasks` | 5m 13s | shard 10 |
| `declared-list` | 2m 47s | shard 9 |
| `address-authority` | 2m 16s | shard 10 |
| `request-runtime-view` | 1m 37s | shard 4 |

Test code is identical between main's run (`b03e68c`) and the CI-6 base (`git diff --stat b03e68c 5710c05 -- test` is empty). Across all PostgreSQL jobs both runs report 577 top-level tests, 577 passes and 0 skipped, cancelled or `# SKIP`. In CI-6's shard 3, `the compiled application serves real template PDFs through the production launcher` reports `ok` and was not skipped.

On the CI-6 tip, `test-reachability`, `repository-hygiene` and `test-lock-observability` passed (45 tests), as did all of `test:architecture` (236), lint and typecheck.

The rule-8 controls ran on the committed tip. Each one went red and was restored with `git checkout`:

- With `build-eval` removed from the catch-all exclusion, the "exactly one shard" test failed because two shards owned the file.
- With `10` removed from the workflow matrix, "declared unfiltered producers are wired to CI" failed.
- With `build-eval` removed from shard 10, "suite commands exactly cover all independently discovered test files" failed, and so did the exactly-one-shard test.
- With shard 10 removed from the `test:postgres` aggregate, the two test-lock lease tests failed.

## What the gates cannot prove

- Job times vary a lot between runners. `date-time-field` took between 11m 29s and 19m 41s across the three runs. Shard 8 ran the same files in 14m 32s on main and 26m 41s on REPORTS, and shards 6 and 7 varied by about 1.6 times. One green run shows headroom on one set of runners. It does not guarantee every run stays under 30 minutes.
- No check reads timings. A file that grows can push its shard toward the limit without any check going red.
- Shard 3 stays the catch-all, so every new PostgreSQL file that no shard names lands there.

## Note for the integrator

- PLANNER-1-s1 edits the same `package.json` lines: the shard 3 exclusion (it adds `planner-map`) and shard 5 (it adds `planner-map.test.ts`). It also edits the shard 3 glob in `reachability-producers.ts` and adds to `repository-hygiene.test.ts`. Expect a small conflict there. Keep both edits: add `planner-map` to this exclusion list and to shard 5.
- REPORTS-1-s1 adds `report-company-reader` (7m 14s on its run) and `report-reader-bounds` to the catch-all. Shard 3 measured 12m 26s here, so it would reach about 19 to 20 minutes after that merge. When resolving REPORTS, name `report-company-reader` explicitly in shard 7 (9m 53s here) or shard 6 (9m 57s) instead of leaving it in the catch-all. That means editing the exclusion, the shard list and the producer, as with the planner hunk.
- BILLING-1-s2 grows `billing-terms` by about 950 lines. That file stays in shard 8, which this packet lightens by about 3m 50s on main's timings.

```record-claim
{
  "schemaVersion": "northstar.record-claim/v1",
  "packet": "CI-6",
  "base": "5710c05ae2529b742bf15f8f484c75c0b3930180",
  "head": "ad7946032ae1ebd567bb9b259fc40784183e765b",
  "changedPaths": [
    ".github/workflows/ci.yml",
    "package.json",
    "scripts/run-matrix.sh",
    "test/architecture/repository-hygiene.test.ts",
    "test/architecture/test-lock-observability.test.ts",
    "test/architecture/test-reachability.test.ts",
    "test/helpers/reachability-producers.ts"
  ],
  "symbols": []
}
```
