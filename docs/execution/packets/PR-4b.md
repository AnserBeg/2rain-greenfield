# PR-4b — Executed-file reachability (dynamic ground truth)

Status: active — implementation and demonstrations complete; full matrix and fresh review pending
Tier: Mechanical
Branch: `packet/pr-4b`
Base: `e17da77221772f007c52be74b975e45ba7523759`
Implementation commits: `8ea8c45f506f3f2a86fdce994fdfda6a0a890e0a`, `ffb6165`
Frozen reviewed candidate: pending
Review: pending — one fresh naive `gpt-5.6-sol` xhigh review

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
| pending | Record doctrine, demonstrations, matrix, and review evidence |

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

Pending. The complete matrix will run serially from a clean tree at the exact
frozen SHA; focused development runs do not substitute for it.

## Review evidence

Pending. One fresh, naive, read-only Codex `gpt-5.6-sol` xhigh review will
receive the exact frozen diff, owned paths, green counts, and the user-supplied
seven-question charter. Any in-class finding follows the packet's explicit
hard tripwire.

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

Pending final SHA and review verdict.

## Checkpoint

Pending the full matrix and fresh scoped review. No program-review trigger
fires: the dual-model G2-P3 review remains current, and PR-4b is a mechanical
gate corrective that closes its assigned runner-evidence seam without adding a
product correctness domain, stage boundary, or fan-out.
