# CI-2 — Duration-balanced CI

CI-3 retains this matrix as the full tier. [Tier selection, reachability and final dispatch](../evidence-on-demand.md#packet-and-main-ci).

The full gate requires every job to succeed and every producer to supply unfiltered executed-file evidence for the same run and attempt.

## Shard assignments

- Seven schema/isolation shards use measured duration. The two original customization files were divided at independent top-level tests. Shard 3 keeps unassigned root files and nested paths.
- Four hosted trials showed substantial runner variance. Taking each schema file’s largest observed duration gave 75:39 of work before setup. The seven final shards total 10:14–11:27 each on those measurements. Shard 1 also runs the schema and locale probes.
- Inventory posting took 13:31 on the slower runner and 7:28 on the faster runner. It runs alongside the other inventory files. The developer commands `test:postgres` and `test:postgres:inventory` each run all their shards under the original outer lease.
- Three independent Customize browser journeys move to a separate file. They run with the formula and inspection specs. The Ledger screenshots stay with the composed browser runner.
- Heavy jobs already requested runners independently of quality. Observability also requests a runner immediately. Its producer starts three tests from its checkout and provisions its own PostgreSQL fixture. The final gate waits for observability, quality, the isolated compiler budget and the rest of the matrix.
- The Actions summary lists the three slowest files per suite. The reachability artifacts retain every measured file. Node reports elapsed file time, and Playwright sums test attempt durations.

## Measurements and coverage

[Baseline 1](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44653088426) took 35:35 and [baseline 2](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44669449690) took 44:47, including queues. Baseline 2 has the same test inventory as the first candidate’s parent. The maximum general PostgreSQL job time was 16:39 and 20:30 respectively.

The [first candidate](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44676250924) passed in 36:43. Its 25 producers credited 1,632 results in 206 files. The matching baseline credited 1,632 results in 204 files. Per-file counts agree after summing the two split files with their original files. All seven PostgreSQL and six browser test registration statements, including the parameterized browser loop, were byte-identical across the splits.

The first run’s inventory balances job waited 26:44 for a runner and finished in 8:13. At 05:15 UTC on November 20 the repository had 40 running jobs and 51 queued.

The [second candidate](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44679260977) passed in 29:32 after incorporating SIGNIN-1 and redistributing shard 5. Its 25 producers credited 1,635 results in 209 files. The three added files each supplied one result. The [six-shard trial](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44683652387) passed in 14:21 with 209 files and 1,643 results. GitHub tested the PR merge tree with UI-COMPOSE-1, which added six unit cases, one PostgreSQL case and one browser journey. Its six schema jobs took 10:04, 12:26, 7:18, 9:56, 6:21 and 9:23 respectively.

The [overlap rerun](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44685510149) passed in 23:14 with the same 209 files and 1,643 results. One schema job took 16:32, prompting the seventh shard.

The [seven-shard packet run](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44689614046) passed in 46:59. Its last independent job began at 38:17. Schema job times were 9:03, 8:34, 12:36, 9:18, 6:25, 15:33 and 8:08. The PR merge tree included three additional WORKFLOW-1 results. All 26 producers supplied the 1,646 results from 209 files in one attempt.

[All test files, producing suites and credited result counts for the measured runs](../evidence/CI-2-test-files.tsv). Each column uses artifacts from attempt 1 of its named run. “Included above” groups the split cases under their original file.

## Test it yourself

Run `node --import tsx --test test/architecture/test-reachability.test.ts test/integration/observability-ci-contract.test.ts`. Expect all tests to pass, including the same-attempt, missing-evidence and nested-path controls.

```record-claim
{
  "schemaVersion": "northstar.record-claim/v1",
  "packet": "CI-2",
  "base": "888b0636423660d351d20eb48ebea98bab519259",
  "head": "7dee0471c97bdd000c75561e214e228672d7a866",
  "changedPaths": [
    ".github/scripts/report-ci-timings.mjs",
    ".github/workflows/ci.yml",
    "apps/web/playwright.composed.config.ts",
    "apps/web/playwright.rules.config.ts",
    "apps/web/playwright.shared.ts",
    "apps/web/test/browser/customize-rules.composed-application.spec.ts",
    "apps/web/test/browser/customize.composed-application.spec.ts",
    "package.json",
    "scripts/run-matrix.sh",
    "test/architecture/repository-hygiene.test.ts",
    "test/architecture/test-lock-observability.test.ts",
    "test/architecture/test-reachability.test.ts",
    "test/evidence/CUSTOMIZE-3.expected-red.json",
    "test/evidence/CUSTOMIZE-4.expected-red.json",
    "test/helpers/customization-fixture.ts",
    "test/helpers/node-test-evidence-reporter.mjs",
    "test/helpers/normalize-playwright-evidence.ts",
    "test/helpers/reachability-producers.ts",
    "test/integration/observability-ci-contract.test.ts",
    "test/postgres/customization-live.test.ts",
    "test/postgres/customization.test.ts"
  ],
  "symbols": [
    {
      "path": "test/helpers/reachability-producers.ts",
      "name": "reachabilityProducers"
    }
  ]
}
```
