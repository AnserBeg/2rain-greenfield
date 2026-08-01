# gate-perf — honest compiler budget measurement

Date: 2026-07-31
Tier: Behavioral
Status: candidate

## Outcome

The unchanged 5,000 ms full-compile budget measures process CPU rather than
elapsed wall time. The timing test is no longer part of `test:compiler`; it is
the sole member of `test:performance`, an explicitly exclusive producer with
its own CI job and executed-file evidence.

The tracked matrix runner executes the exclusive producer first, records
`PERFORMANCE_GATE_PASS_SHA=<sha>`, downgrades its lease to shared, then runs the
main matrix without the timing file. A second matrix remains queued because it
requires exclusive entry, while load-tolerant focused suites and reviews can
proceed. Final reachability aggregates the performance evidence with every main
matrix producer, so omitting the separated gate is a hard failure rather than
an invisible scheduling convention.

## Instrument

`process.cpuUsage()` measures user plus system CPU consumed during the one
`compileApplication` call. Wall time is emitted as telemetry only and never
participates in the verdict. The budget remains exactly 5,000 ms.

The host is measurable only when the one-minute load average is at most 0.50
per `availableParallelism()` processor, sampled immediately before the timed
operation so the compiler cannot make its own regression indeterminate by
raising the load average. On this eight-processor host that is 4.00: a
moderately loaded 2.15 sample remained safely measurable, while an observed
4.50 sample was refused. A first 2.00 threshold also refused an otherwise idle
runner at 2.42 immediately after test startup, so it did not provide a usable
observation window. Above 0.50 per processor the gate fails with
`COMPILE_BUDGET_INDETERMINATE` and reports no CPU-budget verdict.

Three controls make the outcomes observable:

- the real maximum-field compile must pass the unchanged budget;
- an injected over-threshold load sample refuses before the operation runs;
- four real cold compiles under the unchanged single-compile budget fail with
  `COMPILE_BUDGET_EXCEEDED`. Removing the extra compile loop reopens that red.

The injected-load control observes the exact final threshold of 4.00, refuses
at 4.01 with `COMPILE_BUDGET_INDETERMINATE`, and proves the compile callback did
not run.

## Lock protocol

`scripts/run-with-test-lock.mjs` is the single local lock client over
`/tmp/north-star-matrix.lock`:

- ordinary `test:*` commands and reviewer launches acquire shared access;
- `test:performance` acquires exclusive access; `scripts/run-matrix.sh` enters
  exclusively for that gate, then downgrades to shared for the main matrix;
- nested commands inherit the current `NORTH_STAR_TEST_LOCK_HELD`, so the
  matrix cannot deadlock itself;
- a lease unavailable for the configured wait fails with
  `TEST_GATE_LOCK_BUSY` rather than running concurrently.

The architecture control holds one shared lease, observes another shared
command complete, observes an exclusive command refused, releases the holder,
then observes the exclusive command complete. This is event-driven and uses no
sleep-based timing assertion.

## Measurements

The prompt's wall-clock baseline for the same maximum-field compile was
2,903–3,165 ms quiet and 5,993 ms loaded on one branch, and 3,787–4,779 ms quiet
and 5,798 ms loaded on another.

This packet observed:

| Condition | Process CPU | Wall telemetry | Load average |
|---|---:|---:|---:|
| quiet exclusive gate | 1,931.5 ms | 1,523.5 ms | 1.68 |
| four controlled CPU workers | 2,801.1 ms | 2,593.8 ms | 2.15 → 2.70 |

CPU spread was 45%, versus 70% wall spread. At observed load 4.50 the gate
refused as indeterminate, so system saturation produces no numeric verdict.

## Scope and limits

No compiler, canonical model, release artifact, product behavior, budget,
baseline, migration, or allowlist changed. The local lock is cooperative CI
harnessing, not a security boundary: commands that deliberately bypass the
repository entry points can still contend. The architecture gate proves every
declared test command and the binding review skill use the wrapper; it cannot
govern arbitrary raw processes.

Program-review triggers do not fire: this changes one gate instrument and its
harness, not a product capability, correctness domain, stage boundary, or
fan-out point.
