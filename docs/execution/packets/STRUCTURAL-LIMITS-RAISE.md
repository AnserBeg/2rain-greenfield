# STRUCTURAL-LIMITS-RAISE — the canonical package-byte maximums move from 2 MiB to 4 MiB

Status: **ruled — owner ruling 2026-10-05, "raise it"; [ADR-0070](../../decisions/ADR-0070-the-v0-package-byte-maximums-are-4-mib.md)
Accepted.** Draft PR [#30](https://github.com/AnserBeg/2rain-greenfield/pull/30)
against `main`; **the owner merges it, this lane does not.** Serial bridge
packet for a frozen shared contract (Freeze A, T10; G1-P0, AGENTS.md §5).
Tier: Behavioral, outside the AGENTS.md §4 Critical set. Stops: 1 — STOP list
(a), resolved by the ruling. Base `fe97b63b`, executable head `88150455`. The
same ruling's six composition raises ship in `COMPOSITION-BOUNDS-RAISE`.

## Claims

1. `STRUCTURAL_LIMITS_V0.maximumAuthoredBytes` and `maximumNormalizedBytes`
   are 4,194,304. No other bound moves, nor `DEFAULT_COMPILER_LIMITS` (the
   16 MiB output cap inside `limitsDigest`), nor any digest.
2. Exactly 4,194,304 bytes is admitted and 4,194,305 refused, with one
   diagnostic that is identical on a second run, at all four measurements:
   authored file bytes (`parseAuthoredApplicationPackageJson`), authored and
   normalized canonical bytes inside `normalizeApplicationPackage`, and decode
   (`parseNormalizedApplicationPackageJson`).
3. The compiler's decode compiles a package of exactly the maximum and refuses
   one byte more at `decodeSchemaCheck`, before any lowering.
4. Historical releases still decode: no golden vector, release root or
   recorded lineage entry moved.
5. The unchanged 5,000 ms cold compile budget holds at a package of at least
   85% of the new maximum, shaped like the real application.
6. The dependency audit is clean at the `high` gate: the `brace-expansion`
   override is 5.0.11, byte-identical to INTEGRATION's `edaebdf2`.

## Decisions

- 4 MiB, not more: output is about 2.1x input, so past about 7.5 MiB the output cap (in `limitsDigest`) would bind and every root would move. ADR-0070.
- The test pins the VALUE as a literal (`PACKAGE_BYTE_MAXIMUM_V0`), not the constant, so a silent move reds the boundary tests.
- Boundary packages pad a fixture with fixed-width declared-default text fields; the helper asserts the exact byte count, never assumes it.
- Inside normalization, "authored check passes at the maximum" is shown as "refused only by the next (normalized) check": normalization always adds bytes, so both cannot pass at once.
- The old literal `2_097_153` padding in negative-contracts now derives from the constant; the exact edge lives in the new test.
- Perf envelope = the application plus renamed copies to just under 4 MiB, not padded strings: padding compiles far faster per byte than real queries and surfaces.
- Its input is a FROZEN snapshot (`package-byte-envelope.authored.json`, byte copy of `app.authored.json` at `fe97b63b`): the live-file version broke on an INTEGRATION trial merge (copies shrank to shells, then 66 > 64 modules); the snapshot passed there unchanged.
- Copies leave out identity-pinned entities (the compiler's own resolvers), then any copied entity the compiler reports missing a projection; any other refusal fails the gate.
- Compacting `app.authored.json` (ADR-0070 option 4) is not done here: it is the generator's change and a separate packet (precedent `3e89d9aa`).
- No ledger, lane or review-log row: written when the owner merges and INTEGRATION folds this in.
- Composition census: every schema bound and every `STRUCTURAL_LIMITS_V0` bound, each app built with its ref's own code; counted members as INTEGRATION plus each leaf's additions over its merge-base.
- List saved views (8; the sales order List needs 9) stay: Counter sales moves to its own worklist (coordinator).
- Task steps take SALES-EXTRAS' own value 12, so that leaf's identical line merges cleanly.
- The composition raises sit on INTEGRATION-only code, so they ship as `COMPOSITION-BOUNDS-RAISE`, a separate draft PR on `packet/INTEGRATION` (coordinator); this PR keeps `main` as its base.
- `brace-expansion` 5.0.9 failed CI's audit on every `main`-based branch; cherry-picked INTEGRATION's one-commit fix (`edaebdf2`, -x) so it merges back cleanly.
- Review: not owed — outside the Critical set. The owner's ruling is the gate.

## Slices

1. Constant + boundary tests + perf envelope — executable commits `6b53ba60`, `0bc34b6d`; "Test it yourself" steps 1-3.
2. T10 note, `compiler-slos.md` amendment, ADR-0070, this record — docs only; step 4.
3. Owner ruling recorded (comments `88150455`, docs) and the audit fix `30b4f319`.

## Gates

- Local at `99fb12f5` (indicative): `format`, `lint`, `typecheck`,
  `check:app-release`, `check:demo-release`, `check:boundaries`,
  `check:expected-red` PASS; unit 164/164, compiler 176/176 PASS. Earlier at
  `0bc34b6d`: integration 150/150, contracts 29/29 PASS.
- Local notes: `test:compiler` showed 175/176 under this shell's
  `FORCE_COLOR=3`; the red (`posted stock ... temporal limit`) also reds on
  untouched `origin/main` and passes with color off. `check:language-coverage`
  needs a full reachability run token; CI runs it.
- Not run locally: postgres, browser, architecture, `check:schema` (Docker).
- Recorded artifacts unchanged: `git diff --diff-filter=MDR origin/main HEAD --
  apps/web/release test/fixtures` is empty (the one added path is the new
  snapshot fixture), and `check:app-release --check` re-decodes every
  recorded lineage entry and confirms the head root `86ec4ca8…` under the new
  limit.
- Performance (best of five cold compiles; budget 5,000 ms, unchanged):
  package-byte envelope 4,186,810 bytes (99.8%), 8 copies + 3 modules —
  **CI 1,500.8 ms at `99fb12f5`** and 1,429.5 ms earlier (official), local 1,977.4 ms at `0bc34b6d` and
  2,071.6 ms on an INTEGRATION trial merge (indicative). Field envelope CI
  1,327.2 ms, local 1,818.9 ms. Table in `compiler-slos.md`.
- Local controls (evidence only): limit -1 on each constant, both back to
  2 MiB, and `>` -> `>=` at each of the four checks — all 7 red the boundary
  tests; restored clean.
- CI: run [37420415000](https://github.com/AnserBeg/2rain-greenfield/actions/runs/37420415000)
  at `99fb12f5` — all 7 jobs green, including browser, the dependency scans
  and reachability; package-byte envelope 1,500.8 ms, field envelope
  1,348.8 ms. `scripts/check-records.sh`: PASS.

## Test it yourself

About five minutes, no Docker, in the packet worktree.

```sh
cd /home/rvham/2rain-greenfield-limits
git log --oneline -4
grep -n "maximum.*Bytes: " packages/canonical-model/src/constants.ts
FORCE_COLOR=0 node --import tsx --test --test-name-pattern='package-byte maximum' test/unit/canonical-model/negative-contracts.test.ts
FORCE_COLOR=0 node --import tsx --test --test-name-pattern='byte maximum' test/compiler/freeze-b.test.ts
corepack pnpm check:app-release && corepack pnpm check:demo-release && echo RELEASES-UNCHANGED
git diff --stat --diff-filter=MDR origin/main HEAD -- apps/web/release test/fixtures
```

Expect: both constants read `4_194_304`; each test prints `ok 1` (a package
of exactly 4,194,304 bytes is accepted and compiles; one byte more is refused
with "must not exceed 4194304"); `RELEASES-UNCHANGED` prints; the last command
prints nothing. Then open ADR-0070 and the T10 note: both record the
2026-10-05 ruling, "raise it".

Optional, about a minute on a quiet machine (it reports INDETERMINATE, never
green, if the CPU is under 90% idle):
`FORCE_COLOR=0 node --import tsx --test test/compiler/performance-budget.test.ts`.
Expect a `compile-budget-package-bytes:` line with `normalized_bytes=4186810`
and `wall_ms` well under `budget_ms=5000`.

## Filed

- Compact `app.authored.json` everywhere (ADR-0070 option 4): about a third of the file is indentation; separate packet.
- Language compaction (ADR-0070 option 2: surface slots, selection sets, bare ids) for the next language event.
- `inventory-contract.cases.ts` honesty control matches an assertion message by regex, so it reds under `FORCE_COLOR`; pre-existing on main.

## Landing

The owner merges PR #30; the INTEGRATION agent folds it into
`packet/INTEGRATION` with the three one-line rows. This lane merges nothing.

Review: not owed — outside the Critical set.

```record-claim
{
  "schemaVersion": "northstar.record-claim/v1",
  "packet": "STRUCTURAL-LIMITS-RAISE",
  "base": "fe97b63baedf8bdd42146318bb89d4be1aa948f6",
  "head": "881504555ce819fef62ddcfa83375759a2b0856f",
  "changedPaths": [
    "packages/canonical-model/src/constants.ts",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "test/compiler/freeze-b.test.ts",
    "test/compiler/performance-budget.test.ts",
    "test/fixtures/g1/compiler/package-byte-envelope.authored.json",
    "test/helpers/package-byte-boundary.ts",
    "test/unit/canonical-model/negative-contracts.test.ts"
  ],
  "symbols": [
    { "path": "packages/canonical-model/src/constants.ts", "name": "STRUCTURAL_LIMITS_V0" },
    { "path": "test/helpers/package-byte-boundary.ts", "name": "PACKAGE_BYTE_MAXIMUM_V0" },
    { "path": "test/helpers/package-byte-boundary.ts", "name": "packageAtByteBoundary" },
    { "path": "test/compiler/performance-budget.test.ts", "name": "packageByteEnvelope" }
  ]
}
```
