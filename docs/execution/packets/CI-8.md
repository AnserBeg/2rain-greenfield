# CI-8 — evidence history, the CI-7 residuals, the evidence reporter count and `pnpm preflight`

Base `5902f0f4cc826d2e1cf1bd023409cb5eb5953f7b` (main). Tier: CI infrastructure, not Critical. No product code changed.

CI tier: full https://github.com/AnserBeg/2rain-greenfield/actions/runs/45666035414

## Rule for every lane: `pnpm preflight` is mandatory before any full-run dispatch

`pnpm preflight` is mandatory before any full-run dispatch (and before any evidence dispatch that follows a code change). It needs no PostgreSQL, runs its steps three at a time and takes about 3 minutes at normal load. It does not stop at the first failure: it runs every step, prints the failing output and, under each failure, the exact command or edit that fixes it, and exits 1 if anything failed. A failure means the full run is not dispatched. Commit first: the expected-red step needs a tracked tree identical to HEAD.

| Step | What it catches | What it prints to fix it |
|---|---|---|
| `format`, `lint` | prettier and eslint on the files this branch changes | the `prettier --write` / `eslint --fix` command with the file list |
| `typecheck` | `tsc` over the repository | the compiler output |
| `language-coverage` | a stale ledger digest in `coverage-decisions.json` (document, any decision, or the observation snapshot) | the current digest and the fresh `observationSnapshot` |
| `schema-snapshot` | a migration changed and `db/schema.snapshot.json` did not (a failure); a release or migration changed and the fresh-tenant replay snapshot did not (a warning) | the regeneration commands |
| `records` | `check-records.sh`: the CI tier line, the record claim against its frozen commits | what the record must contain |
| `app-release` | `check:app-release` | the regeneration command (never hand-merge) |
| `expected-red` | a manifest entry whose text is no longer in its file, or an uncommitted tree | commit first, then fix the entry |
| `hygiene` | `repository-hygiene.test.ts`: unit and architecture inventories, package.json against `reachability-producers.ts`, every PostgreSQL file in exactly one shard | which list to edit, in both files |
| `reachability` | `test-reachability` | same lists |
| `lock-observability` | `test-lock-observability` | the registry or the case named |
| `base` | origin/main or main cannot be found | `git fetch origin main` |
| `surface` | `surface-grammar-conformance`, `surface-runtime-seam`, `surface-data-binding` (SURF rules) | the rule named in the output |
| `ci-evidence` | the workflow and tier pins, and preflight's own pins | the pin named |

What it cannot do: it does not run PostgreSQL, browser or integration suites, so a green preflight is not a green run. It skips one hygiene case, "matrix lock and legacy-process waits", which needs the exclusive test lock and fails whenever a PostgreSQL container or lock is held on the laptop; CI runs it.

### Pending tier marker

A packet record may declare `CI tier: pending quick` or `CI tier: pending full` instead of a run URL, so a lane no longer needs a second docs-only commit after its first dispatch. `scripts/check-record-ci-tier.mjs` accepts the marker only on a `packet/*` branch (`GITHUB_HEAD_REF`, then `GITHUB_REF_NAME`, then the local branch); anywhere else (main, `candidate/*`, a detached merge) it refuses, so the integrator train still requires the real run URL. A record with the marker and a URL line is two declarations and fails. Replace the marker with the URL once the run exists; that is a docs-only change after the tested tip, as before, but no longer a precondition for dispatching.

## Items

1. Evidence controls checked out one commit for most controls, so tests that read git history failed with "the mutated run executed no test". Every control checkout is now `fetch-depth: 0`, pinned in `test/architecture/evidence-on-demand.test.ts`. Proof: `gh workflow run evidence.yml --ref packet/CI-8 -f ref=f5744130f312379f835a08cee4af9e07c1b83150 -f controls=""` ran the 16 CUSTOMIZE-6 controls and all 16 were killed and restored: https://github.com/AnserBeg/2rain-greenfield/actions/runs/45644693609. The same 16 had all failed on run 45638929895.
2. CI-7 residuals 1 to 7: modes `100644`; the dispatch wording in `expected-red-on-demand.mjs` is pinned; the CI-7 record says what CI ran and that the planner-map child exits (now true); the planner-map child calls `process.exit(1)` after the bound error; `closeFixtureApp` prints the unanswered requests by method and URL (`trackFixtureRequests`, called by all three fixtures; it prints, it does not fail); `stop()` code and signal are asserted; the inputs pin matches `inputs.` and the bracket form. Residual 7 (runner variance) needed no change: the CI-7 record already says "margin, not bound".
3. The evidence reporter count. Cause: Node reports a subtest's `file` as the module that called `t.test`. `workflow-consumer.test.ts` calls helper `staff-decision-checks.ts`, whose four subtests therefore arrived under the helper's path, a file that never gets a summary, and the ledger dropped them as the synthetic wrapper. Node counted them under the test file's summary (14 passed), the evidence counted 10, and run 45644816431 marked a killed control failed. Fix: a nested result (nesting above 0) with no summary of its own is credited to the test file whose summary follows it, but only when no other summary-bearing file reported in the same window; a top-level result stays refused, and an ambiguous one stays dropped so reconciliation still refuses by name. Local proof: the unit case in `test/architecture/test-reachability.test.ts` reproduces the shape (own pass plus helper nested pass, then the summary) without PostgreSQL; the real file needs PostgreSQL. NOT PROVED ON THE REAL CONTROL: evidence dispatches https://github.com/AnserBeg/2rain-greenfield/actions/runs/45714097049 and https://github.com/AnserBeg/2rain-greenfield/actions/runs/45728049689 (control workflow-substituted-receipt-scope at bb7259ad, from packet/CI-8) both still reported 11 passed against Node's 15 (mutated phase). The cause is the dispatch, not only the fix: the control job runs the reporter and the expected-red runner from the checked-out REF tree, and bb7259ad has no `ownerOfHelperResult`, so a dispatch from this branch exercises the OLD reporter. Only a ref that contains this packet's `test/helpers/node-reporter-core.mjs` can prove it (the TRAIN-Q integration tip, or a WORKFLOW-2 merge of this branch). A local run of the real file was attempted and could not complete (the first top-level test hit its own timeout on this laptop). To make the next mismatch diagnosable, a reconciliation failure now lists the results the ledger left out (file, nesting, whether the file has its own summary), so one more run names the missing four.
4. `pnpm preflight` and the pending marker (above).

