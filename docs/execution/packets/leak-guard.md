# leak-guard — keep PostgreSQL harnesses and the performance gate determinate

Date: 2026-08-02  
Tier: Behavioral  
Status: candidate  
Base: `2db00aa41299a4dec5e8ede13250897d270f733d`

## Goal and incident

Six PostgreSQL containers whose intended lifetime was seconds survived killed
test harnesses for up to two days. Every later matrix contended with them on an
8 GB WSL host, candidates that were green on a cleaned host returned
indeterminate, and the affected lanes stopped making progress. A second live
signal remained after cleanup: the performance admission sample measured 85.4%
idle against the unchanged 90% floor before a quiet retry admitted at 93.7%.

This packet makes that environmental failure observable and bounded. It changes
test harnesses and gate scripts only; no product source, compiler behavior,
release output, Docker daemon configuration, lock semantics, CPU-idle floor, or
5,000 ms compile budget changes.

## Owned paths and runnable exit

- `test/helpers/postgres.ts`
- `test/helpers/postgres-container-guardian.mjs`
- `test/fixtures/postgres-leak-victim.ts`
- `test/architecture/dependency-boundaries.test.ts`
- `test/compiler/performance-budget.test.ts`
- `scripts/guard-ephemeral-postgres.mjs`
- `scripts/run-matrix.sh`, limited to the container guard before and after lock
  acquisition
- `docs/execution/packets/leak-guard.md`
- `learnings.md`, add-only

The existing `packet/5g3-langgate` branch also adds one load-tolerant command to
`scripts/run-matrix.sh`. Its hunk and concern are disjoint and are neither copied
nor changed here. The runnable exit is the existing full matrix with a clean
PostgreSQL host, an unchanged lock protocol, and an unchanged numeric performance
bar.

## Cleanup that survives its owner

`withEphemeralPostgres` starts a detached guardian and waits for its ready
handshake before asking Docker to create the container. The guardian records both
the harness PID and its `/proc/<pid>/stat` start ticks, plus the same identity for
the harness parent. Comparing both values prevents PID reuse from making a dead
owner look live.

The normal `finally` path still closes the pool and force-removes the container.
It now attempts both independently, so a pool-close error cannot skip Docker
cleanup. The guardian is the abnormal-death path: if the harness, its parent, or
both disappear, it independently runs `docker rm --force` and confirms the
container is absent. A failed normal removal signals that same guardian to clean
up immediately. `--rm` remains useful after PostgreSQL exits, but it is no longer
the mechanism credited for host-process death.

The execution control enters the real helper, observes a running container with
an independent `docker inspect`, sends the named death event, and again reads
Docker state independently. The following paths all reached removal:

| Death event | Observed result |
|---|---|
| `kill -9` of the harness | owner exited on `SIGKILL`; Docker reported no such object |
| `SIGINT` | owner exited on `SIGINT`; Docker reported no such object |
| `SIGTERM` | owner exited on `SIGTERM`; Docker reported no such object |
| uncaught exception | owner exited `1`; Docker reported no such object |
| `kill -9` of the harness parent | worker remained addressable long enough to prove the parent identity changed; Docker reported no such object |

The baseline helper's exact `kill -9` control was red before the guardian:
`container survived its owner:
north-star-leak-guard-victim-77262-04c8ed5b`. The test's independent cleanup ran
only after that assertion, so it could not repair the subject before measuring
it.

## Safe contaminated-host policy

`run-matrix.sh` now inventories `north-star-*` containers before attempting the
matrix lock. It fails closed if Docker is unavailable or returns an unrecognized
row. The default stale threshold is 3,600 seconds. A container older than one
hour is far beyond the repository's seconds-to-minutes harness lifetime and is
force-removed with a confirming inspect. A recent container is left untouched,
because before lock acquisition it can belong to the other legitimate lane.

After exclusive lock acquisition the runner repeats the inventory, allowing a
bounded 20 × 100 ms guardian-settle window. A lock-aware concurrent harness must
have ended before this point. If a recent container nevertheless remains, the
matrix exits 76 with `POSTGRES_CONTAINER_CONTAMINATION`, the exact container age,
and an exact `docker rm --force <name>` command. It does not guess that
lock-unaware work is disposable.

This is deliberately sweep-old/refuse-recent rather than sweep-all. It removes
the incident's certainly stranded containers without destroying a live second
lane. The wall-derived Docker creation age is used only for the conservative
one-hour classification; a backward clock sample clamps to age zero and therefore
biases toward refusal, never deletion.

Three real-Docker controls observe the policy:

- a planted container presented as stale is actually removed before a held lock
  returns the expected exit 75;
- a planted recent container remains running while another process holds the
  lock; and
- a planted recent container present after exclusive acquisition produces exit
  76, names itself and the removal command, and remains running until the test's
  independent final cleanup.

Before implementation, the stale control found no sweep output and the planted
container survived; the post-lock control returned the old foreign-process exit
75 where exit 76 was required. A separate malformed inventory row now produces
the underlying red `POSTGRES_CONTAINER_GUARD_FAILED: unrecognized docker ps row`
with exit 74.

## Fresh-process best-of-five performance sample

The parked `archive/packet-gate-perf` commits were read, not merged. Two ideas
survive current-main scrutiny:

1. each sample times the first `compileApplication` invocation in a distinct
   child process, preserving the cold-compile contract; and
2. the minimum of five cold wall samples estimates available compiler capacity,
   because scheduler contention can lengthen but cannot make the compiler do
   less work.

