# Compiler and release-path SLO families

Status: v0 measurement contract
Owner: compiler measurements in G1-P2; later runtime owners named below

Compiler timing is telemetry, never canonical output. Measurements use
monotonic time outside the hermetic core and report correctness only after all
byte/hash/invariant oracles pass.

| SLO family | Measured interval | V0 objective / status | Next owner |
|---|---|---|---|
| **Publish path (publisher latency)** | accepted draft bytes to activation read-back, spanning compile, candidate verification, transition preparation and activation; human approval wait measured, reported, and excluded | family defined by [ADR-0020](../decisions/ADR-0020-publish-path-budget-and-verification-integrity.md); no numeric objective until a preview and real authoring flow exist to measure | G6 customization stage cut |
| **Publish path (platform exclusion)** | time other tenants' `prepare`/`executeApprovedAttempt` and kernel migration replay are blocked by one tenant's transition | PR-6c's rehearsed **2,000 ms** writer-blocking promotion trigger, recorded in [`runtime-slos.md`](runtime-slos.md) and currently procedural rather than coded | online-strategy packet, which should make approval consume rehearsal evidence |
| Preview | accepted draft bytes to complete preview bundle | family reserved; no target until preview runtime exists | G6 preview packet |
| Incremental compile | accepted complete candidate to cache-equivalent complete bundle | family reserved; v0 is cold-only | G6 compiler packet, triggered by measured need |
| Full compile | normalized bytes accepted to complete cold bundle | **≤ 5,000 ms** at the effective v0 maximum-field envelope and at the package-byte envelope (≥ 85% of the 4 MiB maximum) on pinned Node | G1-P2 gate; every bounds raise |
| Transition preparation | verified candidate transition plan to prepared/verified data transition | family reserved; no seconds-fast claim yet | G2 storage packet + G1-P4 protocol |
| Approval | reviewable bound diff available to valid human approval decision | reported separately; no compiler target | G1-P4/G6 approval flow |
| Activation | approved and prepared candidate to CAS/read-back completion | reported separately; excludes preparation and human wait | G1-P4 |

## Numeric v0 full-compile gate

`test/compiler/performance-budget.test.ts` builds exactly the Freeze A maximum
of 4,096 fields under one module, entity, and storage mapping. Its normalized
package (1,751,892 bytes) remains below the package-byte maximum, then one cold
compile must finish in 5,000 ms on pinned Node 22.22.2. The test uses
`process.hrtime.bigint()` only in the test coordinator; no time source enters
compiler input or output.

This is the effective v0 stress envelope for the largest admitted family, not
a claim that every independent family maximum can coexist below the 4 MiB
package ceiling. Any increase to family, expression, collection, string, or
package-byte bounds must rerun and intentionally amend this budget. A failed
budget does not authorize a second compiler or runtime patch path: it creates
evidence for the tracked incremental/memoization packet, whose output must be
bit-identical to a cold compile.

### Package-byte envelope — amended by STRUCTURAL-LIMITS-RAISE (owner ruling 2026-10-05)

[ADR-0070](../decisions/ADR-0070-the-v0-package-byte-maximums-are-4-mib.md)
raises both package-byte maximums from 2,097,152 to 4,194,304. As the paragraph
above requires, the gate was rerun at the new ceiling and amended: the
**budget is unchanged at 5,000 ms** and now also applies to a second package.
The field envelope stays the family stress. The new package is the byte
stress, shaped like the real application on purpose: a package padded with
long strings compiles far faster per byte than the queries and surfaces that
fill Rain.

Its input is a frozen snapshot of the application,
`test/fixtures/g1/compiler/package-byte-envelope.authored.json` (a byte copy of
`apps/web/release/app.authored.json` at `fe97b63b`, 2026-10-05). The test adds
renamed copies of it until the next copy would not fit (bytes or any family
maximum), then one partial copy that drops whole modules from the end until it
fits. A copy leaves out, with everything that names them, the entities that
exist once per application: those the compiler pins by identity (fact storage,
provider-written read models, the period lock), then any copied entity the
compiler itself reports as having lost a mandatory projection because of that.
Those exclusions are learned from the compiler's diagnostics, not listed by
hand; any other refusal fails the gate. The test asserts the package compiles
and lands between 85% and 100% of the maximum, and prints
`compile-budget-package-bytes:` with its size, copies and timings on every run.

The snapshot is frozen, like the field envelope's fixture, so every run
measures the same input and the gate survives merges. A first version read the
live `app.authored.json`; on a trial merge into `packet/INTEGRATION` its copies
of `item` and the order entities lost projections and shrank to shells, so the
measurement stopped meaning anything. Refresh the snapshot deliberately, and
record it here, when the application's shape changes materially.

