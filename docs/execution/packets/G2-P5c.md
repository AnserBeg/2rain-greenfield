# G2-P5c — Conformance ratchet: gate the product, not a fixture

Status: evidence_ready
Tier: Behavioral
Base: `6aa07b0b01551c84d3327a83859ba43e7f12c1d2`
Frozen candidate: reported at handoff after the final evidence commit

## Goal and scope

This packet points G2-P4's surface-grammar checker at the compiled production
module definitions instead of leaving its only input as a conformant synthetic
fixture. It admits the existing debt as an exact per-module baseline and makes
every movement in that debt deliberate:

- an increase fails;
- a decrease without a baseline update also fails;
- a missing, additional, substituted, or zero product-module set fails; and
- the conformant synthetic fixture cannot satisfy a production module entry,
  even if a caller labels it with a production source directory.

This is a ratchet, not a conformance claim. None of the existing violations is
fixed here. Missing slots, row-to-record navigation, the New affordance,
component registration, and the activity rail remain G2-P5d work.

## Baseline at the exact base

The isolated `packet/g2-p5c` worktree was cut from the exact base above. The
full base matrix was green on its first attempt.

| Gate | Observed base result |
|---|---|
| `format`, `build`, `lint`, `typecheck`, `check:demo-release` | PASS |
| `check:boundaries` | PASS — 113 production files |
| `check:schema` | PASS — 12/12 migrations, clean drift |
| `test:unit` | PASS — 36/36 |
| `test:compiler` | PASS — 52/52 |
| `test:integration` | PASS — 59/59 |
| `test:agent` | PASS — 3/3 |
| `test:architecture` | PASS — 68/68 |
| `test:contracts` | PASS — 6/6 |
| `test:postgres` | PASS — 85/85, first attempt |
| `test:locale` | PASS — 1/1 |
| `test:browser` | PASS — 14/14 |
| observability producer | PASS — 5/5 |
| `check:reachability` | PASS — 66/66 test files, 9 producer artifacts |

The base reachability run token was
`99c0e57e-f542-43c6-83a3-2180f8eb84f3`.

## Reviewed product-debt baseline

The architecture test imports all four production factories from
`packages/domain/src/index.ts`, normalizes and compiles each with
`compileApplication`, decodes the compiler-produced surface-manifest
projection, and passes those surfaces to `checkSurfaceGrammarConformance`.

| Production module | Package identity | Active surfaces read | Violations |
|---|---|---:|---:|
| Catalog | `northstar.catalog:package.catalog` | 3 | 33 |
| Location | `northstar.location:package.location` | 3 | 33 |
| Party | `northstar.party:package.party` | 6 | 64 |
| Platform | `northstar.platform:package.platform` | 3 | 33 |
| **Total** | 4 compiled packages | **15** | **163** |

The previously reported 130 is still correct for the three modules that
existed in that measurement: Party 64 + Catalog 33 + Location 33. The Platform
saved-filter package landed afterward and contributes another 33. This packet
records the current product truth rather than preserving the older total.

The checked-in artifact lives at
`test/architecture/surface-grammar-conformance.baseline.ts`, beside the gate
that owns the admitted debt but outside `test/fixtures`. Keeping product IDs in
architecture evidence also preserves the factory invariant that the generic
production press has no Catalog or Location branch. Each entry pins source
directory, canonical package ID, canonical module ID, and violation count. The
architecture test also discovers every direct
`packages/domain/src/*/definition.ts` directory, so a new ordinary module
cannot be omitted merely by forgetting to add it to the compile registry.

The first committed candidate run at `3cee830` was honestly red: static gates
were green, but `test:unit` was 34/36 because the initial baseline location
under `packages/dev-tooling` put literal Catalog and Location identities into
the generic production press. Their zero-press-change guards correctly
rejected that placement. Moving the data-only baseline to architecture
evidence restored both unit controls to 36/36 without weakening or editing
them.

## Quantifier ruling

`SURFACE_SLOTS` is the **exact anatomy** for its archetype: every listed slot
is both allowed and required, and it appears exactly once. This follows plan
§8.5's “fixed anatomy” and the canonical-language statement that slots are
exact.

The comment at the constant definition and the checker comment now state the
same transitional split:

- canonical normalization currently enforces the closed, at-most-once ceiling;
- surface conformance enforces the required floor; and
- G2-P5d may close the compile-time gap only after burning down the admitted
  production debt.

