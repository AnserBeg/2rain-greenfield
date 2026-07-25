# PR-4b — Executed-file reachability (dynamic ground truth)

Status: active — round 2 implementation and demonstrations complete; full matrix and fresh review pending
Tier: Mechanical
Branch: `packet/pr-4b`
Base: `e17da77221772f007c52be74b975e45ba7523759`
Implementation commits: `8ea8c45f506f3f2a86fdce994fdfda6a0a890e0a`, `ffb6165`, `3925746`, `8e4df3d`
Frozen reviewed candidate: `3925746b9057f1b071e046ed4359c75e29a19259`
Review: **REVISE / HARD TRIPWIRE** — one fresh naive `gpt-5.6-sol` xhigh review

## Authority and outcome

PR-4b deletes PR-4's static workflow, package-script, Node-selector, and
Playwright-config inference. `check:reachability` now compares independent
repository discovery with files that successful test runners report having
executed. A file receives credit only after a real non-skipped, non-todo,
non-synthetic result; a command declaration or selected path alone earns
nothing.

Nine declared unfiltered producers cover unit, compiler, integration, agent,
architecture, contracts, PostgreSQL, browser, and observability tests.
`node:test` writes one normalized artifact per suite through a custom reporter
paired with TAP. Playwright retains its list reporter, writes the built-in JSON
report, rejects filtered resolved configuration at reporter time, and
normalizes real non-skipped results into the same evidence shape. Every
artifact records the suite id, declared command, suite success, and per-file
real-result count.

The filtered `test:locale` command intentionally produces no evidence.
`test/postgres/module-runtime.test.ts` is independently credited by the
successful unfiltered `test:postgres` producer. Node reporter arguments are
strictly allowlisted at runtime, and Playwright accepts only its exact declared
CLI arguments plus the default no-grep/no-shard resolved configuration.

The aggregator fails closed on zero discovered files, a missing or empty
artifact, an unsuccessful producer, a producer with zero executed files,
metadata drift, invalid counts, duplicates, any path that is relative,
nonexistent, or outside the repository, and any executed file outside the
discovery rules. It then reports every discovered file absent from the union.
Current local ground truth is 49/49 files from nine artifacts.

The fresh review found a second distinct way for aggregation to report success
without complete current-run evidence. The packet's binding hard tripwire says
not to fix that second instance autonomously. The implementation therefore
remains frozen for an orchestrator design decision; the green matrix below is
evidence about this exact candidate, not an acceptance claim.

## CI and local topology

Each producing job uploads only its declared evidence. The new `reachability`
job needs `quality`, `postgres`, `browser`, and `observability`, has no
`if: always()`, downloads their artifacts, and calls the same root
`check:reachability` entry point used locally. A failed producer therefore
prevents the CI aggregation job from running; a manually invoked local
aggregation rejects the unsuccessful artifact as an independent defense.

The root `test` developer aggregate runs the same local producers, including a
small observability runner backed by the shared declaration, before invoking
the same aggregator. CI retains the required observability inline command.
`repository-hygiene.test.ts` still owns quoted-glob checking, the reviewed
five-suite inventories, and required CI commands. The rewritten reachability
architecture test keeps the root script allowlist and aggregate completeness
checks while adding only shallow producer/job/path assertions; it no longer
infers file selection.

GitHub-side artifact upload/download could not be executed on this host because
`gh` is unavailable. The unverified surface is limited to GitHub Actions'
artifact plumbing. The producer files, normalized contents, shared aggregator,
job dependencies, pinned upload/download actions, and exact local entry point
were all exercised locally; CI contains no comparison or normalization logic.

`test-results/` was already ignored by Git and Prettier before the first
evidence run, so no ignore-file bridge was needed. No dependency, lockfile,
product source, golden file, fixture, or persisted digest changes.

## Commit trail

