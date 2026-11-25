# CI-7 — CI reliability: quality cap, PostgreSQL repack, meta-sales stall, evidence dispatch, stale-evidence message

Tested tip `892f5b9c241db4b624afdebcce83f726e4541a61` (the declared head `c529b6ecc89980f8f5e2f18aab6e5a406dab170b` is an empty commit on it that carries the Packet trailer) on base `d8aad66b3e6ee6231b0580f2702c26d116f5a68c` (main). Tier: CI infrastructure, not Critical. No product code changed. Three test files changed their shard or their harness; no test body in a shard changed.

CI tier: full https://github.com/AnserBeg/2rain-greenfield/actions/runs/45566322600

Evidence dispatch (item 4): https://github.com/AnserBeg/2rain-greenfield/actions/runs/45566328226 (evidence.yml, head `892f5b9c2419`). The first dispatch, 45565977878 on `be248a37`, reproduced `ci7-stale-evidence-not-named` and failed `ci7-fixture-ignores-sigterm` because of a race in the new unit test (below).

## What every lane must know when it merges

1. **The PostgreSQL shard lists changed in `package.json` and `test/helpers/reachability-producers.ts`.** Shards 2, 4, 5, 6, 7, 8 and 10 have new contents and `report-company-reader` joins the shard 3 exclusion list. A lane that adds or moves a `test/postgres` file will conflict on those lines. Resolve by keeping the CI-7 assignments and adding your file where this table says, in both files, identically. Do not hand-merge the catch-all glob; copy it from main and add your name.
2. **Where a new PostgreSQL file goes.** Name it in the shard with the lowest measured total, never in shard 9, and keep every shard at 900 s of measured file time or less (the margin rule below). `record-template-library` (441 s on run 45551926366, not on main yet) should go to shard 3, which now totals about 11 minutes with its build; it must not go to shard 5.
3. **The full-tier `quality` job now has 25 minutes** (quick tier keeps 35). The job id is unchanged, so `reachability.needs`, `check-ci-results.mjs` and the `reachability-quality-<sha>` artifact need no edit.
4. **Evidence without a pull request.** `gh workflow run evidence.yml --ref <branch> -f ref=<branch or sha> -f controls="name1 name2"` runs expected-red controls on GitHub. An empty `controls` runs the entries your ref adds or changes against `origin/main`. Dispatches never cancel each other. `regen-snapshot` still needs a pull request.
5. **`check:language-coverage` now says when evidence is stale.** `LANGUAGE_COVERAGE_STALE_REACHABILITY_EVIDENCE: <producer> (<path>)` means the file in `test-results/reachability` came from another run or from an older shard list. Regenerate it as the message says; it is not a code defect. A lane that changes a shard list and then runs only `check:language-coverage` locally will see it.
6. **Browser failures keep their traces.** A failed browser job now uploads `browser-failure-traces-<sha>` (`apps/web/test-results/`, 7 days). Open it before rerunning.
7. **New unit files:** `test/unit/fixture-process.test.ts` and `test/unit/language-coverage-credit.test.ts` are in the unit list in both files and in `repository-hygiene.test.ts`. A lane that edits the unit list will conflict there; keep both.

## Claims

1. **Quality timeout.** Raised to 25 minutes for the full tier instead of splitting the job. The roll-up, `check-ci-results.mjs`, the evidence bundle and the producer table all name the one job `quality`. A split would change all four and add a second artifact, for a problem a number solves. Normal is about 13 minutes (run 45551926366: 13m 12s); 25 is 1.9 times that, and unit alone took 6.5 minutes against a normal 4.3 on the slow runner.
2. **Shard repack.** Measured file times come from the per-file `durationMs` in the reachability artifacts of run 45551926366. Shard 5 took 24m 39s there only because the branch under test added `record-template-library` (441 s) to it; on main shard 5 summed to about 1004 s. Shard 3 reached 29m 01s once (REPORTS, run 44986880683) when it held `report-company-reader` (446 s).

   | Shard | Files | Measured sum |
   |---|---|---:|
   | 1 | `workflow-consumer`, `address-connector`, `customization-display`, `document-numbering`, `customization-formulas` (unchanged) | 859 s |
   | 2 | `customization`, `locations` | 832 s |
   | 3 | catch-all, now without `report-company-reader` | about 626 s plus the build |
   | 4 | `customization-live`, `planner-map`, `customization-inspection` | 874 s |
   | 5 | `customization-world`, `customization-governed-reads` | 856 s |
   | 6 | `report-company-reader`, `document-attachments`, `request-runtime-view`, `declared-list` | 899 s |
   | 7 | `customization-validation`, `board-policy`, `agent-tasks` | 864 s |
   | 8 | `billing-terms`, `boot-capabilities`, `address-authority`, `module-storage-transition` | 806 s |
   | 9 | `date-time-field` alone, as CI-5 chose | 688 s |
   | 10 | `build-eval`, `agent-dev-tasks`, `booking-serving` | 810 s |

   Before, the largest were shard 3 at about 1072 s plus its build, shard 5 at 1004 s and shard 2 at 946 s. **Margin rule:** the measured file times in a shard sum to 900 s or less. Runner variance seen so far is up to 1.7 times (`date-time-field`, 11m 29s to 19m 41s), and 900 s times 1.7 is 25.5 minutes against the 30-minute limit. The limits stay at 30 minutes. `document-templates` stays in shard 3, the only shard that builds `dist`. `billing-terms` keeps 94 s of headroom for the 950 lines BILLING-1-s2 adds.
