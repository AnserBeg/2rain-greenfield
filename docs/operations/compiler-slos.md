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
| Full compile | normalized bytes accepted to complete cold bundle | **≤ 5,000 ms** at the effective v0 maximum-field envelope on pinned Node | G1-P2 gate; every bounds raise |
| Transition preparation | verified candidate transition plan to prepared/verified data transition | family reserved; no seconds-fast claim yet | G2 storage packet + G1-P4 protocol |
| Approval | reviewable bound diff available to valid human approval decision | reported separately; no compiler target | G1-P4/G6 approval flow |
| Activation | approved and prepared candidate to CAS/read-back completion | reported separately; excludes preparation and human wait | G1-P4 |

## Numeric v0 full-compile gate

`test/compiler/performance-budget.test.ts` builds exactly the Freeze A maximum
of 4,096 fields under one module, entity, and storage mapping. Its normalized
package remains below the 2 MiB maximum, then one cold compile must finish in
5,000 ms on pinned Node 22.22.2. The test uses `process.hrtime.bigint()` only in
the test coordinator; no time source enters compiler input or output.

This is the effective v0 stress envelope for the largest admitted family, not
a claim that every independent family maximum can coexist below the 2 MiB
package ceiling. Any increase to family, expression, collection, string, or
package-byte bounds must rerun and intentionally amend this budget. A failed
budget does not authorize a second compiler or runtime patch path: it creates
evidence for the tracked incremental/memoization packet, whose output must be
bit-identical to a cold compile.

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

It is a recorded measurement producing a curve artifact, **not a pass/fail assertion**, until
G6 sets an objective against it. It is startable now, order-independent, and does not displace
other work — and it is the only part of this document with a real cost of delay, because the
incremental-compile family is gated on "measured need" and a baseline that was never started
cannot be reconstructed. Pair it with the tracked capability cycle-time baseline; both exist to
give a later decision data instead of an argument.

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