| Commit | Purpose |
|---|---|
| `8ea8c45` | Replace static inference with reporters, normalized evidence, aggregation, CI artifact topology, and permanent canaries |
| `ffb6165` | Make the root developer aggregate produce observability evidence through the shared declaration |
| `3925746` | Record doctrine and the five required demonstrations before the full matrix and review |
| evidence-only follow-up | Record the green matrix and hard-tripwire review without changing implementation |

## Permanent canaries

`test/architecture/test-reachability.test.ts` exercises the actual reporter and
aggregator helpers:

- a Node file-level synthetic pass where `data.name === data.file` earns no
  credit, as do skipped and todo results, while a real result does;
- a filtered Node invocation is rejected by the reporter argument allowlist,
  and Playwright CLI or resolved-config filtering is rejected by its reporter;
- `test:locale` is both filtered and absent from the producer declaration;
- a pure comparison reports exactly a synthetic unreachable path;
- missing, zero-byte, unsuccessful, zero-file, unnormalizable, and
  executed-but-undiscovered evidence all throw with named failures;
- every declared producer and evidence path appears in its named CI job; and
- the aggregation job needs every producer job, invokes the root entry point,
  and has no `if: always()`.

## Required demonstrations

All demonstrations ran after implementation commit `8ea8c45`, then returned
the committed tree to a clean state. Commit `ffb6165` only made the unchanged
observability producer locally invocable by the root aggregate.

### 1. Real unreachable file, end to end

With temporary `test/orphan-demo/orphan.test.ts` present:

```text
exit_code=1
$ node --import tsx test/helpers/check-reachability.ts
reachability: FAIL
Unreachable test files: test/orphan-demo/orphan.test.ts
[ELIFECYCLE] Command failed with exit code 1.
```

After deleting the file and directory:

```text
$ node --import tsx test/helpers/check-reachability.ts
reachability: PASS (49/49 test files executed; 9 producer artifacts)
git_status_after_orphan=
```

### 2. Filtered command and synthetic file-level pass

A real two-file `node:test` probe ran with
`--test-name-pattern='^matching$'`. The evidence reporter rejected the filtered
producer before it could write valid evidence. The actual credit function then
received Node's nonmatching-file event shape:

```text
filtered_exit_code=7
Error: Filtered or unrecognized node:test argument: --test-name-pattern=^matching$
valid_evidence_bytes=0
synthetic_file_level_pass_credit=NONE
```

The temporary files were deleted, `test:unit` restored its artifact at 27/27,
aggregation returned 49/49, and `git_status_after_filter=` was empty.

### 3. Missing artifact fails closed

After deleting only `test-results/reachability/compiler.json`:

```text
exit_code=1
$ node --import tsx test/helpers/check-reachability.ts
reachability: FAIL
Missing reachability evidence for compiler: test-results/reachability/compiler.json
[ELIFECYCLE] Command failed with exit code 1.
```

`test:compiler` restored the artifact at 49/49; aggregation returned 49/49 and
`git_status_after_missing=` was empty.

### 4. Unnormalizable path fails closed

The contracts artifact's sole path was temporarily replaced with
`/outside/repository.test.ts`:

```text
exit_code=1
$ node --import tsx test/helpers/check-reachability.ts
reachability: FAIL
Unnormalizable executed-file path: /outside/repository.test.ts
[ELIFECYCLE] Command failed with exit code 1.
```

Restoring the exact emitted path returned aggregation to 49/49 and
`git_status_after_path=` was empty.

### 5. Failed suite never yields a green gate

A temporary failing test under the compiler glob made the real producer fail
and still emit an explicitly unsuccessful artifact. Manual aggregation refused
it:

```text
suite_exit_code=1
# Subtest: intentional PR-4b failed-suite canary
not ok 50 - intentional PR-4b failed-suite canary
  error: 'intentional PR-4b suite failure'
# tests 50
# pass 49
# fail 1
[ELIFECYCLE] Command failed with exit code 1.
aggregate_exit_code=1
$ node --import tsx test/helpers/check-reachability.ts
reachability: FAIL
Evidence producer did not succeed: compiler
[ELIFECYCLE] Command failed with exit code 1.
```

