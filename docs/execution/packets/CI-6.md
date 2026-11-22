# CI-6 — PostgreSQL shard 10 and a lighter catch-all shard

Tested tip `244983fadcf592f0166ce7687776408182244d54` on base `5710c05ae2529b742bf15f8f484c75c0b3930180`. Tier: CI infrastructure, not Critical. No product code, migration or test body changed. CI-5 has no packet record, so this one follows CI-4 and CI-5's commit `6545ae7f8`.

CI tier: full https://github.com/AnserBeg/2rain-greenfield/actions/runs/44993515022

## Claims

1. PostgreSQL shard 3 runs every file that no other shard names. It now also excludes `build-eval`, `booking-serving` and `boot-capabilities`. On main run 44982854424 these three took 13m 09s of shard 3's 22m 51s.
2. A new shard 10 runs `build-eval`, `agent-dev-tasks` and `address-authority`. Shard 2 adds `booking-serving`. Shard 4 adds `boot-capabilities` and `request-runtime-view`. Shards 7 and 8 give up the files listed above. Shards 1, 5, 6 and 9 are unchanged. Shard 9 still runs `date-time-field` alone, as CI-5 chose.
3. `document-templates` stays in shard 3. Shard 3 is the only shard that builds `dist`, and the production-launcher subtest skips when `dist/apps/api/src/main.js` is absent. Moving the file would turn that subtest into a silent skip.
4. Every job keeps its 30-minute limit. Each test file still runs in exactly one shard. Reachability expects an evidence artifact from shard 10, and the developer aggregates (`test`, `test:postgres`, `scripts/run-matrix.sh`) run shard 10.

## Evidence

Per-file times come from the top-level TAP `duration_ms` values in each job log. Each top-level test is matched to the one file that declares its name. Job times come from the job's start and end timestamps.

| Shard | Main 44982854424 (before) | REPORTS 44986880683 (before) | CI-6 first run 44991394141 | CI-6 final run 44993515022 |
|---|---:|---:|---:|---:|
| 1 | 17m 34s | 15m 38s | 15m 08s | 14m 56s |
| 2 | 12m 41s | 12m 44s | 15m 12s | 15m 18s |
| 3 (catch-all) | 22m 51s | 29m 01s | 12m 26s | 8m 48s |
| 4 | 12m 32s | 9m 27s | 13m 04s | **21m 20s** |
| 5 | 7m 14s | 9m 07s | 7m 05s | 9m 04s |
| 6 | 19m 06s | 11m 54s | 9m 57s | 14m 35s |
| 7 | 21m 20s | 13m 12s | 9m 53s | 12m 48s |
| 8 | 14m 32s | 26m 41s | 10m 59s | 11m 19s |
| 9 | 11m 57s | 12m 34s | **23m 01s** | 12m 29s |
| 10 (new) | — | — | 16m 53s | 13m 41s |

The REPORTS shard 3 figure includes that branch's `report-company-reader`, which took 7m 14s. Both CI-6 runs passed every job on attempt 1.

The first CI-6 run (`ad7946032`) also put `declared-list` in shard 9. Shard 9 then took 23m 01s, with `date-time-field` alone taking 19m 41s. That file took 11m 29s on main, 12m 05s on REPORTS and 12m 02s on the final run, and CI-5 measured it at 17m 32s alone. The orchestrator ruled to move `declared-list` back to shard 6 and change nothing else. `244983fad` does that, and run 44993515022 tested it.

**Shard 4 took 21m 20s on the final run.** On the first run it took 13m 04s with the same files. On the final run `customization-live` took 11m 34s, against 7m 00s on the first run and 9m 49s on main. The moved `boot-capabilities` and `request-runtime-view` took 3m 55s and 2m 47s, against 2m 26s and 1m 40s on the first run. This is the same runner variance seen elsewhere, not a file left in two places. It leaves 8m 40s of headroom under the limit but misses the 18-minute target.

