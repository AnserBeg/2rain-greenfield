# gate-perf — the compile budget measures compiler capacity

Status: author candidate; uncommitted by instruction  
Tier: Critical  
Lane: CANON  
Base: `378216ab24d3070128862eeeb5ee67771c0a73e6`

## Outcome

The numeric full-compile objective remains **5,000 ms**. The gate now measures
the minimum of five complete `compileApplication` executions and reports all
five samples as test diagnostics. Scheduler contention is one-sided noise: it
can lengthen an execution, but it cannot make the compiler do less work. A real
compiler regression therefore raises the best sample as well as the others.

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

“Cold” remains load-bearing as the distinction between a complete compile from
normalized bytes and a future incremental or memoized compiler mode. Every
sample creates a fresh `CompilerInput` and invokes the public full compiler
path; the compiler has no persistent cache in that path.

It does not mean a fresh JavaScript process. The established interval begins
immediately before `compileApplication`, after Node startup, module loading,
fixture construction, and normalization. V8 process startup was therefore
never part of the 5,000 ms objective. Reusing the process does not retire work
that the old timer measured by contract; it removes scheduler luck from the
estimator while retaining the cache-cold compiler path.

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
`test/compiler/performance-budget.test.ts:56-57`, which compares
`bestElapsedMilliseconds <= FULL_COMPILE_BUDGET_MILLISECONDS`. Deleting it or
replacing the measured minimum with an unconditional passing value reopens the
vacuity this control catches. The temporary recursive call was removed, and a
clean focused rerun passed with samples
`5266.0, 4278.5, 3439.8, 3991.6, 3307.2` ms. `packages/compiler/**` is clean.

Applied to the motivating numbers, a set containing the observed 3,025 ms
quiet compile passes without changing the budget. A real two-times compiler
regression raises that best case to about 6,050 ms, so all five genuinely
regressed samples remain above 5,000 ms and the repaired gate fails.

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