In CI the producer job's failure additionally prevents the dependent
reachability job from running. After deleting the temporary file,
`test:compiler` passed 49/49, aggregation returned 49/49, and
`git_status_after_failed_suite=` was empty.

## Retained development reds

The first typecheck exposed four harness wiring errors: Playwright required a
tuple for its custom reporter, root TypeScript compiled the reporter as
CommonJS and rejected `import.meta`, the reporter `onEnd` return needed the
async interface, and parsed evidence needed explicit runner narrowing. After
those fixes, the first `test:unit` reporter load was red with exit 7 because a
TypeScript reporter loaded natively could not resolve
`reachability-evidence.js`. The final Node reporter and its tested core are
therefore native `.mjs`, with no runtime transpilation assumption.

The first lint run was honestly red with seven errors: five missing Node globals
in the `.mjs` reporter and two unused Playwright callback arguments. Explicit
Node imports and narrower callback signatures resolved them. A long combined
development command was also interrupted during PostgreSQL and left its
pre-cleared evidence file empty; parsing failed immediately. A standalone
rerun passed 61/61 and wrote a complete successful artifact.

## Full-matrix evidence on the frozen candidate

The complete matrix ran serially from a clean tree at exact SHA
`3925746b9057f1b071e046ed4359c75e29a19259`:

| Gate | Result |
|---|---|
| frozen install | green; 13 workspace projects, pnpm 11.9.0 |
| format | green |
| lint | green |
| typecheck | green |
| dependency boundaries | green; 93 files checked |
| build | green |
| unit | green; 27/27 |
| compiler | green; 49/49 |
| integration | green; 42/42 |
| agent | green; 1/1 |
| architecture | green; 51/51 |
| demo-release check | green |
| contracts | green; 6/6 |
| schema | green; 9 applied / 9 verified, no drift |
| PostgreSQL | green on the first standalone gate run; 61/61, no retry |
| locale | green; 1/1; intentionally contributes no evidence |
| browser | green; 5/5 |
| observability inline producer | green; 5/5 |
| executed-file reachability | green; 49/49 files from 9 producer artifacts |
| security | green; 206 commits scanned with no leak, plus 1 expected disposable-fixture finding |
| patch and tree cleanliness | green; exact SHA and no tracked or untracked residue |

The successful evidence union comprised: unit 6 files / 27 real results;
compiler 6/49; integration 9/42; agent 1/1; architecture 12/51; contracts
1/6; PostgreSQL 11/61; browser 3/5; and observability 3/5.

## Review evidence

A fresh, naive, read-only Codex `gpt-5.6-sol` xhigh review inspected only the
frozen diff, owned paths, green counts, and the supplied charter. The charter
asked whether: credited files have real results; all named malformed or missing
evidence forms fail closed; only declared unfiltered commands produce evidence
and the declaration is pinned to CI; aggregation waits for every producer and
shares its local entry point; the five demonstrations are genuine and leave no
residue; static inference is removed while the shallow checks remain; and the
diff respects the product/dependency/artifact boundaries. It explicitly barred
a return to static selection inference and required a second distinct
incomplete-evidence false green to be labelled `HARD TRIPWIRE`.

Verdict: **REVISE**, with two material findings and no implementation change:

1. **HARD TRIPWIRE — questions 6 and 7.** At frozen
   `test/architecture/test-reachability.test.ts:372`,
   `parseAggregateScripts()` credits any textual `corepack pnpm <script>`
   occurrence. The accepted honest form `echo corepack pnpm test:compiler`
   satisfies aggregate completeness without executing the compiler producer.
   Because that form does not clear a previous `compiler.json`, stale evidence
   can let local aggregation report success without current-run compiler
   evidence. The reviewer classified this as the second distinct false-green
   form after the already-handled synthetic Node file event and explicitly
   invoked the hard tripwire.
