# PR-4b — Executed-file reachability (dynamic ground truth)

Status: blocked — full matrix green; fresh review triggered the packet's explicit hard stop
Tier: Mechanical
Branch: `packet/pr-4b`
Base: `e17da77221772f007c52be74b975e45ba7523759`
Implementation commits: `8ea8c45f506f3f2a86fdce994fdfda6a0a890e0a`, `ffb6165`, `3925746`
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
