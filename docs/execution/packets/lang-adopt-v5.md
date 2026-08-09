# LANG-ADOPT-v5 — adopt canonical language v5 across the application

Tier: Critical

Base: `origin/main` at `5aa2d2c` (includes `5g3-sm-impl`, integrated `792085d`)

Authorities:
[ADR-0050](../../decisions/ADR-0050-the-record-transition-carrier.md),
[ADR-0047](../../decisions/ADR-0047-the-compiler-semantic-profile-is-the-projection-evolution-axis.md)
§2/§4/§4a/§5,
[ADR-0043](../../decisions/ADR-0043-lineage-truncation-and-attributed-count-changes.md),
[ADR-0039](../../decisions/ADR-0039-experimental-output-protocol-and-lineage-regeneration.md),
[ADR-0041](../../decisions/ADR-0041-declared-shapes-must-be-honoured-or-refused.md).
Precedent: the `LANG-ADOPT` (v4) ledger row and the `4c` decomposition —
*definition was free, only adoption cost.*

## Outcome

`ADOPTED_LANGUAGE_VERSION` and `ADOPTED_NORMALIZATION_PROFILE_VERSION` are v5.
All five first-party module definitions and `app/builder.ts` declare v5
together. One lineage entry is minted; every recorded entry before it still
reproduces. No product state machine ships — all five modules still declare
`stateMachines: []`, and the first product machine arrives with `PUR-1`.

---

## The claim in the queue row that is false, and it is the load-bearing one

> `DEFAULT_COMPILER_PROFILE` keys on `ADOPTED_LANGUAGE_VERSION`, so adoption
> **moves every release root and mints one lineage entry**.

**Measured, in both directions, before touching anything else.** Moving
`ADOPTED_LANGUAGE_VERSION` and its normalization pair to v5 while leaving the
six definition files at v4:

| | |
|---|---|
| `check:app-release --check` | **exit 0** |
| the writer, run without `--check` | **exit 0**, wrote nothing |
| `app.authored.json` | `0217868f…` — **unchanged** |
| `app.compiled.json` | `8c62223a…` — **unchanged** |
| lineage length | **8**, unchanged |

The release path takes `languageVersion` and `normalizationProfileVersion` from
the normalized definition's OWN bytes (`compile-app-release.ts`,
`compileNormalizedDefinition`), and only the compiler-semantic profile version
defaults from `MODULE_COMPILER_PROFILE`. **The constant is not the artifact
event.** What mints the entry is the AUTHORED edit to
`packages/domain/src/**/definition.ts` and `app/builder.ts`.

This matters beyond pedantry: a lane that moved only the constant would see a
green `check:app-release`, no root movement, and would conclude adoption was
free. It is adoption that looks done and is not. The constant is still
required — without it the composed-package assertion in
`canonical-contracts-purity` reds — but it is the *pairing* that is the event,
which is why the sixth-omission sweep below is about pairings.

Recorded in the `ADOPTED_LANGUAGE_VERSION` doc comment, so the next adoption
reads it before it repeats the experiment.

## The artifact event, measured before and after

| Artifact | Before | After |
|---|---|---|
| lineage length | 8 | **9** |
| head root | `b0177bf482a73235…` (v4) | **`3ef281274f753f35…` (v5)** |
| bootstrap root | `7619e59cba92a3cc…` | `7619e59cba92a3cc…` — **HELD** |
| shell (`check:demo-release`) root | `bd5e590f6c174e9b…` | `bd5e590f6c174e9b…` — **HELD** |
| `app.authored.json` | `0217868f16700ea8…` | `1f10a59b78b4a47b…` |
| `app.compiled.json` | `8c62223ad6d952d6…` | `e6e7789f52005423…` |
| entries 0–7 roots | `a9c37c77 ba87d215 bf932f8a a8f6e2c1 ee5d474d 4b254f50 d726ad31 b0177bf4` | **all eight byte-identical** |

**"Every release root moves" is wrong on two of the three root-bearing
artifacts.**

- The **shell/demo** release holds because `compile-demo-release.ts` overrides
  both version fields from its own `v0-experimental` authored definition. It was
  never keyed to adoption at all.
- The **bootstrap** root holds because `verifyExistingLineage` recompiles the
  RECORDED bootstrap bytes; only `initialLineage` derives a bootstrap from the
  current authored source, and that path runs only when no output file exists.

`check:app-release` is green, which is the freeze: it recompiles every stored
entry's bytes and exact-compares against the recorded serialization. Nine of
nine reproduce, including three at v2/v3 and five at v4.

**The new entry is a version-stamp-only delta.** `v5NormalizedShape` is
`v4NormalizedShape` with `languageVersion` changed, and no first-party module
declares a machine. Every gate passing over that entry proves adoption BROKE
NOTHING, not that v5 WORKS. That gap is what the fixture below exists to close,
and it is `5g3-sm-impl`'s finding applied to its own successor.

## The fixture: exercise the shape, ship no product machine

`test/compiler/adopted-language-shape.test.ts`, four controls.