2. **Question 3.** At frozen
   `test/helpers/reachability-producers.ts:41`, observability's
   `ciInvocation` names only its suite-id marker, while the special case at
   `test/architecture/test-reachability.test.ts:201` skips exact command-body
   verification. An honest edit can omit a positional observability file from
   `.github/workflows/ci.yml:208` while retaining the declared command metadata.
   Since those files overlap other producers, union aggregation can remain
   green while that producer has drifted.

The review passed questions 1, 2, 4, and 5 otherwise. It confirmed that static
selection inference was removed, the quoted-glob and five-suite inventory
assertions remain intact, no demonstration residue exists, and no dependency,
product source, golden, fixture, digest, or unowned path moved. Per the binding
tripwire, neither finding was patched and no re-review was launched.

## Test it yourself

From a checkout of the candidate, the following takes under ten minutes and
directly falsifies the central claim without GitHub:

```bash
cd /home/rvham/2rain-greenfield
corepack pnpm test
mkdir -p test/orphan-demo
printf "import test from 'node:test';\ntest('throwaway orphan', () => {});\n" > test/orphan-demo/orphan.test.ts
! corepack pnpm check:reachability
rm test/orphan-demo/orphan.test.ts
rmdir test/orphan-demo
corepack pnpm check:reachability
```

The aggregate `test` run must end with
`reachability: PASS (49/49 test files executed; 9 producer artifacts)`. The
first standalone reachability command must be red and name exactly
`test/orphan-demo/orphan.test.ts`; after deletion it must return to 49/49.

## Draft ledger row (do not commit to `ledger.md`)

```text
| PR-4b | Executed-file reachability (dynamic ground truth) | G2 corrective | Mechanical | blocked | `3925746b9057f1b071e046ed4359c75e29a19259` | [packet](packets/PR-4b.md); full local matrix green at the frozen candidate, but the fresh Codex xhigh review found a second distinct incomplete-evidence false green and triggered the packet's binding hard stop. Awaiting user design decision; not acceptance-ready. |
```

## Checkpoint

Stopped at the explicit hard tripwire with the implementation frozen and both
findings recorded. No program-review trigger fires: the dual-model G2-P3 review
remains current, and this mechanical gate corrective adds no product
correctness domain, stage boundary, or fan-out. PR-4b is not acceptance-ready
until the user rules on the false-green design seam.

## Round 2 — bind evidence to the run

The orchestrator adjudicated round 1's two findings against the code and ruled
that its hard tripwire had not fired: multiple findings in the same review
count as one round, and round 2 is the one authorized in-class fix. Round 1's
implementation, five demonstrations, matrix, and review remain unchanged
above. This section records only the bounded continuation from branch base
`6556002bd70b89a0921f8096e1e566872f980916`.

### Freshness is now the guarantee

`begin-reachability-run.ts` starts one token per local aggregate. It uses the
workflow-provided `REACHABILITY_RUN_ID` when present; otherwise it generates a
token and persists it at ignored path `test-results/reachability/run-id`.
Every producer prepare step resolves that token, so standalone suite commands
reuse the last orchestrated run or create a token only when none exists. The CI
workflow sets `${{ github.run_id }}-${{ github.run_attempt }}` globally and
begins the same token in every producer and aggregation job.

Version-2 evidence carries `runId` and observed runner `argv`. The Node reporter
records `process.argv.slice(1)` rather than the removed
`REACHABILITY_COMMAND` self-assertion. The Playwright reporter records its
observed arguments in a token-bound sidecar, which the normalizer carries into
the final evidence. Aggregation resolves the current token first and rejects a
missing token field, a stale token, an unresolvable current token, or argv that
differs from the producer declaration before crediting any file.

The root aggregate's script inventory now matches complete `&&`-separated
`corepack pnpm <script>` segments, so inert text such as
`echo corepack pnpm test:compiler` earns no convenience credit. That scan is
explicitly **not** the safety guarantee and remains order-insensitive by
design. Freshness tokens make skipped, echoed, conditionally unreached,
deleted, or reordered producers fail regardless of what the text scan says.

