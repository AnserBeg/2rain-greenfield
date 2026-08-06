# arch-race — the architecture suite must not race itself

Lane: BUILD · Base: `4943090` · Tier: Critical.

One line of `package.json`: `test:architecture` gains `--test-concurrency=1`,
matching `test:postgres`. No test, guard, or script behaviour changes.

## The defect, observed rather than quoted

`test:architecture` carried no concurrency pin, so its ten files ran
concurrently — **7 at once, measured**. `repository-hygiene.test.ts:438` shells
out to a nested `scripts/run-matrix.sh`, which runs `leak-guard`'s post-lock
container guard against the real Docker daemon. A sibling file,
`dependency-boundaries.test.ts`, plants real `north-star-leak-guard-*`
PostgreSQL containers as its own fixtures. When the two overlap, the nested
guard sees the sibling's container and refuses.

**The guard is correct and is not touched here.** Noticing that container is its
entire job, and `leak-guard.md` is explicit that it "does not guess that
lock-unaware work is disposable." The defect is that two files which must not
overlap were permitted to.

### The causal step, proven on demand

The spontaneous alignment is load-dependent and did not reproduce on a quiet
host (see *What could not be proven*). The **mechanism** is deterministic and
was proven directly: with one `north-star-*` container alive, the FOREIGN-CONTROL
arm fails every time.

```
not ok 1 - matrix lock and legacy-process waits fail busy at their bounded deadline
  error: |-
    The validation function is expected to return "true". Received false
    Caught error:
    Error: Command failed: bash scripts/run-matrix.sh FOREIGN-CONTROL /home/rvham/2rain-greenfield-arch
    POSTGRES_CONTAINER_CONTAMINATION: refusing to start with north-star-* containers present after exclusive lock acquisition.
      north-star-archrace-probe-34987 age_seconds=6
      docker rm --force north-star-archrace-probe-34987
```

## Why A, and why not B

**Cost of A is 6.7 seconds.** Mean wall time over three runs each, same quiet
host: **24.3 s concurrent → 31.0 s serial**. Against an 11-18 minute matrix that
is well under 1%. The charter said several minutes would argue for B; seven
seconds does not.

**B — targeted mutual exclusion via `run-with-test-lock.mjs` — cannot be built
as described.** That runner short-circuits on inheritance
(`run-with-test-lock.mjs:22-28`): the suite already runs under a *shared* lease,
so a nested `shared` runs unlocked and a nested `exclusive` is refused outright
with `TEST_GATE_LOCK_UPGRADE_REFUSED`. Delivering B means either changing that
runner's semantics — the exact substrate the LOCK-CONTROL tests exist to
verify — or introducing a second parallel mutex beside it.

**And B would need a hand-maintained participant list.** Every file that plants
a `north-star-*` container or runs a nested matrix would have to opt in, and a
future test that forgets to join races silently — which is the failure being
fixed, in the shape this program has repeatedly paid for. A is complete by
construction: with one worker, no two architecture files can overlap at all,
including files not yet written.

A third option — teaching the nested matrix to ignore the sibling's container —
was rejected outright. That is an allowlist addition, which `lanes.md` forbids
without a bridge, and it would make the guard quieter rather than the tests
ordered.

## Controls

| Control | Result |
|---|---|
| the causal step reproduces before the fix | **yes** — planted container, exact text above |
| file concurrency is actually serialized | **observed**, not inferred: max concurrent architecture test files **7 → 1**, sampled from the process table during real runs |
| the suite is green after, three consecutive runs | 116/116, 116/116, 116/116 |
| the guard still refuses a genuinely stranded container | **yes** — planted after the fix, still `POSTGRES_CONTAINER_CONTAMINATION … age_seconds=6`, exit nonzero |
| the nested LOCK-CONTROL still exercises what it did | unchanged — the diff touches no test, no guard, and no script; both `TEST_GATE_LOCK_BUSY` assertions still execute |

The serialization measurement is the load-bearing one. Three green runs prove
little on their own, because the **unfixed** tree also produced nine green runs
on the same host the same day. What changed is not the odds; it is that the
overlap is now impossible.

## What could not be proven

- **The spontaneous race did not reproduce today.** Three quiet full-suite runs,
  three two-file runs, three two-file runs under six-way CPU load, and twelve
  forced-overlap probes were all green. It was observed 3/3 during full matrices
  earlier the same day, including at unmodified `main` in a scratch worktree.
  So the *frequency* is unquantified here; only the mechanism and the fix are
  established.
- **A broader coupling remains open, and this packet does not close it.** That
  test fails on **any** live `north-star-*` container, including one belonging
  to a parallel lane's worktree or a developer's own session. Serializing the
  suite removes the intra-suite race; it does not remove the dependency on
  global host state. A second lane running PostgreSQL tests can still red it.
- **`cycle-pg` is untouched.** That row asks whether `test:postgres`'s serial pin
  is still needed. This packet adds a pin rather than removing one, and the two
  should be weighed together — but nothing here re-measures the PostgreSQL pin.
