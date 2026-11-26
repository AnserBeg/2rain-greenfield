# CI-7 — CI reliability: quality cap, PostgreSQL repack with shard 11, meta-sales fixture stall, evidence dispatch, stale-evidence message

Tested tip `4b2f3fcc956a18200eeee8e51b11b71da2214cb8` (the declared head `3bcd67f15c5b63ed638314b2f37d1ae75af2e853` is an empty commit on it that carries the Packet trailer) on base `20762dbcd700a033226820319dfc58382f8242ba` (main, TRAIN-M). Tier: CI infrastructure, not Critical. No product code changed. This is the fix round after the independent review: the first version (tested tip `892f5b9c2419`, full run 45566322600) was cut from a main 76 commits old and its repack no longer fit; this version merges main once and re-measures.

CI tier: full https://github.com/AnserBeg/2rain-greenfield/actions/runs/45612048822

Evidence dispatch (item 4): https://github.com/AnserBeg/2rain-greenfield/actions/runs/45612056166 (evidence.yml, head `4b2f3fcc956a`).

## What every lane must know when it merges

1. **The PostgreSQL shard lists changed and there is a shard 11.** `package.json` (`test:postgres:1` to `:11`, the `test` and `test:postgres` aggregates), `test/helpers/reachability-producers.ts`, `scripts/run-matrix.sh`, the `ci.yml` matrix and three architecture tests name it. A lane that adds or moves a `test/postgres` file will conflict on those lines. Keep the CI-7 assignments and add your file where rule 2 says, in both files, identically. Copy the catch-all glob from main and add your name; never hand-merge it.
2. **Where a new PostgreSQL file goes.** In the shard with the lowest total in the table below, never in shard 9, so that every shard stays at 900 s of measured file time or less. Shard 3 (the catch-all) is the lightest at about 626 s plus its build, but a file there needs no list edit: a file that is not named anywhere lands in shard 3 on its own, so add a file by name to another shard when the catch-all is above about 700 s. The shard totals count file time only: shard 1 adds 24 s (schema check 13 s, locale probe 11 s) and shard 3 adds its build.
3. **The full-tier `quality` job now has 25 minutes** (quick tier keeps 35). The job id is unchanged.
4. **Evidence without a pull request.** `gh workflow run evidence.yml --ref <branch> -f ref=<branch or full commit sha> -f controls="name1 name2"` runs expected-red controls on GitHub. `ref` must be a branch, a tag or a full 40-character SHA. An empty `controls` runs the entries your ref adds or changes against `origin/main`. Dispatches never cancel each other. `regen-snapshot` still needs a pull request.
5. **`check:language-coverage` now says when evidence is stale.** `LANGUAGE_COVERAGE_STALE_REACHABILITY_EVIDENCE: <producer> (<path>)` means that file came from another run or from an older definition of the producer. Rerun the producer it names with its own command. Do not begin a new run: that makes every other producer's evidence stale and the message moves to the next one. If a fresh rerun still mismatches, `package.json` and `reachability-producers.ts` name different files; a hygiene test now compares every script-backed node producer with its package script.
6. **Browser failures keep their traces.** A failed browser job uploads `browser-failure-traces-<sha>` (`apps/web/test-results/`, 7 days). Open it before rerunning.
7. **New unit files** `fixture-process`, `close-fixture-app` and `language-coverage-credit` are in the unit list in both files and in `repository-hygiene.test.ts`. A lane that edits the unit list will conflict there; keep both sides.
8. **Three browser fixtures stop differently.** `meta-sales-fixture.ts`, `order-entry-fixture.ts` and `planner-map-fixture.ts` close the application through `test/helpers/close-fixture-app.ts` (sockets closed first, a 60 s bound, one marker per step on stderr). A lane that edits those teardown lines will conflict; keep the call.

## Claims