The observability CI job now calls
`test/helpers/run-observability-producer.ts`, making
`observabilityTestFiles` its only executable file-list source. The prior
observability exemption in the declaration gate is gone. The authorized bridge
`test/integration/observability-ci-contract.test.ts` replaces its three inline
workflow-path assertions with two stronger checks: CI must invoke the helper,
and the shared declaration must equal the reviewed three-file inventory. Its
existing job ordering, TAP path, artifact, and `if: always()` assertions remain
unchanged.

The workflow still pipes the helper through
`tee test-results/observability/tests.tap`. The exact Actions-style
`bash --noprofile --norc -eo pipefail` form returned exit 1 when an invalid run
token made the helper fail, then returned 5/5 after restoration. The helper's
exit therefore propagates through `tee`, while the retained TAP artifact is
still produced.

GitHub-side artifact upload/download remains unverified because `gh` is not
available. As in round 1, YAML contains only token plumbing and calls the shared
entry points; all token resolution, observation, normalization, and comparison
logic was executed locally.

### Round 2 development reds

The first focused format check was red on the edited architecture test and new
run helper; repository Prettier resolved it. The next typecheck was red because
`exactOptionalPropertyTypes` rejected explicitly passing an undefined
environment; constructing the resolver context conditionally fixed it. The
next lint was red on three unbound `process` references in native `.mjs`;
importing `node:process` fixed them.

The first observability run after deleting the inline workflow list was red at
4/5 because `test/integration/observability-ci-contract.test.ts:11-15` still
pinned those inline paths. Work stopped for the required bridge; the user
authorized the reviewed-inventory replacement described above, after which the
suite passed 5/5. A first aggregate capture piped through plain local `tee`
without `pipefail`; the output stream was interrupted, the capture command
returned zero, and PostgreSQL evidence was empty. Standalone aggregation
correctly failed with `Empty reachability evidence for postgres`. The
authoritative rerun redirected output instead, returned the actual aggregate
exit code, passed PostgreSQL 61/61, and ended at 49/49.

### Round 2 required demonstrations

All four demonstrations ran against implementation commit `8e4df3d` and
returned the tracked and untracked tree to clean state.

#### 1. Stale artifact is rejected

Starting from a complete 49/49 run, a fresh token was begun and every producer
except compiler was rerun:

```bash
node --import tsx test/helpers/begin-reachability-run.ts
corepack pnpm test:unit
corepack pnpm test:integration
corepack pnpm test:agent
corepack pnpm test:architecture
corepack pnpm test:contracts
corepack pnpm test:postgres
corepack pnpm test:browser
node --import tsx test/helpers/run-observability-producer.ts
corepack pnpm check:reachability
```

The real failure named compiler and both tokens:

```text
previous_run=182a0c0b-b1a3-4927-9efb-bddad85fbd32
current_run=5b6a26f4-8068-4421-99e7-208a205625b7
red_exit=1
$ node --import tsx test/helpers/check-reachability.ts
reachability: FAIL
Stale reachability evidence for compiler: expected run 5b6a26f4-8068-4421-99e7-208a205625b7, received 182a0c0b-b1a3-4927-9efb-bddad85fbd32
[ELIFECYCLE] Command failed with exit code 1.
```

`corepack pnpm test:compiler` then stamped the current token and standalone
aggregation returned `PASS (49/49 test files executed; 9 producer artifacts)`.
`git_status_after_stale=` was empty.

#### 2. Reordering is caught

The compiler segment was temporarily moved from before integration to after
`check:reachability` in the root `test` script. No script was deleted, and the
order-insensitive aggregate convenience assertion passed at architecture
51/51. Running the exact aggregate was nevertheless red before compiler could
execute:

```text
$ corepack pnpm test
reachability run: 497a9e22-606b-41e3-8882-1affac36767e
# tests 51
# pass 51
reachability: FAIL
Stale reachability evidence for compiler: expected run 497a9e22-606b-41e3-8882-1affac36767e, received 5b6a26f4-8068-4421-99e7-208a205625b7
[ELIFECYCLE] Command failed with exit code 1.
[ELIFECYCLE] Test failed. See above for more details.
```

