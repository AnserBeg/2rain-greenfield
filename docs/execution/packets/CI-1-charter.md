# CI-1 — charter: a green light in about 12 minutes instead of 27, proving exactly what it proves today

You are the BUILD lane (Codex gpt-6.2-astra). Chartered 2026-11-17 by the orchestrator. Worktree `/home/rvham/2rain-greenfield-ci-1`,
branch `packet/CI-1`. Read `AGENTS.md` §4-§5 and `.github/workflows/ci.yml`, `package.json` (the `test:*` scripts),
`scripts/run-suite.sh`, `scripts/run-with-test-lock.mjs` and the reachability helpers under `test/helpers/` before changing anything.

## Why (measured 2026-11-17 over 11 successful runs)
A full run takes ~27 minutes. The critical path is the `postgres` job (~20.6 min): its test step runs ~102 top-level tests serially
(`--test-concurrency=1`), ~1,194 s in total. The slowest tests are in `customization-world.test.ts` (219 s), `customization.test.ts`
(163 s) and `agent-tasks.test.ts` (85 s). Next is `postgres composed` (~17 min, the single file `composed-application.test.ts`, which
replays the whole release lineage). After that come `postgres inventory`, the browser jobs and `quality` (~10 min each). Docs-only
pushes run everything. Three development lanes push all day, and with 14 jobs per push, runners queue for up to ~10 minutes.

## Outcome
A push that changes code gets a green or red light in about 12-15 minutes. A push that changes only prose documentation runs only the
checks that read it. CI proves exactly what it proves today: every test file still runs on every code push, the reachability evidence
still covers every suite, and nothing is relaxed.

## Changes (one PR, several commits)
1. **Shard `test:postgres` into 3 jobs by file**, balanced by the durations above. The customization tests go in different shards.
   - The exclusion list that keeps other suites' files out of `test:postgres` stays exhaustive.
   - Write one reachability file per shard (`postgres-1.json`, and so on). Make `check:reachability` and the merge step expect all of
     them, so a missing shard fails the gate.
   - Keep the local `test:postgres` script working as today, as one command that runs every shard's files.
2. **Split `composed-application.test.ts` across 2-3 jobs** without weakening it.
   - Prefer the node test runner's own filtering (`--test-name-pattern`, or `--test-shard=i/n` if the file's tests are independent)
     over editing the test.
   - If its tests depend on each other's order or state, leave it whole, say so, and skip this change.
3. **Docs-only pushes run only what reads docs.**
   - Add a first job that decides whether a push changes anything besides documentation prose.
   - Code includes `docs/execution/**` and `docs/decisions/**` (scripts such as `scripts/check-review-record.sh` read them), `.agents/**`,
     every config and lock file, and anything a test or script reads. Find these with grep; do not guess.
   - Prose-only means files under `docs/` outside those directories, plus top-level `*.md`.
   - A prose-only push runs `quality` and the final gate; every other job is skipped. The final reachability gate passes on a skipped
     matrix only when the decision job said prose-only.
4. **Fewer, fuller runners.** Merge the two shortest PostgreSQL jobs (`commercial` and `sales`) into one job running both scripts in
   sequence, so sharding does not raise the job count much. Cache Playwright browsers keyed by the Playwright version.
5. **Leave `observability`'s `needs:` alone** unless you prove it reads nothing the browser or postgres jobs produce.

## Decided (do not reopen)
- No test is deleted, weakened, skipped on code pushes, or moved to a nightly run.
- No timing bound is relaxed. `COMPILE_BUDGET_INDETERMINATE` stays as it is.
- No paid runners and no new third-party actions beyond `actions/cache` (pin it by commit SHA, as the workflow pins others).
- `cancel-in-progress` stays as it is.

## Proof
- Open a PR from `packet/CI-1` to `main`. CI on the PR is the proof: report the run's wall time and each job's time, and show that the
  number of test files executed equals the number before (count from the reachability outputs or the TAP plans, before and after).
- Push one extra commit that touches only a prose file under `docs/` (not `docs/execution/`), and show that it runs only the cheap jobs.
- Then revert that commit.

## STOP (write to the PR description and stop)
Anything that would run fewer test files on a code push, a change to the reachability semantics beyond "one file per shard", a test
that only passes when sharded, or a red you cannot explain.

## Conduct
- Do not run test suites locally; CI is the measurement. You may run `corepack pnpm install --frozen-lockfile`, `corepack pnpm format`,
  `corepack pnpm lint` and YAML or `actionlint` checks if available.
- Never use `pkill`, `killall` or pattern kills. Do not touch other worktrees or the shared directory `/home/rvham/2rain-greenfield`.
- Commit with the trailers `Packet: CI-1` and `Co-Authored-By: Codex gpt-6.2-astra <noreply@openai.com>`. Stage explicit paths.
- Do not merge to `main`. The orchestrator merges after the CI evidence and an independent read.
- Finish with a short report in the PR description and in your final message: the before and after table, the file-count check, the
  docs-only run, and anything you skipped and why.