## Rule 8 reds (each restored)

- Control checkout with a name-based `fetch-depth`, or with none: the architecture pin fails.
- `unanswered` list emptied in `closeFixtureApp`: the unit case fails. `stop()` returning `code: 0` or `signal: null`: the fixture-process cases fail. The pin regex narrowed to `inputs.`: the bracket-form case fails. The dispatch sentence reverted: the wording pin fails. `process.exitCode = 1` back in the planner-map child: the source pin fails.
- Pending marker: accepted on `packet/CI-8`, refused on `main`, `candidate/WORKFLOW-2` and `packets/x`; marker plus URL, and `pending soon`, refused.
- Manifest `test/evidence/CI-8.expected-red.json`: 32 entries, all reproduced and restored (`check-expected-red.sh --run`: 30 of 30 before the fix round, then the 3 changed or new entries), validated by `check:expected-red`. Groups: two control-checkout depth entries (fetch-depth 1, name-based); two dispatch-wording entries; three reporter entries (helper not credited, a top-level wrapper credited, an interleaved window credited); four pending-marker entries (accepted off a packet branch, refused on a packet branch, marker plus URL, loose wording); and preflight, one entry per check: migration without snapshot, replay snapshot warning, schema step not failing, failing test names, format, lint, typecheck, language-coverage step, records, app-release, expected-red, hygiene (skip scope and file), reachability, lock-observability (its own step), base lookup (two entries), surface (data binding), ci-evidence (tier pins), and the three language-coverage staleness kinds (document digest, decision digest, observation snapshot), each run against a copy of the real decisions file.

## Rule 17

- Most general form: one full-history checkout for every control; one command that runs every cheap mechanical check and names its fix; one tier line with an explicit pending form.
- Used unchanged: `check-records.sh`, `check-expected-red.sh`, `check:app-release`, the architecture suites, prettier, eslint and `tsc`. Preflight composes them; it adds one script of its own for the language-coverage digest and two git heuristics.
- Narrower, and why: the schema and replay snapshot checks only see that a migration or release changed without its snapshot, because comparing them needs PostgreSQL; the replay-snapshot check only warns, because a release change does not always move the schema. The preflight skips one hygiene case (see above). Preflight takes the base from `origin/main`, so a stale local `origin/main` widens the changed-file list (more files checked, never fewer).

## Evidence

- Full run: https://github.com/AnserBeg/2rain-greenfield/actions/runs/45666035414 on tip 1c1522c1d, green in every job. Later commits add tests and the manifest only (no workflow or script change beyond the `PREFLIGHT_DECISIONS_PATH` test override in `test/helpers/preflight-language-coverage.ts`); the TRAIN-Q integration full covers them.
- Evidence dispatches: 16 of 16 CUSTOMIZE-6 controls killed and restored, https://github.com/AnserBeg/2rain-greenfield/actions/runs/45644693609. Reporter fix on its original failing control (workflow-substituted-receipt-scope at bb7259ad): FAILED twice (https://github.com/AnserBeg/2rain-greenfield/actions/runs/45714097049, https://github.com/AnserBeg/2rain-greenfield/actions/runs/45728049689), because that ref carries the old reporter (see item 3); not a proof. REPORTS-1 s2 controls at d1a4282ce (full-history proof): https://github.com/AnserBeg/2rain-greenfield/actions/runs/45714105734.
- Note on the full run: the first dispatch (45644685639) failed once on `customize-inspection.composed-application.spec.ts` (a 180 s `locator.click` timeout in the Customization rules browser runner, a spec none of this packet's fixtures serve) and, with that job missing, on executed-file reachability. GitHub's rerun endpoint answered HTTP 500 and 502 for about 40 minutes, so the whole workflow was dispatched again on the same tip (45650851098), which passed. That is the one rerun the rules allow.

## Fix round (Fable review)

F1 `dropped()` declared in `node-reporter-core.d.mts`; F2 the zombie test waits (5 s bound) until the child is `Z`; F3 lock observability is its own step with its own remedy; F5 a missing base is a failed `base` step, not a silent skip; modes 100644; pending-marker paragraph corrected. Review ride-alongs 1, 2, 5, 9, 10, 11 and 12 are left for a follow-up.