After restoring the exact script, `corepack pnpm test` passed PostgreSQL 61/61,
browser 5/5, and reachability 49/49 under fresh token
`e2980567-4f2f-4f95-a2be-c613ef9b0f5a`; `git_status_after_reorder=` was empty.

#### 3. Observed-argv mismatch is caught

Only the ignored unit artifact's first stamped argument was temporarily changed
from `diagnostic-ordering.test.ts` to
`not-the-declared-command.test.ts`. Standalone aggregation returned:

```text
argv_mismatch_exit=1
$ node --import tsx test/helpers/check-reachability.ts
reachability: FAIL
Observed argv mismatch for unit: expected ["test/unit/canonical-model/diagnostic-ordering.test.ts","test/unit/canonical-model/negative-contracts.test.ts","test/unit/canonical-model/normalization.test.ts","test/unit/observability.test.ts","test/unit/party-definition.test.ts","test/unit/workspace-contract.test.ts"], received ["test/unit/canonical-model/not-the-declared-command.test.ts","test/unit/canonical-model/negative-contracts.test.ts","test/unit/canonical-model/normalization.test.ts","test/unit/observability.test.ts","test/unit/party-definition.test.ts","test/unit/workspace-contract.test.ts"]
[ELIFECYCLE] Command failed with exit code 1.
```

`corepack pnpm test:unit` restored observed evidence, aggregation returned
49/49, and `git_status_after_argv=` was empty.

#### 4. Standalone flows still work

With the last complete run persisted, the two entry points were invoked
independently:

```text
$ corepack pnpm test:unit
standalone_unit_exit=0
run_before=e2980567-4f2f-4f95-a2be-c613ef9b0f5a
run_after=e2980567-4f2f-4f95-a2be-c613ef9b0f5a
# tests 27
# pass 27
# fail 0
$ corepack pnpm check:reachability
reachability: PASS (49/49 test files executed; 9 producer artifacts)
git_status_after_standalone=
```

### Round 2 full-matrix evidence

Pending at the new frozen candidate.

### Round 2 review evidence

The first fresh naive read-only `gpt-5.6-sol` xhigh review ran against frozen
candidate `3657533d1aede40fa9afbc46ff7fdc8e8ad781a1` and returned **REVISE**
with one material question-6 finding. At
`test/architecture/test-reachability.test.ts:240`, the declaration check had
regressed from requiring each Node producer's exact suite id to accepting any
`REACHABILITY_SUITE_ID` assignment. The runtime aggregator still rejected a
wrong suite id, so the reviewer explicitly classified the finding outside the
hard-tripwire class and passed questions 1-5 otherwise.

Disposition: **fixed**. Script-backed producers again require the literal
declared id. The helper-backed observability producer must both resolve its
exact declared id and assign `producer.id`, retaining the single-source design.
A fresh re-review is pending at the replacement candidate. Any
incomplete-current-run false green remains an immediate hard stop.

### Round 2 test it yourself

From the candidate, this exercises both stale-token rejection and the retained
real-file completeness proof in under ten minutes:

```bash
cd /home/rvham/2rain-greenfield
corepack pnpm test
node --import tsx test/helpers/begin-reachability-run.ts
! corepack pnpm check:reachability
corepack pnpm test
mkdir -p test/orphan-demo
printf "import test from 'node:test';\ntest('throwaway orphan', () => {});\n" > test/orphan-demo/orphan.test.ts
! corepack pnpm check:reachability
rm test/orphan-demo/orphan.test.ts
rmdir test/orphan-demo
corepack pnpm check:reachability
```

The first red must name stale evidence from the prior token. After the second
full run, the orphan red must name exactly
`test/orphan-demo/orphan.test.ts`; deleting it must return aggregation to
49/49.