1. **Quality timeout.** Raised to 25 minutes for the full tier instead of splitting the job. The roll-up, `check-ci-results.mjs`, the evidence bundle and the producer table all name the one job `quality`. A split would change all four and add a second artifact. Normal is about 10 to 13 minutes; 25 is about 2 times that, and unit alone took 6.5 minutes against a normal 4.3 on the slow runner.
2. **Shard repack on the main it lands on.** Per-file times are the median of three runs: 45551926366 (a branch), main 45562713263 and the first CI-7 full run 45566322600. Shard 5 took 24m 39s on the first run only because that branch added `record-template-library` (335 to 441 s) to it; that file is on main now. Shard 3 reached 29m 01s once (REPORTS, 44986880683) when it held `report-company-reader`. On the current main the nine usable shards had 233 s of room in total, so the packet adds shard 11, as CI-6 added 10.

   | Shard | Files | Median sum |
   |---|---|---:|
   | 1 | `workflow-consumer`, `address-connector` | 790 s |
   | 2 | `customization`, `locations` | 808 s |
   | 3 | catch-all, without `report-company-reader` | about 626 s plus the build |
   | 4 | `record-template-library`, `customization-governed-reads`, `customization-inspection` | 832 s |
   | 5 | `billing-terms`, `customization-world` | 809 s |
   | 6 | `document-attachments`, `booking-serving`, `board-policy`, `agent-tasks` | 787 s |
   | 7 | `customization-validation`, `agent-dev-tasks`, `request-runtime-view` | 813 s |
   | 8 | `report-company-reader`, `customization-live` | 840 s |
   | 9 | `date-time-field` alone, as CI-5 chose | 692 s |
   | 10 | `build-eval`, `planner-map` | 813 s |
   | 11 (new) | `address-authority`, `boot-capabilities`, `customization-display`, `customization-formulas`, `declared-list`, `document-numbering`, `module-storage-transition` | 793 s |

   **Margin rule:** the median file times in a shard sum to 900 s or less. The largest ratio of a slow runner to the median on these files is 1.84 (CI-6 recorded shard 8 at 26m 41s against 14m 32s); 900 s times 1.84 is 27.6 minutes against the 30-minute limit, so 900 s is a margin and not a bound. Single files vary more: `customization` took 736 to 1189 s across the three runs, and on a run like the 1189 s one shard 2 would need about 1250 s. The limits stay at 30 minutes. `document-templates` stays in shard 3, the only shard that builds `dist`. `billing-terms` (456 s here) keeps 91 s of headroom for the 950 lines BILLING-1-s2 adds.
3. **meta-sales fixture stall.** See the next section.
4. **`evidence.yml` dispatch.** New `workflow_dispatch` with required `ref` and optional `controls`. The `pull_request` trigger and `regen-snapshot` are unchanged. The ref is resolved once to a SHA in `select-controls`; every control job checks out that SHA and every cited line names it. The `controls` input reaches the script only through an environment variable, and the script accepts nothing but entry names. Each dispatch has its own concurrency group (`dispatch-<run id>`).
5. **Stale evidence.** `parseReachabilityEvidence` threw a plain error for a run-id mismatch and for an argv mismatch. It now throws `StaleReachabilityEvidenceError` with the same message, and `test/helpers/language-coverage-credit.ts` turns it into a named error with the producer, the evidence path and the remedy. The empty-controls path of the dispatch has not run on GitHub; locally it selects the CI-7 entries.

## The meta-sales fixture stall (item 3)

Seen three times, all with `Test timeout of 480000ms exceeded.` and nothing else: runs 45002907794 (JS off), 45054641061 (JS on) and 45110643699 (JS on). The other variant passed in about a minute each time, and a whole-workflow rerun was green.

What the logs establish. Every Playwright call in the spec has a 30-second timeout, so a stall of 8 minutes with no `locator.` or `page.` line in the report cannot be inside a Playwright call. The only waits that are not Playwright calls are in `withBrowserFixture`: the fixture child printing its URL, and the fixture child exiting after SIGTERM. Both were unbounded.

