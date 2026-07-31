# gate-perf — the compile budget measures compiler capacity

Status: revision author candidate; prior candidate `d76e6e0`
Tier: Critical  
Lane: CANON  
Base: `378216ab24d3070128862eeeb5ee67771c0a73e6`

## Outcome

The numeric full-compile objective remains **5,000 ms**. The gate now measures
the minimum of five **first invocations**, each in a fresh child process, and
reports all five samples as test diagnostics. Scheduler contention is
one-sided noise: it can lengthen an execution, but it cannot make the compiler
do less work. Process isolation ensures that first-call lazy initialization,
JIT, inline caches, module state, and heap state are present in every sample
rather than only the first.

No dedicated test invocation is added. Serializing the compiler suite is not a
sufficient repair: the historical serial-in-suite measurement was 5,077 ms,
and the independent reproduction for this packet passed close to the boundary
with a 4,678.6 ms test duration. It reduces simultaneous contention but does
not remove sustained-throughput degradation inherited from earlier work.

No calibration ratio is added. A reference workload that shares compiler code
could conceal a common compiler regression by slowing both numerator and
denominator. An unrelated workload would require a new, hardware-specific
conversion ratio with no existing SLO authority. The minimum estimator keeps
the established unit and bound unchanged.

## What “cold” means

“Cold” is load-bearing in two ways: the invocation uses the complete,
non-incremental compiler path, and it is the first invocation in its JavaScript
process. Each child imports the compiler, receives the already-normalized bytes
over IPC, constructs its `CompilerInput`, then starts the monotonic timer
immediately around `compileApplication`. Process startup, module loading,
fixture construction, normalization, IPC, and `compilerInput` setup remain
outside the interval; first-call work performed by `compileApplication`
remains inside it.

**Correction to the first candidate.** It said process reuse did not retire
work the old timer measured because startup and module loading were already
outside the interval. That was false. The old first invocation still measured
lazy V8 compilation, inline-cache initialization, heap state, and any
compiler-local first-call setup. Same-process samples two through five inherited
that state. Fresh input objects and complete re-decoding proved that later
calls still did full compiler work, but they did not make those calls genuine
first invocations. The minimum could therefore select a warm call and hide a
cold-only regression. Fresh child processes preserve the SLO's “one cold
compile” subject for all five samples.

## Independent reproduction

Historical full-matrix logs were inspected rather than rerun, because this
packet is expressly forbidden from running the matrix. They confirm the test
at position 103 and same-SHA failures including 17,672.5 ms and 17,073.1 ms,
alongside a quiet 4,333 ms pass.

Fresh measurements on the packet base produced:

- six consecutive isolated executions: all passed, with test durations from
  4,253 ms through 4,900 ms;
- the ordinary 109-test compiler suite: **failed**, with the measured compile
  at 6,032.0 ms;
- the same suite at `--test-concurrency=1`: **passed**, close to the limit,
  with a 4,678.6 ms test duration; and
- the repaired ordinary compiler suite: **passed 109/109**, with samples
  `7882.4, 4723.1, 4342.2, 3485.2, 4124.5` ms and a 3,485.2 ms minimum.

The exact historical isolated sequence of 9,203 / 6,539 / 5,833 / 7,871 ms
did not recur during this authoring session; the current machine was cooler.
That is not treated as independently re-measured evidence. The reproduced
suite failure, the near-boundary serial result, and the repaired suite's
7,882-to-3,485 ms spread establish the same one-sided-noise defect without
claiming identical samples.

That repaired-suite result belongs to the first, same-process candidate and is
retained as provenance, not as cold-compile evidence. Its full matrix passed at
`d76e6e0` with samples
`2402.8, 1727.5, 1662.4, 1712.4, 1753.4` ms, but review correctly invalidated
the interpretation of samples two through five as cold invocations.

After process isolation, the focused test passed with first-invocation samples
`1675.7, 1335.9, 1376.8, 1464.0, 1505.9` ms. After the new negative control was
removed, it passed with
`1436.5, 1446.5, 1416.8, 1653.6, 1492.5` ms on the final CommonJS-compatible
child-process entrypoint. The ordinary compiler suite also passed **109/109**
with first-invocation samples
`1575.4, 1530.7, 1321.0, 1318.1, 1293.7` ms.

## Negative control — a real regression remains red

The compiler itself was changed temporarily and restored before handoff. At
the entry to `compileApplication`, the control invoked the same complete
compile once with a recursion guard before allowing the measured invocation to
continue. This approximately doubled genuine compiler work rather than adding
test-only delay.

The repaired focused gate failed with samples
`7377.8, 6840.4, 6380.5, 10465.8, 7637.4` ms and the exact assertion:

> best of 5 cold full compiles took 6380.5ms; budget is 5000ms

The victim is the budget assertion at
`test/compiler/performance-budget.test.ts:117-118`, which compares
`bestElapsedMilliseconds <= FULL_COMPILE_BUDGET_MILLISECONDS`. Deleting it or
replacing the measured minimum with an unconditional passing value reopens the
vacuity this control catches. The temporary recursive call was removed, and a
clean focused rerun passed with samples
`5266.0, 4278.5, 3439.8, 3991.6, 3307.2` ms. `packages/compiler/**` is clean.

Applied to the motivating numbers, five isolated cold measurements at the
observed 3,025 ms capacity pass without changing the budget. A real two-times
compiler regression raises each comparable cold sample to about 6,050 ms, so
the repaired gate fails.

## Negative control — a first-invocation-only regression remains red

Review found a distinct vacuity vector that the uniform two-times control did
not isolate: an expensive first call followed by fast warm calls. The compiler
was changed temporarily and restored before handoff. A module-local boolean
made only the first `compileApplication` invocation in each process execute
four additional complete compiles; every later invocation used the ordinary
path.

One same-process five-sample probe observed
`7392.2, 1294.9, 1531.6, 1230.2, 1267.7` ms. The first candidate's minimum
would have selected 1,230.2 ms and passed even though the cold invocation
exceeded the budget. The process-isolated gate observed
`7053.2, 7006.9, 6726.2, 6887.3, 6974.7` ms and failed with:

> best of 5 cold full compiles took 6726.2ms; budget is 5000ms

The isolation victim is the fresh-process call at
`test/compiler/performance-budget.test.ts:97`. Replacing it with direct
same-process invocation reopens the demonstrated false pass. The assertion
victim remains the comparison at lines 117-118; deleting it makes either
regression control vacuous. The temporary compiler mutation was removed and
`packages/compiler/**` is clean.

## Verification boundary

Only focused and compiler-suite checks were run while authoring. No matrix was
started and no commit was created, as instructed. The orchestrator owns
formatting, complete gates, commit, frozen-SHA review, and integration.

## Test it yourself

```bash
cd /home/rvham/2rain-greenfield-gateperf
corepack pnpm test:compiler
```

Expected: 109/109 compiler tests pass. Test 103 prints a
`full-compile-budget` diagnostic with five samples and passes when their
minimum is at most 5,000 ms.