Measured at `0bc34b6d` (best of five cold compiles, each in a fresh process;
package 4,186,810 normalized bytes = 99.8% of the maximum, the snapshot plus 8
full copies and a 3-module partial copy, 6 entities kept out of copies; staged
output 8,879,326 bytes = 53% of the 16 MiB output cap):

| Run | Package-byte envelope, best wall | Its samples (wall ms) | Field envelope, best wall | Verdict |
|---|---|---|---|---|
| Local WSL2 at `0bc34b6d`, indicative only (CPU idle 97.9%) | **1,977.4 ms** | 2,040.6, 2,048.8, 1,977.4, 1,987.3, 2,084.3 | 1,818.9 ms | within budget |
| Local, same tests on a trial merge into `packet/INTEGRATION`, indicative only | 2,071.6 ms | 2,723.7, 2,182.4, 2,071.6, 2,142.0, 2,127.1 | 1,802.3 ms | within budget |
| **GitHub `ubuntu-24.04` CI, official**: run [37365925021](https://github.com/AnserBeg/2rain-greenfield/actions/runs/37365925021) at `cb0f51a2` (code identical to `0bc34b6d`), CPU idle 95.8% | **1,429.5 ms** | 1,444.0, 1,459.4, 1,429.5, 1,437.1, 1,437.6 | 1,327.2 ms | **within budget** |
| **GitHub `ubuntu-24.04` CI, official**: run [37420415000](https://github.com/AnserBeg/2rain-greenfield/actions/runs/37420415000) at `99fb12f5` (the ruled packet), CPU idle 98.3% | **1,500.8 ms** | 1,546.1, 1,530.9, 1,500.8, 1,525.8, 1,508.4 | 1,348.8 ms | **within budget** |

**The 5,000 ms budget holds at the 4 MiB ceiling**: about 3.5x headroom on the
official CI runner and about 2.5x locally. The budget was not changed.

The inherited quarry's compiled-manifest ≤4 MiB and module-context ≤18K
character values remain planning references, not adopted greenfield gates;
their physical model and global-manifest assumptions do not match Freeze B.

## Breadth envelope

Added 2026-07-26 by [ADR-0020](../decisions/ADR-0020-publish-path-budget-and-verification-integrity.md).

The numeric gate above is **one** module, entity and storage mapping at the maximum field
count. That bounds one family honestly and it is not the publish-path envelope, because
publish cost scales with the size of a tenant's whole application rather than with the size
of one family.

A second measurement runs alongside it: a declared realistic tenant shape of N modules
totalling M fields, recorded as a **curve across N** rather than a single point.

The first recorded curve is
[`publish-path-breadth-envelope.json`](publish-path-breadth-envelope.json). Its test coordinator
composes the real Party, Catalog and Location definitions under one application namespace and
measures N = 1, 2 and 3 in that order. Each point reports normalized field and searchable-field
counts, index counts from each emitted storage-target entity, and the median of five complete
cold compiles timed only around `compileApplication` with `process.hrtime.bigint()`. The test
asserts curve shape, not values or a threshold, and prints fresh telemetry on every
`test:compiler` run. A later source revision appends another run whose points name that SHA;
it does not rewrite the earlier baseline.

It is a recorded measurement producing a curve artifact, **not a pass/fail assertion**, until
G6 sets an objective against it. It is startable now, order-independent, and does not displace
other work — and it is the only part of this document with a real cost of delay, because the
incremental-compile family is gated on "measured need" and a baseline that was never started
cannot be reconstructed. Pair it with the tracked capability cycle-time baseline; both exist to
give a later decision data instead of an argument.

This curve is not an end-to-end publish-path measurement and the three first-party packages
are not a real tenant-authored application. It cannot establish publisher latency, verification
cost, preparation/activation cost, or platform exclusion. Its values are revision-bound and
will move when compiler or definition work such as packets 4c and 1d integrates.

## Verification integrity

A publish-path budget miss is **never** remedied by weakening verification.

Verification scope narrows only by a sound impact analysis derived from the compiled diff, and
the narrowing produces evidence: the skipped set is named and its derivation recorded with the
candidate. Never by sampling, time-boxing, author or tenant selection, a skip flag, or moving
verification after activation.

The admissible remedies are incremental compile, memoization, a sound impact analysis, better
provider conformance mechanics, or publishing an honestly slower budget. Plan §17 stops on a
pinned gate weakened to accommodate implementation, and this is the specific pressure that
produces that temptation — the prior art's documented answer to slow deploys was to disable
synchronous compilation and let the errors arrive at runtime.

An incremental compile is byte-identical to a cold compile or it does not ship. A nearly
identical second path is a second compiler.