**Probable cause (reproduced in isolation by the reviewer, not on CI).** On the pinned Node 22.22.2 a plain `server.close()` had not returned after 400 s while a client held a socket that connected and sent nothing; a kept-alive socket with a finished request closed at once. `close()` also stops the timeout checker, so a bare server has no bound at all. The page is still open when the fixture is told to stop, and Chromium can hold such a socket (speculative preconnect; not verified here). The first version of this record said a half-sent request delays `close` by 25 seconds and "not minutes"; that was measured with a request that the server's own timeouts later closed, and does not hold for a silent socket. `closeAllConnections()` is therefore the fix, not a mask. It is not proved that this socket is what stalled the three CI runs: the failed jobs uploaded no trace.

What changed:

- `test/helpers/close-fixture-app.ts` closes every connection before `app.close()`, bounds the wait at 60 s and prints the open-connection count and one marker per step. `meta-sales-fixture.ts`, `order-entry-fixture.ts` (23 specs use it) and `planner-map-fixture.ts` call it; each previously did a plain `await app.close()`.
- `apps/web/test/browser/fixture-process.ts` starts and stops the meta-sales child with deadlines (240 s to start, 120 s to stop, then SIGKILL), and `stop()` returns the exit code and signal. The spec asserts a clean exit (`code 0`, no signal), and a `try`/`finally` makes the body's failure propagate by language rule.
- A failed browser job uploads Playwright's trace and screenshot.

Why 23 unbounded waits remain. The specs that use `order-entry-fixture.ts` and `planner-map-fixture.ts` still wait on the child without a deadline; rewriting 23 specs is outside this packet. The fixture-side bound is what applies to them: the fixture's own `closeFixtureApp` fails by name after 60 s, so the meta-sales and order-entry children exit with a message (an unhandled rejection, exit 1). The planner-map child only set an exit code and could stay alive after the bound error; CI-8 makes it exit. A later packet can move those specs to `fixture-process.ts`.

This is not a retry. If a stall returns, the report names the stage and the trace is attached. **The cause is probable, not proven.**

## The full run

Run 45612048822 passed every job on attempt 1, on tested tip `4b2f3fcc956a`. It was dispatched once; the previous version's run (45566322600) was on the stale base and is superseded.

| Job | Time |
|---|---:|
| Quality | 12m 58s |
| Shard 1 | 10m 36s |
| Shard 2 | 13m 16s |
| Shard 3 | 15m 10s |
| Shard 4 | 12m 44s |
| Shard 5 | 18m 18s |
| Shard 6 | 13m 36s |
| Shard 7 | 14m 59s |
| Shard 8 | 14m 34s |
| Shard 9 | 19m 11s |
| Shard 10 | 12m 06s |
| Shard 11 | 19m 43s |
| Browser runner | 10m 28s |
| Customization browser runner | 21m 46s |

The slowest PostgreSQL shard is 19m 43s (shard 11, 793 s of median file time, so this runner was about 1.5 times the median; shard 9, `date-time-field` alone, took 19m 11s against 692 s). The slowest job overall is the Customization browser runner at 21m 46s of its 30-minute limit (26m 27s on main run 45562713263), which this packet does not touch and which is the next job to look at. On main run 45562713263 shard 1 took 23m 59s and shard 2 25m 08s; they are 10m 36s and 13m 16s here. The first version of this record said shard 1 carried two minutes of non-file work; it carries 24 s (schema check 13 s, locale probe 11 s), and its test step took 866 s on the measuring run and 1151 s on the first CI-7 full run, so the measuring run was a fast one.

## Evidence

- Local at the tested tip: the new unit files pass (`fixture-process` 4, `close-fixture-app` 2, `language-coverage-credit` 5); format, lint, typecheck, `check:expected-red`, `check-record-ci-tier` and the record-claim gate pass. A full local `test:architecture` run could not be completed on the laptop; CI ran it green in the full run's quality step (143 s).
- The first dispatch on the old tip (45565977878) failed `ci7-fixture-ignores-sigterm` because of a race in the new unit test (the handler was installed after the URL was printed); fixed and rerun before the first full run.
- The shard timings above are medians of the three runs named in claim 2.

## Rule 8 reds (each restored)