3. **meta-sales.spec stall.** See the next section; the root cause was not reproduced.
4. **`evidence.yml` dispatch.** New `workflow_dispatch` with required `ref` and optional `controls`. The `pull_request` trigger and `regen-snapshot` are unchanged. The ref is resolved once to a SHA in `select-controls`; every control job checks out that SHA and every cited line names it. The `controls` input reaches the script only through an environment variable, and the script accepts nothing but entry names. Each dispatch has its own concurrency group (`dispatch-<run id>`).
5. **Stale evidence.** `parseReachabilityEvidence` threw a plain error for a run-id mismatch and for an argv mismatch. It now throws `StaleReachabilityEvidenceError` with the same message, and `test/helpers/language-coverage-credit.ts` (moved out of the CLI wrapper so it can be tested) turns it into a named error with the producer, the evidence path and the remedy.

## The full run

Run 45566322600 passed every job on attempt 1. A first full run (45565972160 on `be248a37`) was cancelled while in progress, because the evidence dispatch on that tip had just shown a race in the new fixture unit test; it produced no result and the fix was pushed before the run above.

| Job | Time |
|---|---:|
| Quality | 10m 11s |
| Shard 1 (unchanged; adds the schema check and the locale probe) | 20m 01s |
| Shard 2 | 13m 29s |
| Shard 3 | 11m 33s |
| Shard 4 | 18m 21s |
| Shard 5 | 11m 15s |
| Shard 6 | 15m 45s |
| Shard 7 | 15m 11s |
| Shard 8 | 14m 51s |
| Shard 9 | 11m 58s |
| Shard 10 | 14m 04s |
| Browser runner | 8m 35s |

The slowest shard is now 20m 01s (shard 1, which this packet did not touch) against 24m 39s and 29m 01s before. Shard 1 carries about two minutes of non-file work (the schema drift check and the locale probe) on top of its 859 s of file time; the 900 s rule counts file time only, so the next repack should count that overhead for shard 1.

## The meta-sales.spec stall (item 3)

Seen three times, all with `Test timeout of 480000ms exceeded.` and nothing else: runs 45002907794 (JS off), 45054641061 (JS on) and 45110643699 (JS on). The other variant passed in about a minute each time, and a whole-workflow rerun was green.

What the logs establish. Every Playwright call in the spec has a 30-second timeout, so a stall of 8 minutes with no `locator.` or `page.` line in the report cannot be inside a Playwright call. The only waits in that test that are not Playwright calls are in `withBrowserFixture`: the fixture child printing its URL, and the fixture child exiting after SIGTERM. Both were unbounded, and the test body's own failure sat behind the second one, so a real assertion failure followed by a stalled teardown would also read as a bare timeout.

What is not established. I could not reproduce the stall. Locally the spec passes and the child exits within a second of SIGTERM with a page open (no lingering handle after teardown). A half-sent request on the server delays `server.close` by 25 seconds, not minutes. I therefore do not claim which of the two waits stalled. The failed jobs uploaded no trace, so none of the three can be examined.

What changed:

- `apps/web/test/browser/fixture-process.ts` starts and stops the child with deadlines (240 s to start, 120 s to stop, then SIGKILL). A stall now fails in a few minutes and prints the child's output and which stage stalled. The test body's failure is rethrown first.
- The fixture closes every connection before `app.close()`, for the same reason `close-server.ts` gives for the other browser specs.
- A failed browser job uploads Playwright's trace and screenshot.

