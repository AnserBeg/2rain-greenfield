# gate-perf — honest compiler budget measurement

Date: 2026-07-31
Tier: Behavioral
Status: candidate

## Outcome

The full-compile budget measures process CPU rather than elapsed wall time. The
timing test is no longer part of `test:compiler`; it is the sole member of
`test:performance`, an explicitly exclusive producer with its own CI job and
executed-file evidence.

The tracked matrix runner executes the exclusive producer first, records
`PERFORMANCE_GATE_PASS_SHA=<sha>`, downgrades its lease to shared, then runs the
main matrix without the timing file. A second matrix remains queued because it
requires exclusive entry, while load-tolerant focused suites and reviews can
proceed. Final reachability aggregates the performance evidence with every main
matrix producer, so omitting the separated gate is a hard failure rather than
an invisible scheduling convention.

## Instrument and derived bounds

`process.cpuUsage()` measures user plus system CPU consumed during the one
`compileApplication` call. Wall time is emitted as telemetry only and never
participates in the verdict. The derived CPU-time budget is 3,800 ms.

The host is measurable only when the one-minute load average is at most 0.08
per `availableParallelism()` processor. The first review used 0.50, or 4.00 on
this eight-processor host, and admitted a visibly degraded population beginning
at load 0.89. The prior tight population ended at 0.44. Their midpoint is 0.665;
normalizing by eight gives 0.083125. Rounding down to 0.08 derives a 0.64 host
threshold, leaving 0.20 above the prior quiet maximum and refusing the earlier
degraded population. Above it the gate fails with
`COMPILE_BUDGET_INDETERMINATE` and reports no CPU-budget verdict.

Ten fresh-process samples were then collected through the actual exclusive lock
with no overlapping matrix or test process:

| Sample | CPU ms | Wall telemetry ms | Load |
|---:|---:|---:|---:|
| 1 | 3,068.3 | 2,432.2 | 0.24 |
| 2 | 2,494.5 | 2,008.9 | 0.30 |
| 3 | 2,612.7 | 2,066.7 | 0.36 |
| 4 | 2,373.2 | 1,929.5 | 0.41 |
| 5 | 2,415.2 | 1,885.3 | 0.41 |
| 6 | 2,505.3 | 2,041.5 | 0.46 |
| 7 | 2,383.1 | 1,896.2 | 0.58 |
| 8 | 2,436.2 | 1,927.4 | 0.46 |
| 9 | 2,564.6 | 2,046.4 | 0.54 |
| 10 | 2,681.5 | 2,037.4 | 0.49 |

The CPU minimum is 2,373.2 ms, median 2,499.9 ms, maximum 3,068.3 ms,
and range 695.1 ms (29.29% of the minimum). The anti-flake floor is the maximum
plus one full observed range: 3,763.4 ms. Rounding that floor up to the next 100
ms derives the 3,800 ms budget and leaves 731.7 ms, or 23.85%, above the
observed maximum. Constraint (a), quiet-noise margin, binds. Constraint (b)
remains looser: twice even the fastest admitted baseline is 4,746.4 ms, 946.4
ms above the budget. The focused two-compile control used 4,892.1 ms CPU and was
rejected, 1,092.1 ms over the budget.

Three controls make the outcomes observable:

- the real maximum-field compile must pass the derived budget;
- an injected over-threshold load sample refuses before the operation runs;
- two real cold compiles under the single-compile budget fail with
  `COMPILE_BUDGET_EXCEEDED`. Removing the extra compile reopens that red.

The real gate uses the host load. The two-compile negative control injects an
admitted load sample of zero while retaining the real CPU clock and real
compiler calls. This keeps the regression red observable even when the positive
test raises the one-minute average before the control runs; it cannot make the
production verdict green.

## Self-load interaction

The one-minute load average deliberately makes recent work visible after the
process exits. Repeated calibration crossed the new fence: after eight admitted
exclusive samples, the next attempt observed 0.74 and failed
`COMPILE_BUDGET_INDETERMINATE`. Earlier, six consecutive attempts crossed at
0.65. No compile ran in those attempts. The average remained elevated for
several minutes despite no test process, so a re-run may require a quiet decay
window.

Test-runner startup can also move a near-threshold external sample: one focused
run started after `/proc/loadavg` reported 0.40 but the instrument observed 0.66
and refused before compiling. Callers must treat the instrument's own sample as
authoritative; a pre-run shell sample is only scheduling guidance.

That cost is accepted. Indeterminate is a typed fail-closed result, not a pass,
skip, or budget verdict. Raising the threshold to make back-to-back runs
convenient would re-admit the degraded population and undo the instrument.

A discarded five-sample batch is not part of the derivation: KERNEL began a
legacy, lock-unaware matrix after the precheck while the calibration command had
bypassed the wrapper. The overlap was discovered, the values were rejected, and
all ten recorded samples above were rerun through the exclusive lock.

## Lock protocol and bounded waits

`scripts/run-with-test-lock.mjs` is the single local lock client over
`/tmp/north-star-matrix.lock`:

- ordinary `test:*` commands and reviewer launches acquire shared access;
- `test:performance` acquires exclusive access; `scripts/run-matrix.sh` enters
  exclusively for that gate, then downgrades to shared for the main matrix;
- nested commands inherit the current `NORTH_STAR_TEST_LOCK_HELD`, so the
  matrix cannot deadlock itself;
- a lease unavailable for the configured wait fails with
  `TEST_GATE_LOCK_BUSY` rather than running concurrently.

The shared wrapper, the matrix's initial exclusive acquisition, and its
compatibility wait for lock-unaware processes all default to a finite 300 s
deadline controlled by `NORTH_STAR_TEST_LOCK_TIMEOUT_SECONDS`. The compatibility
poll is one second, so it cannot overrun the configured whole-second deadline.
The test holder's readiness handshake has a separate 5 s deadline.

Executed controls hold one shared lease, observe another shared command
complete, observe an exclusive command refused, release the holder, and then
observe exclusive admission. Additional zero-deadline controls observe both
matrix busy paths return `TEST_GATE_LOCK_BUSY`; a silent readiness stream
separately observes its bounded refusal.

## Earlier calibration evidence

The prompt's wall-clock baseline for the same maximum-field compile was
2,903–3,165 ms quiet and 5,993 ms loaded on one branch, and 3,787–4,779 ms quiet
and 5,798 ms loaded on another.

The first CPU implementation observed 1,931.5 ms quiet and 2,801.1 ms with four
controlled CPU workers. CPU spread was 45%, versus 70% wall spread. A 4.50 load
sample refused as indeterminate. Review round 1 then correctly found that
retaining the old 5,000 ms wall-time numeral silently weakened the CPU-time
gate, which prompted the threshold and budget calibration above.

## Scope, review, and limits

No compiler, canonical model, release artifact, product behavior, baseline,
migration, allowlist, or unrelated budget changed. The local lock is cooperative
CI harnessing, not a security boundary: commands that deliberately bypass the
repository entry points can still contend. The architecture gate proves every
declared test command and the binding review skill use the wrapper; it cannot
govern arbitrary raw processes.

The Behavioral review of `0902fe60` returned REVISE on the wall-calibrated
numeral and the unbounded waits. Its other four questions passed and were not
revisited. This revision addresses only those two findings; a fresh review is
required on the new frozen SHA.

Program-review triggers do not fire: this changes one gate instrument and its
harness, not a product capability, correctness domain, stage boundary, or
fan-out point.