| Control | What it observes |
|---|---|
| materializes exactly one state field at the adopted version, and none below it | one derived field, asserted WHOLE — enum options from the states, `defaultValue` the initial state, `presence: required`, `classification: internal` |
| compiles through the **unmodified** default profile | `compileApplication` with `{ ...DEFAULT_COMPILER_PROFILE }` and **no version override**; the state reaches storage as an ordinary column with an `enumDomain` check constraint over exactly the machine's states, and `derivedStateFields` is `[]` |
| round-trips through the canonical authored projection | re-normalizing the projection is byte-identical |
| a mixed-version composition is refused by name while the uniform one is admitted | `CANON_VERSION_MIXED`, one diagnostic per moved node, `objectId` naming exactly the moved entities |

**Three decisions inside it are worth more than the controls.**

1. **The "one version below" specimen is DERIVED, by walking back through
   `SUPPORTED_LANGUAGE_VERSIONS` to the newest version that does not
   materialize.** `5g3-sm-impl` fixed its materialization gate to ask the
   ordered list rather than enumerate levels, precisely so a v6 cut inherits the
   rule; a control hard-coding `'v4'` as "below" re-opens the same hole one
   layer up.
2. **The two specimens are asserted to differ in version stamps and nothing
   else** before either is normalized. Without that, "materialization is what
   changed" is an inference; with it, it is an observation.
3. **The compile arm passes no version override, and that is the whole point.**
   Every fixture helper in this repository hides that arm —
   `test/compiler/helpers.ts`, `test/fixtures/g2/party/compiler.ts` and
   `surface-grammar/compiled.ts` all spread the profile and then overwrite
   `languageVersion` from the package under compile, so they compile happily
   whatever the adopted version is and can never observe it moving.

**Built on the module-conformance fixture, not on
`representative.authored.json`, and that was a measurement rather than a
preference:** the representative package NORMALIZES but does not COMPILE at any
version — unsupported capabilities, incomplete entity conformance — so a compile
control built on it would have asserted a refusal unrelated to the language.

`stock_count`'s `draft | counting | reviewed | posted` enumeration was NOT
converted into a machine. That is a feature change to an entity ADR-0029
hardened, it touches posting evidence, and it would have made this a feature
packet.

## The sixth hand-written version — the sweep, and what it found

The question asked of every version-bearing line was `5g3-sm-impl`'s: **what
does this compare against, and where did that value come from?**

**Five live sites, all in tests, all found by the adoption itself rather than by
grepping.** The lead was already on the record: the `LANG-ADOPT` (v4) ledger row
logged *"four fixture compilers still pin the profile and pass only because
module and adopted version coincide at v4."* That coincidence broke at v5.

| # | Site | Form | Fixed by deriving from | Because the check depends on |
|---|---|---|---|---|
| 1 | `inventory-onhand.test.ts` — a helper literally named `adoptCanonicalLanguageV4`, walking the composed definition rewriting `'v3'`→`'v4'` and stamping the envelope | emitter | **deleted** | the composed definition already carries the adopted version; a helper restamping a package to the version it already has cannot be right, only currently harmless |
| 2 | `inventory-onhand.test.ts` — a compiler profile pinned `languageVersion: 'v4'` | emitter | the composed definition | the profile must agree with the package it compiles |
| 3 | `inventory-onhand.test.ts` ×3 — nodes constructed and injected into the composed definition at `'v4'` | emitter | the composed definition | node-version purity: an injected node carries its package's version |
| 4 | `legal-entity-query-scope.test.ts` — "the unmodified default profile still compiles an ADOPTED-version package", using `v4ScopedModule()` | admitter | `ADOPTED_LANGUAGE_VERSION`, via a new `scopedModuleAt` | the package must be at the adopted version, not at v4 |
| 5 | `inventory-contract.cases.ts` ×2 — the minted `legalEntityReferenceParameterType` asserted at `'v4'` | admitter | the module under test | `5g3-sm-impl` fixed the EMITTER to derive from `authored.languageVersion` and left this assertion pinning the literal the emitter had stopped producing |
| 6 | `party-definition.test.ts`, `location-definition.test.ts` ×3 | admitter | `ADOPTED_*` / the definition under test | "this module declares the adopted version" / "these are nodes of this package" |

Site 5 is the sharpest instance of the class: **the emitter was derived and its
assertion was not**, so the fix and the control drifted apart in the same packet
that named the class.

**Two production sites were found and deliberately NOT changed.**
`languageHasV2Features` (`normalize.ts:2229`) and
`languageUsesModuleProjectionShape` (`compiler.ts:1206`) both enumerate
`featureLevel === 'v2' || 'v3' || 'v4' || 'v5'`. They already include v5, so
adoption does not break them — they are a **dated** defect (the next cut), not a
live one. Both are private and unexported, so no control can distinguish the
enumerated form from a derived one today; converting them would ship unobserved,
which is the "a warning is not a control" failure this program already paid for.
Making them observable means an exported shared feature-level helper across three
predicates in `canonical-model`, which is a compiler-semantics change inside an
adoption packet. **Routed to `version-predicate-derivation`, with the deletion
measurement recorded there rather than a claim.**

## The 107-obligation unobserved exemption