The direct 300 ms `/proc/stat` admission check remains first and unchanged at
90% idle. Below it, collection does not run and the verdict is indeterminate.
Above it, five sequential children each report PID, invocation count, CPU
telemetry, wall verdict, and compile status. The gate requires five well-formed
successful samples, five distinct PIDs, and invocation count one for every
sample. It reports every value; only the best wall sample is compared with the
unchanged 5,000 ms budget.

The focused real run admitted at 97.5% idle, a +7.5 percentage-point margin, and
measured wall samples `2058.4, 1853.9, 1926.5, 1923.7, 1935.3` ms. The best was
1,853.9 ms. CPU telemetry was
`2536.5, 2310.2, 2378.5, 2421.8, 2413.0` ms. An immediately preceding run
observed 80.8% idle, a -9.2-point margin, and correctly returned
`COMPILE_BUDGET_INDETERMINATE` without collecting samples. The admission-margin
change is host state, not a claimed code improvement; the sampling change starts
only after admission.

The controlled before/after is exact: under the old single-sample verdict a
5,250.0 ms noisy first sample is `FAIL`; the new five-sample set has a 4,000.0 ms
best and is `PASS`. Five uniformly slow samples retain a 5,100.0 ms best and
produce `COMPILE_BUDGET_EXCEEDED`. Zero samples produce
`COMPILE_BUDGET_SAMPLE_COUNT_INVALID`; a `NaN` duration produces
`COMPILE_BUDGET_SAMPLE_INVALID`.

## Vacuity vectors and retained reds

| Vacuity vector | Independent control | Recorded red |
|---|---|---|
| Subject absent entirely | The victim must emit a container marker, and `docker inspect` must report `running`, before any death signal. | A broken victim exited before the marker and the control refused before claiming cleanup. |
| Check reads zero subjects | The stale-host control plants and inspects one real container before invoking the matrix runner. | Baseline runner emitted no sweep and the planted container survived the assertion. |
| Proxy says clean while Docker is not | Cleanup verdict reads Docker after owner death; it does not parse guardian output or trust `--rm`. | Baseline `kill -9` left the named container running and raised `container survived its owner`. |
| Output shape is unrecognized | Fake Docker emits a non-row to the production parser. | Guard exits 74 with `unrecognized docker ps row`. |
| Subject is repaired before measurement | Guardian/helper cleanup and verifier cleanup are separate paths; verifier cleanup is only in `finally` after the absence assertion. | The baseline `kill -9` red occurred before the verifier's cleanup removed the victim. |
| Concurrent subject is mistaken for stale | A held matrix lock plus a newly planted container models the other lane. | Removing or classifying the recent subject fails the independent `running` assertion; final code leaves it untouched. |
| Sample collection is empty | Collector returns zero entries under admitted CPU. | `COMPILE_BUDGET_SAMPLE_COUNT_INVALID: expected 5, received 0`. |
| Sample parser accepts malformed data | One duration is `NaN`. | `COMPILE_BUDGET_SAMPLE_INVALID`. |
| Best-of-N masks a real regression | All five controlled samples exceed the unchanged budget. | Best 5,100.0 ms raises `COMPILE_BUDGET_EXCEEDED`. |
| Samples are warm repetitions | Real collector reports process identity and per-process invocation count. | Reusing a PID or reporting an invocation other than one fails the cold-sample assertions. |

No negative control is skipped. The exact incident (`kill -9`), the stale sweep,
the concurrent-lane non-interference, and the noisy-sample estimator are all
executed paths.

## Focused gates and checkpoint evidence

- `corepack pnpm test:performance` — 5/5; the first host sample was correctly
  indeterminate at 80.8% idle, the quiet retry passed at 97.5% with the five
  measured wall and CPU values above.
- `corepack pnpm test:architecture` — 116/116, including all 16 pre-existing
  `dependency-boundaries` controls plus 9 leak-guard controls.
- `corepack pnpm typecheck`, `corepack pnpm lint`, `corepack pnpm format`, and
  `git diff --check` are required before freeze.
- `bash ./scripts/run-matrix.sh LEAKGUARD /home/rvham/2rain-greenfield-leakguard`
  runs at the exact frozen SHA. Exact matrix counts and its live idle/sample
  telemetry are reported in the checkpoint so this document does not require a
  self-referential post-freeze SHA edit.
- `./scripts/check-origin-sync.sh` and `./scripts/check-parked-work.sh` run at
  the same checkpoint.

The Behavioral review charter is bounded to whether the external guardian
really survives the named death paths, whether stale/recent classification is
safe for two lanes, whether the matrix can start contaminated, and whether the
fresh-process best-of-five verdict retains the unchanged admission and budget.
Product source, Docker configuration, matrix-lock semantics, and new performance
calibration are explicitly out of scope. The fresh review verdict and frozen SHA
are reported at the checkpoint.

Program-review triggers do not fire: this packet changes test and gate
harnessing, not a product capability, correctness domain, fan-out point, or stage
boundary. Packet stops: 0.

## Test it yourself (under ten minutes)

From the packet worktree:

```bash
corepack pnpm test:performance
corepack pnpm test:architecture
docker ps --all --filter 'name=^/north-star-' --format '{{.Names}} {{.Status}}'
```

Expect 5/5 performance controls, 116/116 architecture controls, distinct PIDs
implicit in the cold-sample assertion, the noisy-single/all-slow diagnostics,
and no `north-star-*` containers after the suites finish. On a currently busy
host the first command may honestly report `COMPILE_BUDGET_INDETERMINATE`; wait
for the other lane and rerun rather than changing the threshold.
