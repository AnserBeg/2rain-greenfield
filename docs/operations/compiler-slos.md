# Compiler and release-path SLO families

Status: v0 measurement contract
Owner: compiler measurements in G1-P2; later runtime owners named below

Compiler timing is telemetry, never canonical output. Measurements use
monotonic time outside the hermetic core and report correctness only after all
byte/hash/invariant oracles pass.

| SLO family | Measured interval | V0 objective / status | Next owner |
|---|---|---|---|
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