The normalizer's behavior is intentionally unchanged. Incomplete modules still
compile in this packet, and the product ratchet is their interim enforcement.

## Executed reds

These are induced invalid candidates. The permanent tests remain green only
because each induced case produces its named ratchet violation.

| Vacuity vector | Induced candidate | Observed red |
|---|---|---|
| fixture substitution | Replace the Catalog observation with the compiled G2-P4 synthetic package while retaining `sourceDirectory: catalog` | `SGR002_PRODUCT_MODULE_SET` names the synthetic package identity; it cannot satisfy Catalog |
| production increase | Detached scratch commit `818c292` removes Catalog's real List `dataGrid` slot | exit 1; `catalog=35/33`; one `SGR003_VIOLATION_INCREASE`; the revert `43c861b` returned 21/21 |
| silent production decrease | Detached scratch commit `7568834` adds Catalog's missing List `title` slot without changing the baseline | exit 1; `catalog=31/33`; one `SGR004_UNRECORDED_DECREASE`; the revert `7e8317a` returned 21/21 |
| zero input | Invoke the product ratchet with no compiled observations | `SGR001_NO_PRODUCT_MODULES`; formatter says `0 compiled product modules read` |

The first increase scratch run also exposed coupling in the then-current
in-suite decrease control: subtracting one from a newly increased count was
still an increase. Commit `d0fad14` made both induced controls target the
reviewed baseline independently. That scratch-only secondary failure is not
counted as a product ratchet red.

## Positive observations

| Claim | Direct observation |
|---|---|
| product inputs are compiled definitions | all four factories are imported from the production domain index; package/module IDs are read from normalized definitions and surfaces from compiled projection artifacts |
| current debt is admitted, not hidden | the focused command prints `catalog=33/33, location=33/33, party=64/64, platform=33/33` |
| module inventory is closed | discovered production definition directories exactly equal baseline source directories |
| fixture rule coverage is preserved | the original 16 G2-P4 checks remain unchanged and pass; the focused file is 21/21 after adding five ratchet checks |
| exact anatomy has one reading | canonical constant and checker comments agree that listed slots are allowed and required exactly once |

## Known limits and what the ratchet cannot prove

- A count ratchet cannot detect one violation being removed while a different
  violation is added in the same module. The printed counts are a deliberate
  burn-down instrument, not a fingerprint of the exact violation set.
- The ratchet observes compiler surface-manifest artifacts. It does not render
  the real modules in Chromium, prove row-to-record navigation, or repeat
  contrast/target measurements over production content. G2-P4's unchanged
  synthetic journeys continue to test checker and runtime mechanics; G2-P5d
  owns product anatomy and journeys.
- Direct domain-module discovery follows the repository's current
  `packages/domain/src/<name>/definition.ts` convention. A deliberate package
  reorganization must update the reviewed baseline and compile registry.
- The compiler still accepts subsets of exact anatomy. That is explicit
  transition debt, not a claim that the production modules conform.
- Counts are per standalone compiled package. This packet does not answer the
  still-open composed-application question before G2-P9.

## Reproducible evidence

Focused product and fixture evidence:

```bash
cd /home/rvham/2rain-greenfield-g2p5c
node --import tsx --test \
  test/architecture/surface-grammar-conformance.test.ts
```

Expected: 21/21 and this line near the top:

```text
product surface grammar ratchet: PASS (4 compiled product modules read; catalog=33/33, location=33/33, party=64/64, platform=33/33)
```

The source-level increase and decrease reds were run in detached temporary
worktrees. They are reproducible by changing only Catalog's `entitySurfaces`
helper, without touching the baseline:

1. set the List branch's `slots` to `[]`; the focused command prints 35/33 and
   exits 1;
2. restore it, then add a valid `title` slot to the List branch; the command
   prints 31/33 and exits 1; and
3. restore the source; the command returns 21/21 at 33/33.

## Test it yourself

From the packet worktree, this takes under one minute:

```bash
cd /home/rvham/2rain-greenfield-g2p5c
node --import tsx --test \
  test/architecture/surface-grammar-conformance.test.ts
```

Expect 21/21 and the exact four-module count line above. The command compiles
the production definitions during the test; it does not read a precomputed
fixture result.

## Handoff

This packet stops at its frozen candidate. It does not integrate, change the
130/163 production violations, update the accepted ledger/current queue, or
continue to G2-P5d. Those are acceptance and follow-on actions.
