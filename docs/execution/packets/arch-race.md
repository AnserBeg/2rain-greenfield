# arch-race — the architecture suite must not race itself

Lane: BUILD · Base: `4943090` · Tier: Critical.

One line of `package.json`: `test:architecture` gains `--test-concurrency=1`,
matching `test:postgres`. No script implementation changes — but the one
executable change in this packet **is** a behaviour change: the scheduling
behaviour of the `test:architecture` command, which is the point.

## The defect, observed rather than quoted

`test:architecture` carried no concurrency pin, so its **fifteen** files
(`repository-hygiene.test.ts:80-98`) ran concurrently — **7 at once, measured**.
`dependency-boundaries.test.ts` plants real `north-star-leak-guard-*` PostgreSQL
containers as its own fixtures, via `test/fixtures/postgres-leak-victim.ts`,
which holds a live container across each death-event scenario.

`repository-hygiene.test.ts` shells out to a nested `scripts/run-matrix.sh`
**twice**, and only the second one can reach a container guard:

| Site | Invocation | Lock | Reaches guard? |
|---|---|---|---|
| `:438` | `LOCK-CONTROL` | a holder still owns the lock, so `flock` fails busy — **exit 75** | **no** — it exits before any container guard runs |
| `:464` | `FOREIGN-CONTROL` | the holder has exited, so `flock` **succeeds** | **yes** — the post-lock guard at `run-matrix.sh:42` runs |

So the refusal is at **`:464`, FOREIGN-CONTROL, under the post-lock guard**. It
acquires the lock, the post-lock guard inventories `north-star-*` containers,
sees the sibling file's fixture, and returns **exit 76** — so the
`TEST_GATE_LOCK_BUSY: a lock-unaware test process remained active` that the test
expects never arrives.

**The guard is correct and is not touched here.** Noticing that container is its
entire job, and `leak-guard.md` is explicit that it "does not guess that
lock-unaware work is disposable." The defect is that two files which must not
overlap were permitted to.

### The causal step, proven on demand

The spontaneous alignment is load-dependent and did not reproduce on a quiet
host (see *What could not be proven*). The **mechanism** is deterministic and
was proven directly: with one `north-star-*` container alive at that moment, the
FOREIGN-CONTROL arm fails every time.

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
is **0.62% to 1.02%** — over 1% at the 11-minute end. The charter said several
minutes would argue for B; seven seconds does not.

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
fixed, in the shape this program has repeatedly paid for.

A is complete **within one `test:architecture` invocation**: with one worker, no
two architecture files in that invocation can overlap, including files not yet
written. See the boundary below for what that does not cover.

A third option — teaching the nested matrix to ignore the sibling's container —
was rejected outright. That is an allowlist addition, which `lanes.md` forbids
without a bridge, and it would make the guard quieter rather than the tests
ordered.

## The boundary of the claim

`--test-concurrency=1` removes overlap **within a single `test:architecture`
invocation, and only there**. It does not prevent:

- a **second invocation** of the suite running at the same time;
- a **focused suite** holding its own shared lease concurrently — the lease is
  shared, so several suites legitimately run together;
- **detached host effects outliving a file worker** — a container whose owner
  has exited but whose guardian has not yet removed it.

Anywhere this record says the overlap is impossible, that is the scope meant.

## Controls

| Control | Result |
|---|---|
| the causal step reproduces before the fix | **yes** — planted container, exact text above |
| file concurrency is actually serialized | **observed**, not inferred: max concurrent architecture test files **7 → 1**, sampled from the process table during real runs |
| the suite is green after, three consecutive runs | 116/116, 116/116, 116/116 |
| the guard still refuses a genuinely stranded container | **yes** — planted after the fix, still `POSTGRES_CONTAINER_CONTAMINATION … age_seconds=6`, exit nonzero |
| the nested LOCK-CONTROL still exercises what it did | unchanged — the diff touches no test and no guard; both `TEST_GATE_LOCK_BUSY` assertions still execute |

The serialization measurement is the load-bearing one. Three green runs prove
little on their own, because the **unfixed** tree also produced nine green runs
on the same host the same day. What changed is not the odds; it is that the
overlap within an invocation is now impossible.

## What this trades away

Not only wall time. Pinning the suite serial gives up **whole-suite
parallelism**, and with it any **opportunistic coverage of whether unrelated
architecture files are safe to run concurrently**. Before this change, every
matrix incidentally exercised fifteen files against each other; that incidental
check is gone, and a future concurrency-hostile test can now be added without
anything noticing. This is an execution-policy trade, not a pure cost.

## What could not be proven

- **The spontaneous race did not reproduce today.** Three quiet full-suite runs,
  three two-file runs, three two-file runs under six-way CPU load, and twelve
  forced-overlap probes were all green. It was observed 3/3 during full matrices
  earlier the same day, including at unmodified `main` in a scratch worktree.
  So the *frequency* is unquantified here; only the mechanism and the fix are
  established.
- **A broader coupling remains open, and this packet does not close it.** The
  earlier claim that the test "fails on any live `north-star-*` container" was
  **wrong**. `guard-ephemeral-postgres.mjs` has three distinct behaviours, and
  the residual risk is worse than a red test:

  | Container state | Guard behaviour |
  |---|---|
  | recent, **before** locking | **left alone** for its owning lane (`:29`) |
  | recent, **after** locking | **refused**, exit 76 — the failure this packet ordered around |
  | older than `NORTH_STAR_CONTAINER_STALE_SECONDS` (default **3600 s**) | **force-removed** (`:69`) |

  So a sufficiently old `north-star-*` container belonging to another lane or to
  a developer's own session **is deleted**, not merely complained about. That is
  a deliberate `leak-guard` policy — sweep-old, refuse-recent — and deferring it
  stays correct; describing it falsely did not. Serializing this suite does not
  touch any of it.
- **`cycle-pg` is untouched.** That row asks whether `test:postgres`'s serial pin
  is still needed. This packet adds a pin rather than removing one, and the two
  should be weighed together — but nothing here re-measures the PostgreSQL pin.
