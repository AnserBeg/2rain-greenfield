# CI-8 — evidence history, the CI-7 residuals, the evidence reporter count and `pnpm preflight`

Base `5902f0f4cc826d2e1cf1bd023409cb5eb5953f7b` (main). Tier: CI infrastructure, not Critical. No product code changed.

CI tier: pending full

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
| `reachability` | `test-reachability` and `test-lock-observability` | same lists |
| `surface` | `surface-grammar-conformance`, `surface-runtime-seam`, `surface-data-binding` (SURF rules) | the rule named in the output |
| `ci-evidence` | the workflow and tier pins, and preflight's own pins | the pin named |

What it cannot do: it does not run PostgreSQL, browser or integration suites, so a green preflight is not a green run. It skips one hygiene case, "matrix lock and legacy-process waits", which needs the exclusive test lock and fails whenever a PostgreSQL container or lock is held on the laptop; CI runs it.

### Pending tier marker

A packet record may declare `CI tier: pending quick` or `CI tier: pending full` instead of a run URL, so a lane no longer needs a second docs-only commit after its first dispatch. `scripts/check-record-ci-tier.mjs` accepts the marker only on a `packet/*` branch (`GITHUB_HEAD_REF`, then `GITHUB_REF_NAME`, then the local branch); anywhere else (main, `candidate/*`, a detached merge) it refuses, so the integrator train still requires the real run URL. A record with the marker and a URL line is two declarations and fails. Replace the marker with the URL once the run exists; that is a docs-only change after the tested tip, as before, but no longer a precondition for dispatching.

## Items

1. Evidence controls checked out one commit for most controls, so tests that read git history failed with "the mutated run executed no test". Every control checkout is now `fetch-depth: 0`, pinned in `test/architecture/evidence-on-demand.test.ts`. Proof: `gh workflow run evidence.yml --ref packet/CI-8 -f ref=f5744130f312379f835a08cee4af9e07c1b83150 -f controls=""` ran the 16 CUSTOMIZE-6 controls and all 16 were killed and restored: EVIDENCE_RUN_URL. The same 16 had all failed on run 45638929895.
2. CI-7 residuals 1 to 7: modes `100644`; the dispatch wording in `expected-red-on-demand.mjs` is pinned; the CI-7 record says what CI ran and that the planner-map child exits (now true); the planner-map child calls `process.exit(1)` after the bound error; `closeFixtureApp` prints the unanswered requests by method and URL (`trackFixtureRequests`, called by all three fixtures; it prints, it does not fail); `stop()` code and signal are asserted; the inputs pin matches `inputs.` and the bracket form. Residual 7 (runner variance) needed no change: the CI-7 record already says "margin, not bound".
3. The evidence reporter count: REPORTER_FINDING.
4. `pnpm preflight` and the pending marker (above).

## Rule 8 reds (each restored)

- Control checkout with a name-based `fetch-depth`, or with none: the architecture pin fails.
- `unanswered` list emptied in `closeFixtureApp`: the unit case fails. `stop()` returning `code: 0` or `signal: null`: the fixture-process cases fail. The pin regex narrowed to `inputs.`: the bracket-form case fails. The dispatch sentence reverted: the wording pin fails. `process.exitCode = 1` back in the planner-map child: the source pin fails.
- Pending marker: accepted on `packet/CI-8`, refused on `main`, `candidate/WORKFLOW-2` and `packets/x`; marker plus URL, and `pending soon`, refused.
- Preflight: PREFLIGHT_REDS

## Rule 17

- Most general form: one full-history checkout for every control; one command that runs every cheap mechanical check and names its fix; one tier line with an explicit pending form.
- Used unchanged: `check-records.sh`, `check-expected-red.sh`, `check:app-release`, the architecture suites, prettier, eslint and `tsc`. Preflight composes them; it adds one script of its own for the language-coverage digest and two git heuristics.
- Narrower, and why: the schema and replay snapshot checks only see that a migration or release changed without its snapshot, because comparing them needs PostgreSQL; the replay-snapshot check only warns, because a release change does not always move the schema. The preflight skips one hygiene case (see above). Preflight takes the base from `origin/main`, so a stale local `origin/main` widens the changed-file list (more files checked, never fewer).

## Evidence

- Full run: FULL_RUN_NOTE
- Evidence dispatch: EVIDENCE_RUN_URL (16 of 16 controls killed and restored).
- Note on the full run: the first dispatch (45644685639) failed once on `customize-inspection.composed-application.spec.ts` (a 180 s `locator.click` timeout in the Customization rules browser runner, a spec none of this packet's fixtures serve) and, with that job missing, on executed-file reachability. GitHub's rerun endpoint answered HTTP 500 and 502 for about 40 minutes, so the whole workflow was dispatched again on the same tip (45650851098), which passed. That is the one rerun the rules allow.