This is not a retry. If the stall returns, the report names the stage and the trace is attached, and the next packet fixes that. **The cause stays open until then.**

## Evidence

- Unit and architecture: the two new unit files pass (5 and 4 tests); `test:architecture` passes 239 tests; `test-reachability`, `repository-hygiene` and `test-lock-observability` pass 45; format, lint and typecheck pass; `check:expected-red` names live text for all 475 entries.
- Item 5 run by hand: a leftover `architecture.json` from another run produced `LANGUAGE_COVERAGE_STALE_REACHABILITY_EVIDENCE: architecture (test-results/reachability/architecture.json) ... Regenerate it: ...` and exit 1.
- Item 1 and 2 numbers are from runs 45551926366 and 44986880683 and from the CI-6 record.

## Rule 8 reds (each restored)

- Shard coverage: `report-company-reader` removed from the catch-all exclusion in both files makes "suite commands exactly cover all independently discovered test files" and "every file selected by the former general PostgreSQL glob belongs to exactly one shard" fail. The file also listed in shard 7 fails the coverage test alone. `package.json` shard 6 without `request-runtime-view` while the producer keeps it fails the coverage test alone.
- Stale evidence: control `ci7-stale-evidence-not-named` (`test/evidence/CI-7.expected-red.json`) replaces the `instanceof` test with `false`; "evidence written under an older file list is stale" fails with the reason `LANGUAGE_COVERAGE_STALE_REACHABILITY_EVIDENCE`. Without the catch the run-mismatch test fails too; the other three tests stay green.
- Fixture stop: control `ci7-fixture-ignores-sigterm` makes `stop()` always report `exited: true`; only the SIGTERM-ignoring case fails.
- Evidence dispatch: the architecture test pins the dispatch inputs, the per-run concurrency group, the single SHA resolution, the environment-only input and the absence of `inputs.` in any `run:` line. Both controls above ran on GitHub through the new dispatch.

## Rule 17

- Most general form: one measured rule for shard size (900 s of file time), one `quality` job id, one dispatch that takes any ref and any control names, one error class for "evidence from another run or definition".
- Used unchanged: the existing exactly-one-shard and suite-coverage tests, the reachability roll-up, `scripts/expected-red-on-demand.mjs` (selection and outcome), `check-expected-red.sh`.
- Narrower, and why: the repack is a snapshot of one run's timings and no check reads timings, so a file that grows can push a shard back up without anything going red. The browser failure artifact is added to the `browser` job only, where meta-sales runs. `regen-snapshot` stays pull-request only because its artifact name and its committed-snapshot comparison are keyed to a pull request head.

## What the gates cannot prove

- Runner variance is a measurement, not a bound. The 900 s rule is a margin, not a guarantee.
- The meta-sales fix bounds and explains a stall; it does not show what stalled.
- The dispatch proof is two controls on one SHA.

## Note for the integrator

- A lane rebased after this merges needs no renumbering for CI-7. PLANNER-1-s1 (`planner-map` is now in shard 4, not 5), REPORTS-1-s1 (`report-company-reader` is now in shard 6) and BILLING-1-s2 (`billing-terms` stays in shard 8) edit the lines this packet rewrote: take main's lists and re-add only what the lane adds.

```record-claim
{
  "schemaVersion": "northstar.record-claim/v1",
  "packet": "CI-7",
  "base": "d8aad66b3e6ee6231b0580f2702c26d116f5a68c",
  "head": "c529b6ecc89980f8f5e2f18aab6e5a406dab170b",
  "changedPaths": [
    ".github/workflows/ci.yml",
    ".github/workflows/evidence.yml",
    "apps/web/test/browser/fixture-process.ts",
    "apps/web/test/browser/meta-sales.spec.ts",
    "docs/execution/evidence-on-demand.md",
    "package.json",
    "test/architecture/evidence-on-demand.test.ts",
    "test/architecture/repository-hygiene.test.ts",
    "test/evidence/CI-7.expected-red.json",
    "test/helpers/check-language-coverage.ts",
    "test/helpers/language-coverage-credit.ts",
    "test/helpers/meta-sales-fixture.ts",
    "test/helpers/reachability-evidence.ts",
    "test/helpers/reachability-producers.ts",
    "test/unit/fixture-process.test.ts",
    "test/unit/language-coverage-credit.test.ts"
  ],
  "symbols": []
}
```