- Shard coverage (this version's lists): `report-company-reader` dropped from the catch-all exclusion; a file named in two shards; a file removed from `package.json` only. All fail the coverage tests, each alone where noted in the result file.
- Producer identity: the hygiene test now compares every script-backed node producer with its package script; a producer list that differs from its script by one file reds it.
- Controls in `test/evidence/CI-7.expected-red.json`, each run through `check-expected-red.sh --run` and on GitHub: `ci7-stale-evidence-not-named` (both stale-evidence tests killed, no name filter), `ci7-run-mismatch-not-stale-class`, `ci7-argv-mismatch-not-stale-class`, `ci7-fixture-ignores-sigterm` and `ci7-silent-socket-blocks-stop`.
- Evidence workflow: the architecture test pins the dispatch inputs, the per-run concurrency group, the resolved SHA in the select and control steps, `fetch-depth: 0`, that `inputs.` appears only in the checkout `ref` and the `PR_BODY` expression, that `github.sha` appears nowhere, and the failure-trace upload step in `ci.yml`.

## Rule 17

- Most general form: one measured rule for shard size (900 s of median file time), one `quality` job id, one dispatch that takes any ref and any control names, one error class for evidence from another run or definition, one `closeFixtureApp` for every browser fixture that serves an application. (CI-8 note: the control checkout kept a name-based `fetch-depth` list, so controls that read git history failed with "the mutated run executed no test"; CI-8 makes every control checkout full-history.)
- Used unchanged: the exactly-one-shard and suite-coverage tests, the reachability roll-up, `scripts/expected-red-on-demand.mjs`, `check-expected-red.sh`.
- Narrower, and why: the repack is a snapshot of medians and no check reads timings, so a file that grows can push a shard back up without anything going red. The failure-trace upload is on the `browser` job only. `regen-snapshot` stays pull-request only. The bounded stop in `fixture-process.ts` serves one spec; the other 23 specs keep an unbounded wait on the child and rely on the fixture-side bound (see above).

## What the gates cannot prove

- Runner variance is a measurement, not a bound, and single files vary by 1.6 times.
- The probable cause of the stall is not shown on CI.
- The dispatch proof is five controls on one SHA.

## Note for the integrator

- PLANNER-1-s1, REPORTS-1-s1 and BILLING-1-s2 edit the lines this packet rewrote: take main's lists and re-add only what the lane adds. `record-template-library` is on main and is in shard 4 here; `planner-map` is in shard 10; `report-company-reader` is in shard 8.

```record-claim
{
  "schemaVersion": "northstar.record-claim/v1",
  "packet": "CI-7",
  "base": "20762dbcd700a033226820319dfc58382f8242ba",
  "head": "3bcd67f15c5b63ed638314b2f37d1ae75af2e853",
  "changedPaths": [
    ".github/workflows/ci.yml",
    ".github/workflows/evidence.yml",
    "apps/web/test/browser/fixture-process.ts",
    "apps/web/test/browser/meta-sales.spec.ts",
    "docs/execution/evidence-on-demand.md",
    "docs/execution/packets/CI-7.md",
    "package.json",
    "scripts/expected-red-on-demand.mjs",
    "scripts/run-matrix.sh",
    "test/architecture/evidence-on-demand.test.ts",
    "test/architecture/repository-hygiene.test.ts",
    "test/architecture/test-lock-observability.test.ts",
    "test/architecture/test-reachability.test.ts",
    "test/evidence/CI-7.expected-red.json",
    "test/helpers/check-language-coverage.ts",
    "test/helpers/close-fixture-app.ts",
    "test/helpers/language-coverage-credit.ts",
    "test/helpers/meta-sales-fixture.ts",
    "test/helpers/order-entry-fixture.ts",
    "test/helpers/planner-map-fixture.ts",
    "test/helpers/reachability-evidence.ts",
    "test/helpers/reachability-producers.ts",
    "test/unit/close-fixture-app.test.ts",
    "test/unit/fixture-process.test.ts",
    "test/unit/language-coverage-credit.test.ts"
  ],
  "symbols": []
}
```