**Follow-up (named): split `date-time-field` in a later packet.** Shard 9's variance comes from that one file, between 11m 29s and 19m 41s alone across these runs. No shard move can bring it reliably under 18 minutes, and splitting it changes a test body outside CI-6's scope.

The heaviest files measured on main were:

| File | Before | After |
|---|---:|---:|
| `build-eval` | 7m 53s | shard 10 |
| `booking-serving` | 2m 58s | shard 2 |
| `boot-capabilities` | 2m 18s | shard 4 |
| `agent-dev-tasks` | 5m 13s | shard 10 |
| `address-authority` | 2m 16s | shard 10 |
| `request-runtime-view` | 1m 37s | shard 4 |

Test code is identical between main's run (`b03e68c`) and the CI-6 base (`git diff --stat b03e68c 5710c05 -- test` is empty). Across all PostgreSQL jobs, main and both CI-6 runs each report 577 top-level tests, 577 passes and 0 skipped, cancelled or `# SKIP`. In shard 3 of both CI-6 runs, `the compiled application serves real template PDFs through the production launcher` reports `ok` and was not skipped.

On `ad7946032`, `test-reachability`, `repository-hygiene` and `test-lock-observability` passed (45 tests), as did all of `test:architecture` (236), lint and typecheck. The same three suites passed again on `244983fad` (45 tests).

The rule-8 controls ran on the committed tip `ad7946032`. Each one went red and was restored with `git checkout`:

- With `build-eval` removed from the catch-all exclusion, the "exactly one shard" test failed because two shards owned the file.
- With `10` removed from the workflow matrix, "declared unfiltered producers are wired to CI" failed.
- With `build-eval` removed from shard 10, "suite commands exactly cover all independently discovered test files" failed, and so did the exactly-one-shard test.
- With shard 10 removed from the `test:postgres` aggregate, the two test-lock lease tests failed.

## What the gates cannot prove

- Job times vary a lot between runners. `date-time-field` took between 11m 29s and 19m 41s across the four runs, and shard 4 took 13m 04s and 21m 20s with the same files. Shard 8 ran the same files in 14m 32s on main and 26m 41s on REPORTS, and shards 6 and 7 varied by about 1.6 times. One green run shows headroom on one set of runners. It does not guarantee every run stays under 30 minutes.
- No check reads timings. A file that grows can push its shard toward the limit without any check going red.
- Shard 3 stays the catch-all, so every new PostgreSQL file that no shard names lands there.

## Note for the integrator

- PLANNER-1-s1 edits the same `package.json` lines: the shard 3 exclusion (it adds `planner-map`) and shard 5 (it adds `planner-map.test.ts`). It also edits the shard 3 glob in `reachability-producers.ts` and adds to `repository-hygiene.test.ts`. Expect a small conflict there. Keep both edits: add `planner-map` to this exclusion list and to shard 5.
- REPORTS-1-s1 adds `report-company-reader` (7m 14s on its run) and `report-reader-bounds` to the catch-all. Shard 3 measured 12m 26s here, so it would reach about 19 to 20 minutes after that merge. Shard 3 took 8m 48s on the final run. **When REPORTS merges, add `report-company-reader` explicitly to shard 7** (9m 53s and 12m 48s on the two CI-6 runs) and add it to the catch-all exclusion. That means editing `package.json` and `reachability-producers.ts`, as with the planner hunk. `report-reader-bounds` can stay in the catch-all.
- BILLING-1-s2 grows `billing-terms` by about 950 lines. That file stays in shard 8, which this packet lightens by about 3m 50s on main's timings.

```record-claim
{
  "schemaVersion": "northstar.record-claim/v1",
  "packet": "CI-6",
  "base": "5710c05ae2529b742bf15f8f484c75c0b3930180",
  "head": "244983fadcf592f0166ce7687776408182244d54",
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
