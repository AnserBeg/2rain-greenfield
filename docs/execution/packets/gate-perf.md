# gate-perf — isolate compiler timing from contended gates

Date: 2026-08-01
Tier: Behavioral
Status: candidate

## Outcome

The compile-budget test is the sole member of `test:performance`, an
explicitly exclusive producer. It no longer runs late in `test:compiler` after
the compiler suite has loaded the host. The tracked matrix runner executes the
performance producer first, emits `PERFORMANCE_GATE_PASS_SHA=<sha>`, downgrades
its lease to shared, and only then runs the load-tolerant main matrix.

CI has a required performance job. Executed-file evidence records the producer,
and final reachability aggregates that evidence with every main-matrix suite.
An architecture control requires exactly one matrix invocation, so extraction
cannot silently turn into omission.

This rescope deliberately does not claim to repair the timing instrument. The
verdict is restored to the shipped monotonic wall-clock measurement and the
unchanged 5,000 ms budget. Process CPU is emitted as telemetry only. A separate
`gate-instrument` packet owns the unresolved measurement question.

## Restored verdict and fail-closed admission

The real maximum-field compile is measured with `performance.now()`. The budget
assertion reads only `wallMilliseconds`; `cpuMilliseconds` remains in the
diagnostic line and never participates in pass/fail.

Admission now observes current CPU availability directly. The gate reads the
aggregate CPU counters in `/proc/stat`, waits 300 ms, reads them again, and
admits only when at least 90% of elapsed ticks were idle. On an eight-processor
host that refuses the presence of even one fully busy core. Below the floor the
compile does not run and the gate raises `COMPILE_BUDGET_INDETERMINATE`; it never
passes or skips.

Controls observe both refusal modes:

- an injected 89% idle observation refuses before the operation callback runs;
- a real compile paired with a controlled 5,000.1 ms monotonic wall sample is
  rejected with `COMPILE_BUDGET_EXCEEDED`.

The controlled red proves the restored verdict rejects an observed over-budget
duration without sleeping or relying on host load. It does not prove that a
future compiler regression will yield a stable real-host duration; that is the
open `gate-instrument` finding below.

## Lock protocol and bounded waits

`scripts/run-with-test-lock.mjs` is the local lock client over
`/tmp/north-star-matrix.lock`:

- ordinary `test:*` commands and reviewer launches acquire shared access;
- `test:performance` acquires exclusive access;
- the matrix enters exclusively for performance, emits its pass SHA, then
  downgrades to shared for the main matrix;
- nested commands inherit `NORTH_STAR_TEST_LOCK_HELD`, avoiding self-deadlock;
- an unavailable lease fails with `TEST_GATE_LOCK_BUSY` rather than running
  concurrently.

All waits are finite. The shared wrapper, the matrix's initial exclusive lock,
and the compatibility wait for lock-unaware test processes default to 300 s.
The holder-readiness handshake has a separate 5 s deadline. Zero-deadline
negative controls observe both matrix busy paths returning exit 75, and a silent
readiness stream observes the bounded handshake refusal.

The lock is cooperative harnessing, not a security boundary. The architecture
gate proves declared test commands and the binding review launcher participate;
it cannot govern an arbitrary process that deliberately bypasses repository
entry points.

## Instrument findings and direct-idle samples

CPU timing reduced contention sensitivity but did not produce a stable baseline
while the admission signal was the one-minute load average. Ten admitted,
fresh-process samples taken through the exclusive lock were:

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

That population spans 2,373.2–3,068.3 ms CPU. The frozen matrix then admitted
the same compile at load 0.35 and measured 1,851.8 ms CPU, roughly 30% below the
sampled minimum. The discrepancy exposed that one-minute load was a lagging
proxy: it continued reporting prior work after the CPU was idle, including the
timing gate's own earlier samples.

The attempted regression arm was also invalid. Two compiles in one process are
not two cold compiles: the arm consumed 4,892.1 ms CPU in one focused run but
only 3,196.4 ms in the frozen matrix. Against the matrix's 1,851.8 ms single
compile, a literal 2× value is 3,703.6 ms, still below the attempted 3,800 ms
budget. The full matrix correctly failed because the expected red did not fire.

The obsolete load-admission derivation remains historical evidence for Packet
B. Earlier samples appeared to separate cleanly: load 0.10–0.44 produced
1,587.7–1,798.4 ms CPU, while load 0.89–1.43 produced 2,232.2–3,145.4 ms. The
midpoint divided by eight processors produced the normalized 0.08 threshold.
That threshold was not a current-availability observation and is no longer used.

Ten new runs admitted by direct `/proc/stat` observation were:

| Sample | CPU telemetry ms | Wall verdict ms | CPU idle |
|---:|---:|---:|---:|
| 1 | 2,535.5 | 2,044.5 | 99.2% |
| 2 | 2,506.3 | 1,992.0 | 91.2% |
| 3 | 2,490.1 | 1,986.3 | 98.3% |
| 4 | 2,527.3 | 2,065.9 | 98.8% |
| 5 | 2,386.2 | 1,900.1 | 97.9% |
| 6 | 2,358.6 | 1,875.4 | 97.1% |
| 7 | 2,428.5 | 1,956.5 | 96.7% |
| 8 | 2,422.2 | 1,950.2 | 95.5% |
| 9 | 2,263.0 | 1,829.2 | 93.6% |
| 10 | 2,423.4 | 1,916.9 | 97.9% |

The retained ten-sample CPU range is 272.5 ms, or 12.04% of its 2,263.0 ms
minimum. Wall range is 236.7 ms, or 12.94% of its 1,829.2 ms minimum. A separate
pre-batch validation measured CPU 2,859.4 ms and wall 2,238.1 ms at 97.9% idle;
including it still leaves the two numerical constraints compatible. The
conservative CPU anti-flake floor of maximum plus the full observed range is
3,455.8 ms, below twice the fastest baseline at 4,526.0 ms. The corresponding
wall values are 2,647.0 ms and 3,658.4 ms.

The budget question is therefore reopened for Packet B, but not answered here.
The shipped 5,000 ms wall bound remains unchanged, and CPU remains telemetry.
Packet B still owes an independently repeatable cold-regression witness because
the in-process repeated compile remains invalid even though the direct-idle
baseline is materially tighter.

## Scope, review, and limits

No product code, compiler behavior, canonical model, release artifact,
migration, baseline, allowlist, or unrelated budget changed. The Behavioral
review of `0902fe60` passed extraction, fail-closed INDETERMINATE behavior,
non-execution under load, CI invocation, and reachability. Its revision exposed
that CPU-time calibration and the in-process negative control were not honest;
those findings are routed rather than hidden.

Program-review triggers do not fire: this changes one gate harness, not a
product capability, correctness domain, stage boundary, or fan-out point.