_Filled in from the re-derivation; see the run record below._

## `U5b`'s reader-vocabulary debt — checked, and RE-ROUTED

**Adoption does not make `progressive` or `onDemand` reachable, and the reason
is structural rather than "no fixture exercises it".**
`validateDisclosureTiers` (`packages/canonical-model/src/normalize.ts:1433-1466`)
refuses `onDemand` as `CANON_SURFACE_DISCLOSURE_TIER_UNHONOURED` and
`progressive` as `CANON_SURFACE_DISCLOSURE_TIER_NOT_DEFERRABLE`. **Neither
branch reads a language version**; the function's only version-bearing input is
unused, and it is called unconditionally. No package at any version can carry a
non-`always` tier through normalization, so no compiled surface manifest can
carry one, so `parseSlot`'s local set
(`apps/web/src/surface-contract.ts:25`) cannot be positively exercised beyond
`always` by anything this packet does.

The row also mis-routes the debt. ADR-0047 §4a assigns the deferred
*declare `always` on a real slot* obligation to the **compiler-semantic profile
v2** adoption packet, not the language one — `U5b` cut
`northstar.compiler-semantic/v2` unadopted as an accumulation window, and
`ADOPTED_COMPILER_SEMANTIC_PROFILE_VERSION` is deliberately untouched here.

**Re-routed to `U5c`**, which owns the authority question. Nothing built.
Independently confirming: `apps/web/src/surface-contract.ts` is currently held by
the `pur1-intent-limit` lane, so building there would also have been a lease
violation.

## Two controls that addressed lineage entries by POSITION

Both went red on an adoption that changed nothing they guard. This is the
packet's second transferable finding.

| Control | Was | Is |
|---|---|---|
| `consecutive lineage entries may share a normalized definition` (`compiler-semantic-profile.test.ts`) | `at(-1)` vs `at(-2)` — named the profile-adoption pair only while it was the head, which lasted exactly one packet | searches the lineage for the pair that shares a definition, asserts there is **exactly one**, and asserts it advances FORWARD along the compiler-semantic axis; the head's adopted profile is asserted separately, as the distinct claim it always was |
| `assertAttributedSearchCapabilityScenarioDelta` (`composed-application.test.ts`) | `previousSourceRelease(head)` vs head — read 163 where it expected 168 | the pair is pinned by release root (`4b254f50…` → `d726ad31…`), asserted still CONSECUTIVE, and the head is checked separately |

`previousSourceRelease` is deleted. It solved a real problem — `at(-2)` selects
the definition-equal sibling a profile adoption mints — but it solved it by
making the answer depend on where the head is, which is the same defect one step
out. Both spellings answer *which entry is near the end*; neither answers *which
entry carries the change this control is about*.

**And the second control yields the adoption fact worth having:** entries 6, 7
and 8 all carry 163 verification scenarios with identical scenario ids, now
asserted. The profile adoption and the language adoption each move a release
root and change no scenario. An adoption that silently moved the verification
plan would be a product change wearing an artifact event's clothes.

## The purity ratchet had to be REPLACED, not updated

`canonical-contracts-purity.test.ts`'s `the newest readable version is reported,
never selected` carried `assert.notEqual(LATEST_LANGUAGE_VERSION,
ADOPTED_LANGUAGE_VERSION)`. Adoption makes them equal and that line went red.

**It is a PREMISE, not the claim.** It asserts a gap exists for the source scan
above it to protect. The premise is false between an adoption and the next cut,
which is a normal state — but worse than the red is what survives it: once the
two constants are equal, the scan and every default assertion pass under the
WRONG rule, because "take the adopted version" and "take the latest readable
version" are indistinguishable when adoption IS the newest cut. Deleting the
premise would have left a control that cannot fail for the reason it exists.

`compiler.ts` anticipated exactly this, above `selectAdoptedProfileVersion`:
*"asserting it against live constants alone proves nothing."* So the replacement
exercises that rule on a **constructed** readable set whose adopted member is
deliberately not its last — where the two rules disagree and the wrong one is
observable regardless of what today's constants are — plus the fail-closed
refusal for an adopted version outside the readable set, plus agreement between
both live axes and the profile they produce. The LATEST relationship is now
stated as ordering and position (`indexOf(LATEST) >= indexOf(ADOPTED)`,
`SUPPORTED.at(-1) === LATEST`), which are true in both halves of the cycle.

The same test also gained the missing half of its coverage: it asserted the
composed package's language version and **nothing at all** about
`platformModuleDefinition()`, which is a first-party module outside the composed
package. A guard covering four of five modules does not observe the rule that
forces all five to move together.

## Boundaries honoured

No purchasing entity, no module mount, no product state machine, no change to
`LANGUAGE_VERSIONS`/`SUPPORTED_LANGUAGE_VERSIONS` membership, no move of
`ADOPTED_COMPILER_SEMANTIC_PROFILE_VERSION` (it stays
`northstar.compiler-semantic/v1`), no edit to `apps/web/src/surface-contract.ts`.
All five modules still declare `stateMachines: []`.

## Gates

_Filled in at the frozen SHA._
