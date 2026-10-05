# ADR-0070: The v0 package-byte maximums are 4 MiB

Date: 2026-10-05 (proposed). Owner ruling: **PENDING (YYYY-MM-DD)**.
Status: **Proposed — pending owner ruling.** Prepared by the serial bridge
packet `STRUCTURAL-LIMITS-RAISE`; it must not merge before the owner rules.
Tier: Behavioral — a frozen shared contract (Freeze A, canonical language T10)
changes, so it goes through a serial bridge packet (G1-P0, AGENTS.md §5). It is
outside the AGENTS.md §4 Critical set, so no review arm is owed; the owner's
ruling is the gate.

Owner's words: "**PENDING**"

## Context

`STRUCTURAL_LIMITS_V0` caps a package at 2,097,152 authored bytes and
2,097,152 normalized canonical bytes. G1-P1 set both values on 2026-07-21
(`2f8e2252`); the decode-side check followed in `4b` (`2f5c7b07`). No ADR or
measurement ever justified 2 MiB: it was a placeholder v0 budget, and
`canonical-language-v0.md` T10 only says the version fixes the bounds.

It is a structural and performance budget, not a security control:

- it is measured after `parseStrictJson` has already parsed the input, so it
  cannot protect memory from a hostile input;
- no request path accepts a package, and PostgreSQL stores the bytes without a
  size check;
- it is outside `limitsDigest`, which covers only `DEFAULT_COMPILER_LIMITS`
  (the 16 MiB compiler output cap), so moving it moves no digest or root.

Rain, the product application, is reaching the ceiling. Measured 2026-10-05
across the open branches: PAYABLES 1,277,001 and SUPPLY-WARNINGS 1,355,964
normalized bytes; all open branches together about 2,080,471 (about 16.7 KB
left). The five remaining parity items are estimated at +175 to +315 KB, so
**full parity is about 2.26 to 2.40 MB, over the 2 MiB limit**. The authored
file binds first, because `compile-app-release.ts` checks the pretty-printed
`app.authored.json`: RETURNABLE-ASSETS is at 2,093,870 bytes (3.3 KB left),
RETURNS 2,077,552, SALES-EXTRAS 2,053,354.

## Options considered

1. **Raise both maximums to 4 MiB (chosen).** One constant moves; no golden,
   release root or digest moves, because a raise only admits more. Cost: one
   serial bridge packet, the T10 amendment, and the compile budget re-measured
   at the new ceiling (`compiler-slos.md`). About one packet.
2. **Compact the language** (a new language version: standard surface slots,
   shared selection sets, bare-id references). The measured redundancy is
   large: standard surface slots about 118 KB, duplicate selection lists about
   239 KB, reference wrappers 422 KB (bare ids would save about 247 KB),
   `schemaVersion` tags about 170 KB; gzip compresses the package 21x. A
   realistic first cut saves 350 to 500 KB. Cost: 2 to 4+ packets, a language
   adoption event that touches every module, serialized against parity work.
   Rejected as the answer **now**; kept as the next language event's cheap
   wins. It does not remove the need for headroom, it postpones it.
3. **Split the application into several packages.** Composition seams are
   `unsupported` in v0 (T9) and stay so until G6. Not available.
4. **Write `app.authored.json` as compact JSON** (whitespace only; no root
   moves; `STOCK-COUNTS` already did it in `3e89d9aa`). Recommended alongside
   option 1, not instead: it removes the authored-file squeeze (about a third
   of the file is indentation) but does nothing for the normalized bytes.

Why 4 MiB and not more: at the 4 MiB ceiling the compiler's staged output is
8,879,326 bytes, 53% of the 16 MiB output cap. Output grows about 2.1x the
input, so a ceiling much above about 7.5 MiB would also need the output cap
raised, and that cap is inside `limitsDigest`: every release root would move.
4 MiB is the largest power of two that stays clear of that.

## Decision

`STRUCTURAL_LIMITS_V0.maximumAuthoredBytes` and `maximumNormalizedBytes` are
**4,194,304** each. Nothing else changes: the family, collection,
expression-depth and string bounds, `DEFAULT_COMPILER_LIMITS` and every digest
are unchanged. Exactly 4,194,304 bytes is admitted and 4,194,305 is refused,
with the existing deterministic diagnostics (`CANON_LIMIT_PACKAGE_BYTES`,
`CANON_LIMIT_NORMALIZED_BYTES`) whose rule text now reads 4194304. The 5,000 ms
cold full-compile budget is unchanged and must hold at the new ceiling.

## Consequences

- **Rain fits at parity with room to spare.** About 2.3 to 2.4 MB at parity
  leaves about 1.8 to 1.9 MB of the 4 MiB ceiling.
- **G6 customization gets headroom it would not otherwise have.** A tenant
  customization is a new complete application revision (plan §1: never an
  overlay lineage), so its normalized snapshot carries Rain plus the tenant's
  additions under the same ceiling. Under 2 MiB, a parity Rain leaves
  **negative** room: no tenant could add a single field. Under 4 MiB, a tenant
  can add roughly three-quarters of Rain's own size again. Option 2 later
  widens that further. If G6 measures that tenants need more, the next lever is
  compaction or package composition, not another raise past the output cap.
- **Compile time grows with the package.** Measured cold, best of five, the
  package-byte envelope at 99.8% of the ceiling compiled in 2,015.9 ms
  locally (indicative); the official GitHub figure is in `compiler-slos.md`.
  Both are under the 5,000 ms budget.
- **Historical releases are unaffected.** Every recorded package is at most
  2 MiB and decodes byte-identically; `check:app-release`,
  `check:demo-release` and the compiler goldens did not move.
- **It is one-way once used.** After a release above 2 MiB is recorded,
  lowering the limit would make the decode path refuse it. Before the first
  tenant that is a re-baseline (ADR-0066); after it, it is irreversible.

## Evidence

- Origin: `2f8e2252` (G1-P1) and `2f5c7b07` (`4b`); `git log -S 2_097_152`.
- Sizes: the 2026-10-05 size-limit investigation, measured in memory against
  the open branches (numbers in Context).
- Boundary and budget measurements: `docs/execution/packets/STRUCTURAL-LIMITS-RAISE.md`.

## Enforcement

- `packages/canonical-model/src/constants.ts` (`STRUCTURAL_LIMITS_V0`), read
  by the four measurements in `normalize.ts`.
- `test/unit/canonical-model/negative-contracts.test.ts`: the value is pinned
  as a literal (`test/helpers/package-byte-boundary.ts`), and exactly the
  maximum passes and one byte over is refused, identically twice, on the
  authored file path, both measurements inside normalization, and decode.
- `test/compiler/freeze-b.test.ts`: the compiler's decode compiles a package of
  exactly the maximum and refuses one byte more at `decodeSchemaCheck`.
- `test/compiler/performance-budget.test.ts`: the cold compile budget at a
  package of at least 85% of the maximum, built from a frozen snapshot of the
  real application (`test/fixtures/g1/compiler/package-byte-envelope.authored.json`).
- `canonical-language-v0.md` T10 and its correction note record the values.
