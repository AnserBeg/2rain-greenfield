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

**Two production sites were found and deliberately NOT changed**, and what I
first wrote about them was wrong. `languageHasV2Features` (`normalize.ts:2229`)
and `languageUsesModuleProjectionShape` (`compiler.ts:1206`) both enumerate
`featureLevel === 'v2' || 'v3' || 'v4' || 'v5'`. Both already include v5, so
adoption does not break either. I recorded that *neither could be observed going
stale*, routed them, and then the deletion table refuted half of it — see the
table below. The corrected disposition lives in
`version-predicate-derivation`, which now carries two measurements instead of
one prediction.

## The 107-obligation unobserved exemption

Re-derived over the merged ledger; the digest was never retargeted.

| | Before | After |
|---|---|---|
| ledger digest | `29b4dc6c…` | **HELD** |
| obligations | 2050 | **HELD** |
| observed | 427 | **HELD** |
| `observedRelationScope` set digest | `e220b123…` | `5b8ec3e8…` |
| `observedOutsideRelationScope` | `b1ebb712…` | `395d05c5…` |
| `unobserved` | `6d13fcec…` | `73ef549e…` |

All three decision identities are new, because a decision is bound to the exact
record it was reviewed against.

**Three numbers held and the record still had to be re-authored, which is the
point.** The ledger derives obligations from the exported TYPE structure, not
from `ADOPTED_LANGUAGE_VERSION`, so 2050 could not move. The observed COUNT held
at 427 because the movement is a swap: **61 v5-valued obligations became
observed and the 61 v4-valued ones they supersede became unobserved** — 4 in
relation scope, 57 outside, and **every** obligation that entered or left is a
version value. Nothing else moved. *A count that holds is not evidence nothing
moved; the bitmap and the three identities are.*

**The row says the exemption "absorbs 107 obligations that are unobserved only
because adoption has not happened". Measured: 61 of the 107, not all of them.**
The other 46 sit on axes the first-party corpus instantiates at NO version —
unobserved at v4 for that reason, unobserved at v5 for the same one. They are
not adoption debt.

And the 46 are not a rounding error, they are this packet's own thesis in the
ledger's voice: **nine are `$.stateMachines[]` axes** — `.entity`,
`.initialState`, `.schemaVersion`, `.stateField`, `.states[]`, and four on
`.transitions[]` — plus `$.operations[].effect.transition`. Ten obligations that
only a product state machine can observe, and the first of those arrives with
`PUR-1`. The rest are predicate and filter nesting depths, quantity base units,
storage evolution and promotion, and the surface renderer.

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

## Three controls that addressed lineage entries by POSITION

All three went red on an adoption that changed nothing they guard. This is the
packet's second transferable finding.

**Corrected in round 6:** this section said TWO and listed two, while the
packet's claim said three. The third repair was real and committed but never
written up here — the record understated its own work, which is the same
defect as overstating it.

| Control | Was | Is |
|---|---|---|
| `consecutive lineage entries may share a normalized definition` (`compiler-semantic-profile.test.ts`) | `at(-1)` vs `at(-2)` — named the profile-adoption pair only while it was the head, which lasted exactly one packet | searches the lineage for the pair that shares a definition, asserts there is **exactly one**, and asserts it advances FORWARD along the compiler-semantic axis; the head's adopted profile is asserted separately, as the distinct claim it always was |
| `assertAttributedSearchCapabilityScenarioDelta` (`composed-application.test.ts`) | `previousSourceRelease(head)` vs head — read 163 where it expected 168 | the pair is pinned by release root (`4b254f50…` → `d726ad31…`), asserted still CONSECUTIVE, and the head is checked separately |
| ADR-0047 §6 direction 1, in `assertIntermediateBecomesServingOnlyAfterVerification` (`composed-application.test.ts`) | assumed the real head WAS a profile sibling and took `at(-2)` as its rollback target — true for exactly one packet, and its own sibling direction already manufactured a truncated lineage for the opposite reason | `throughProfileSiblingHead` truncates the lineage THROUGH the profile-only edge so the direction crosses the edge it names; both §6 directions then moved into their own test |

`previousSourceRelease` is deleted. It solved a real problem — `at(-2)` selects
the definition-equal sibling a profile adoption mints — but it solved it by
making the answer depend on where the head is, which is the same defect one step
out. Both spellings answer *which entry is near the end*; neither answers *which
entry carries the change this control is about*.

**Ruled in [ADR-0047 §8](../../decisions/ADR-0047-the-compiler-semantic-profile-is-the-projection-evolution-axis.md):**
evidence carries the language version it was recorded under, and a
re-identification is DETECTED rather than prevented. Stable ids across an
adoption would assert an equivalence that is false — a v5 storage target
materializes a state field a v4 one does not — precisely where `PUR-1`'s first
state machine lands. Owed to `PUR-2`, not built here.

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

## The deletion table

Run on the committed tree, one mutation at a time, each restored before the
next. **Every claim below is written from what died, not from what the mutation
was meant to prove.**

| # | Mutation | Reds | Dies at |
|---|---|---|---|
| P1 | `ADOPTED_*` reverted to v4, the six definitions stay v5 | 1 | `canonical-contracts-purity.test.ts:298` — the composed package's version follows ADOPTED |
| P2 | the six definitions reverted to v4, `ADOPTED_*` stays v5 | 1 | `:298` |
| P3 | **only `platform`** reverted to v4 | 1 | **`:307`** — the `platformModuleDefinition` assertion this packet added |
| P4 | materialization gate `candidate >= introducedAt` → `=== introducedAt` | **0** | **survivor** |
| P5 | `languageHasV2Features` drops `'v5'` | **13** | 9 unit + all 4 `adopted-language-shape` controls |
| P6 | `languageUsesModuleProjectionShape` drops `'v5'` | **0** | **survivor** |
| A3 | `selectAdoptedProfileVersion` returns the last readable member | 1 | `:258` — the constructed set whose adopted member is not its last |
| A4 | the same selector falls back instead of throwing | 1 | `:263` — *Missing expected exception* |

**Attribution, asked per check rather than per control.** P1, P2, P3, A3 and A4
all red the SAME test name, which is precisely the *four names, three specimens*
trap. Their line numbers are **298, 298, 307, 258, 263** — five mutations, four
distinct assertions, and P1/P2 sharing one is correct: they are the two
directions of a single pairing, and the pairing is what that line asserts. **P3
settles the question it was run to answer:** the platform assertion is not
decorative, it is the only thing in the tree that sees a platform-only
regression, because platform is outside the composed package.

**REVIEW ROUND 1 — REVISE, no production defect, two CONTROL defects. Both are
corrections to work this record previously defended, and both are here in the
reviewer's terms rather than mine.**

**(1) The purity scan deleted the subject it exists to inspect.** The strip
`^(?:import|export)\s[^;]*;` was there because an import clause spans lines. It
also removes every EXPORTED INITIALIZED DECLARATION, and
`DEFAULT_COMPILER_PROFILE` is exactly one. Measured on the real declaration: the
statement reduces to the empty string, so the scan erased the production
selector and then reported the tree clean. The cheapest broken tree the reviewer
named: point that exported initializer at `LATEST_LANGUAGE_VERSION` directly and
leave the selector helper untouched — the constructed three-element test still
passes, every live equality still holds because LATEST and ADOPTED are equal
today, and the wrong route surfaces only at the next cut. A second escape in the
same class: `constants.ts` was excluded WHOLESALE, so `ADOPTED = LATEST`
aliasing was invisible to the one control that forbids it.

Fixed with a syntax-aware walk rather than a narrower regex — a narrower regex
moves the boundary rather than removing it. `ImportDeclaration` and
`ExportDeclaration` are skipped; a `VariableStatement` carrying an `export`
modifier is neither, which is the whole point. `constants.ts` is now scanned,
with only a constant's own declaration name exempt. Four committed controls, not
a one-off check: an exported initializer selecting LATEST is detected, a pure
re-export is not falsely reported, an aliased adopted constant is detected, and
template-interpolated reporting still passes.

**(2) P4 was an unforced gap, not a structural survivor.** This record claimed
the materialization gate's `>=` vs `===` could not be observed without a
production change, on the reasoning that no version follows v5. The reasoning
was right and the conclusion was wrong: unreachable by an ordinary CALL is not
unobservable. The exported predicate's free bindings can be supplied, so a
committed test-only harness now evaluates ITS OWN EMITTED BODY — not a shadow
copy of the rule, not an assertion pinning its source tokens — against a
synthetic supported list that has a successor: `[v4, v5, v6]`, introduced at v5,
requiring `false / true / true`. The three live-constant assertions stay as its
companions.

**Only P6 remains a survivor**, and it is reported at the sample actually run:
`test:unit`, the full `test:compiler` and `check:app-release`. Integration and
postgres were not run against it. It stays routed to
`version-predicate-derivation` as *unobserved at this sample*, not *uncovered*.

### Review round 2 — REVISE, one control defect, no production defect

**The scan followed identifier SPELLINGS, not resolved BINDINGS.** Round one
rebuilt it to skip `ImportDeclaration` wholesale, which is correct for a plain
import and wrong for a renaming one:

    -  ADOPTED_LANGUAGE_VERSION,
    +  LATEST_LANGUAGE_VERSION as ADOPTED_LANGUAGE_VERSION,

The guarded name then appears ONLY inside the skipped declaration, every
selection site spells the local binding, and the binding is not a guarded name.
**Reproduced against the real `compiler.ts` before fixing anything:**
`DEFAULT_COMPILER_PROFILE` selected the newest readable version and the scan
returned green — as did every behavioural assertion in the same test, because
both constants are `v5` today, and the constructed `selectAdoptedProfileVersion`
control, because that helper is untouched. **This is a cheaper mutation than
round one's:** it edits a single import line rather than the initializer.

Closed by resolving bindings in a first pass. A guarded constant reached under
any local name joins the scanned set, so its uses are reported; the rename is
ALSO reported on its own, because aliasing one version constant to the name of
another is the indirection whether or not the alias is used. Renaming
re-exports are reported for the same reason one module out — a plain re-export
renames nothing and stays exempt.

Three more committed controls: an aliased import produces **two** findings (the
alias and the use — a scan reporting only the first would pass on an alias
introduced in one file and used in another), an unaliased import produces none,
and a renaming re-export produces one.

**Measured, R6:** the reviewer's exact mutation against the rebuilt scan reds at
`compiler.ts:4` naming the alias and at `compiler.ts:167`, which is the
selection inside `DEFAULT_COMPILER_PROFILE`.

**The class, stated plainly, since this is its third instance in one packet.**
Round one: a strip that removed the subject. Round two: a rename that changed
the subject's name. Both are the same failure — *the control looked for a
spelling where it should have asked what the thing IS* — and it is the same
shape as the packet's own sixth-omission sweep, which is about versions written
by hand where they were derivable. A scan over text has this failure mode
structurally; only resolution removes it.

### The third erasure mode, and the pattern all three share

Round 2's PASS arm routed one more finding; the orchestrator ruled it closes
here rather than in a queue row, because the packet owed a matrix anyway so the
close costs zero additional runs, and routing it would ship a Critical control
that a one-line glob edit silences.

**The scan discovered its own subject by glob and asserted nothing about the
result.** `productionFiles` came from `globSync`, the scan flat-mapped over it,
and `assert.deepEqual(selections, [])` passed whether the glob matched 99 files
or none. Every synthetic control stayed green because those call
`latestVersionSelections('synthetic.ts', …)` directly, never through the glob.
Measured: `packages/*/lib/**/*.ts` matches **0 files**, and the gate reports the
tree clean.

**A non-empty check does not close it** — a glob pointed at the wrong tree is
non-empty. What closes it is naming the file the gate exists to guard:
`packages/compiler/src/compiler.ts`, where `DEFAULT_COMPILER_PROFILE` is
declared, which is the selection site every round of this review has attacked.

**Three rounds, three erasure modes, one class.**

| Round | How the subject disappeared |
|---|---|
| 1 | a strip **removed** it — `^(?:import\|export)\s[^;]*;` ate the exported initializer |
| 2 | a rename **changed its name** — an aliased import bound it to a non-guarded spelling |
| 3 | a glob **never reached it** — the file set was discovered, not asserted |

*A scan over text has that failure mode structurally; only resolution removes
it.* Further findings in this class route to `scan-subject-discovered-by-glob`.

### Review round 3 — REVISE, two more control defects on the same gate

Both confirmed by reproduction before fixing, and both are ways the scan passed
while the fact was false.

**(1) The template exemption was a syntactic position, not a sink.** The rule
was *"parent is a `TemplateSpan`"*, which exempts EVERY interpolation regardless
of where the string flows. Measured:

    export const ADOPTED_LANGUAGE_VERSION =
      `${LATEST_LANGUAGE_VERSION}` as (typeof LANGUAGE_VERSIONS)['v5'];

preserves the runtime value (`ADOPTED= v5 LATEST= v5`), type-checks, leaves
compiled output unchanged, and **passed the scan**. At the next cut the adopted
value follows latest silently. Replaced with two independent rules: a reporting
template must carry literal text — a value-preserving copy cannot, since any
added text changes the string — and a template whose value becomes a version
binding is a selection even when it does carry text.

**(2) The scan never reached the release compilers.** It globbed
`packages/*/src/**` and `apps/*/src/**`, which excludes `apps/web/scripts/**`
— where `compile-app-release.ts` and `compile-demo-release.ts` both construct
compiler profiles. Those are not incidental tooling: `compileNormalizedDefinition`
is the implementation that makes this packet's own headline claim true, and the
demo compiler is why the shell root holds. This packet DISCLOSED the gap as W5
in its review prompt and did not close it; disclosure is not a gate. The glob now
includes `apps/*/scripts/**` (99 → 102 files) and all three selection sites are
pinned by name rather than discovered.

Measured: **R8** reds at `constants.ts:42`, **R9** at
`compile-app-release.ts:496`. Both passed before the fix.

**Four erasure modes on one control, across three review rounds.** A strip
removed the subject; a rename changed its name; a glob never reached it; an
exemption swallowed it after it was found. Every one was green, and every one
was found by a review arm rather than by this lane's own deletion tables — which
is `W1`/`W10` from the prompt, confirmed in substance.

### Finding 3: the branch a whole matrix cannot see

Review round 3 asked for a killing control on `languageUsesModuleProjectionShape`'s
v5 branch, and the orchestrator authorised the measurement rather than the guess.

**The mutated full matrix ran GREEN.** With v5 removed from that predicate:
`MATRIX_EXIT=0`, **589 assertions, 0 failures — byte-identical totals to the
unmutated run**, across unit, compiler, performance, integration, agent,
architecture, contracts, postgres, locale, browser and both closing gates. The
mutation was verified still present in the tree after the run and before restore.
The packet's earlier "unobserved at this sample" was too generous: it is
unobserved at EVERY sample the repository has.

**Why, and it is the interesting part.** The predicate gates exactly three
things, and all three are self-checks over the compiler's OWN output:

| Site | What it gates |
|---|---|
| `compiler.ts:424` | `validatePhysicalMappingRecords` on the lowered storage target |
| `compiler.ts:1955` | required family set — `REQUIRED_MODULE_*` differs from `REQUIRED_BASE_*` by exactly one member, `reporting` |
| `compiler.ts:2072` | the reporting-entity invariant |

The compiler satisfies all three by construction, so removing v5 changes no
output — it disables a safety net. **A disabled safety net is invisible from
outside unless you also introduce the fault it catches.**

**The specimen review asked for is not constructible.** A v5 package with an
invalid physical mapping cannot be authored: physical names are fixed-length
hashes (`nsm_c_…`, ~58 chars), so neither `COMPILER_PHYSICAL_NAME_COLLISION` nor
`COMPILER_PHYSICAL_NAME_TOO_LONG` is reachable from authored input. Building one
would mean corrupting the compiler's own output, which tests the corruption
rather than the branch.

**So the witness is the membership**, and the predicate is exported for it — on
the precedent `selectAdoptedProfileVersion` already sets in the same file, which
is exported for exactly this reason. The control asserts the adopted version
carries the module projection shape, and derives the boundary across the whole
supported list so the next cut inherits the assertion rather than needing one.

**R10:** removing v5 reds at `normalization.test.ts:217`, `false !== true`, on
the adopted-version assertion — the stated reason, not a downstream count.



| # | Broken tree | Result |
|---|---|---|
| R1 | exported initializer selects `LATEST` directly, helper untouched | **red** at `:199`, the live scan |
| R2 | `ADOPTED = LATEST` aliased inside `constants.ts` | **red** at `:199` |
| R3 | the detector's identity check disabled — scan reads zero input | **red** at `:223`, the vacuity control, a different assertion |
| R4 | materialization gate `>=` narrowed to `===` | **red** on the successor arm alone, by its own message: *"narrowing 'at or after' to 'exactly' reds here and nowhere else"* |
| R5 | predicate body rewritten to a behaviourally equivalent form | **no red — correct by design** |
| R5b | the predicate gains a third free binding the harness does not supply | **red**: `STATE_FIELD_INTRODUCED_AT is not defined` |
| R6 | `LATEST_LANGUAGE_VERSION as ADOPTED_LANGUAGE_VERSION` in `compiler.ts` — round 2's finding | **green before the fix**; after it, **two reds**: the alias at `:4` and the selection at `:167` |
| R7 | the scan's glob repointed to `packages/*/lib/**` — matches 0 files | **green before the pin**; after it, **red by name**: *"the scan must reach the file declaring DEFAULT_COMPILER_PROFILE"* |
| R8 | `ADOPTED_LANGUAGE_VERSION` = a template interpolation of `LATEST_LANGUAGE_VERSION`, value-preserving | **green before the fix**; after it, **red** at `constants.ts:42` |
| R9 | a `LATEST_LANGUAGE_VERSION` selection inside `compile-app-release.ts`'s profile | **green before the fix** (file unscanned); after it, **red** at `:496` |
| R10 | v5 removed from `languageUsesModuleProjectionShape` | **green across the ENTIRE matrix** (589/0, unchanged); after the membership control, **red** at `normalization.test.ts:217` |

**R5 and R5b together characterise the faithfulness guard, and R5 alone would
have misdescribed it.** The guard cannot fail on a behaviour change — an
equivalent body SHOULD agree, since the control measures behaviour rather than
spelling. What it catches is the harness losing the ability to reconstruct the
export, which is the standing hazard of a `toString()`-based control. R5 was
written expecting a red, got a green, and the green was right; R5b is the
mutation that tests what the guard actually guards.

P5 is why this table exists. It refuted what this record originally said about
both sites — that neither could be observed going stale — and
`version-predicate-derivation` was rewritten from the measurement.

### Review round 4 — BLOCK, and the packet stops patching

Round 4 found a FIFTH escape on the purity scan and invoked the convergence
rule. It was right on both counts, and the orchestrator's round-2 ruling — that
further findings in this class route rather than get fixed — was right when it
was made and was overridden by this lane. Round 4 is the cost of that override.

**The fifth escape needs no obfuscation:**

    profile.languageVersion === SUPPORTED_LANGUAGE_VERSIONS.at(-1)!

selects the newest readable version using an identifier production already
imports. Measured on the real `DEFAULT_COMPILER_PROFILE`: it still resolved to
v5, every behavioural assertion held, the scan stayed **green**.

**The claim is narrowed rather than the table grown** — the doctrine's answer to
a third recurrence, and this is the fifth. The control is renamed to what it
proves, *no production file references a `LATEST_` constant except to report
it*, and records what it does not: that the newest readable version is never
SELECTED. Closing that needs a production selector seam taking the supported
profiles and adopted members as parameters, routed to `adoption-selector-seam`
with the `.at(-1)!` mutation as its owed red.

**Four repairs, five escapes, each cheaper than the last.** That progression is
the finding. A scan over source text classifies SPELLINGS; only a seam that
takes the choice as a parameter can observe the CHOICE.

### Round 4's second finding corrected the ADR, not just the control

The scenario-identity control asserted `.some(...)` where ADR-0047 §8 published
**69 of 163**, and a subset check where it published **0 of 163**. Both are now
asserted exactly.

**Building that control refuted the ADR's own wording.** §8 said *"69 scenarios
were re-identified"*, and that reading is not expressible: **no key
distinguishes all 163 scenarios except the id itself.** Every combination of the
recorded non-id fields — `kind`, `entityId`, `subjectId`, `probePolarity`,
`targetEntityId`, `provider` — collapses to **105 unique values**. Under the
best available key only **11** signatures map to a different id; the raw id-set
difference is **69**. So 69 is a difference between identity SETS, not a count
of scenarios that kept their meaning and changed their name.

The correction strengthens §8's ruling rather than weakening it: **an evidence
reader cannot re-key orphaned evidence by matching on what a scenario verifies,
because 58 of 163 are indistinguishable that way.** Recording the language
version is not one option among several — it is the only handle there is.

The signature comparison is now a MULTISET rather than a set, because a set
comparison would tolerate a dropped scenario while a duplicate signature covered
for it.

### Review round 5 — BLOCK, and the scan is retired as semantic evidence

Round 4 narrowed the purity claim. Round 5 found the narrowed claim still
outran its classifier, with a specimen that NAMES the guarded constant:

    const selected = `${LATEST_LANGUAGE_VERSION}:selected`;
    languageVersion: selected.slice(0, -9)

Reproduced against the live scan: `MODULE_COMPILER_PROFILE` resolved to **v5**
and the scan reported the tree **clean**. That is inside the narrowed claim, not
the routed one — the sixth escape in a single class.

**The defect was never the rule; it was calling a syntactic position a semantic
category.** "Interpolated into operator-facing text" is a claim about INTENT.
What the code can see is "inside a template carrying literal text whose value
does not reach one of six named bindings". Five rounds of patching the second
never turned it into the first, and each repair was correct while the next
escape was cheaper than the last.

**So the scan is retired as semantic acceptance evidence.** It is renamed to the
syntactic fact it measures — *production references to a `LATEST_` constant
occur only inside literal-bearing templates* — and its header states plainly
what it does NOT establish: that those templates are operator-facing, that the
value is not subsequently selected, or that newest-readable is not reached
without naming it. No seventh destination name was added.

**Consequence, recorded rather than softened: the ADR-0047 §2 rule has no
semantic gate right now.** The behavioural assertions still hold every default
to ADOPTED, and `adoption-selector-seam` owns the real proof, carrying both
escape 5 and escape 6 as its owed reds. A packet that needs that rule enforced
before `PUR-1` should treat that row as a prerequisite rather than a cleanup.

### Review round 6 — BLOCK, and one finding turned into a mechanism

Three findings, all CONTROL, all confirmed by measurement.

**(1) C6's premise lived in prose.** The ADR's ruling rests on "no recorded
non-id key distinguishes all 163 scenarios", and the committed control asserted
only the consequence. It now derives the six-field key and asserts **105**
distinct values, **11** non-singleton groups, **69** scenarios inside them.

**And the arithmetic in the ADR was wrong.** 163 rows over 105 keys is **58
excess rows**, not "58 indistinguishable scenarios" — the population depends on
the group-size distribution. Measured: nine groups of 6, one of 7, one of 8,
totalling **69 scenarios**.

**Which is the same 69 whose ids change, and it is now asserted as an identity.**
The scenarios that share every non-id field with a sibling ARE the scenarios
whose identity moves. That is a mechanism: inside an ambiguous group the only
separator is version-bearing, so the group re-fingerprints together, while a
scenario determined by its own fields keeps its id. Re-identification is not
scattered — it is exactly the population that cannot be re-keyed by meaning,
which makes ADR-0047 §8's ruling airtight rather than merely reasonable.

**(2) C7 disclaimed semantic status in its header and asserted it everywhere
else.** The failure message read *"a cut-but-unadopted version must not be
selected"*, and the commentary called the scan *"the only thing standing between
a cut version and every caller's default"* — while the header above said it
established none of that. The message now names only the syntactic violation,
the enforcement language is gone, and the behavioural assertions are described
as what they are: current-value and helper-behaviour pins, not route proof.

**(3) C5 said three; the record listed two.** The third repair — ADR-0047 §6
direction 1 assuming the head was a profile sibling — was real, committed, and
never written up. The section is now three and names it. The record understating
its own work is the same defect as overstating it.

## What the first matrix cost, and why it is the packet's own theme again

The first full matrix ran every suite green — 0 reds across unit, compiler,
performance, integration, agent, architecture, contracts, postgres, locale and
browser, with the compile-budget gate MEASURED at `cpu_idle_pct=99.6` — and then
failed on the last gate but one:

    language coverage: FAIL
    Observed argv mismatch for compiler: expected [...10 files], received [...11 files]

**The compiler suite's file list is written by hand in THREE places**:
`package.json`'s `test:compiler` command, `repository-hygiene.test.ts`'s reviewed
inventory, and `test/helpers/reachability-producers.ts`'s producer argv. Adding
one test file updated two of them. `repository-hygiene`'s own control compares
the command against the discovered glob, so it is blind to the third copy — the
same *one value written by hand in more than one place* shape this packet spent
its sweep on, one layer out from versions.

The mechanism caught it, which is the system working. What it cost is the
discovery point: **~40 minutes of green matrix before a list mismatch surfaced**,
which is the `matrix-preflight` row's complaint in a different gate. Routed as
`suite-inventory-copies`.

Also recorded, because it nearly went the other way: the background wrapper
reported the matrix as **exit code 0** while the run had failed. `MATRIX_EXIT=1`
was read from inside the log, which is the false-green `5g3-sm-impl` recorded and
the reason its rule exists.

## Gates

**The `6e0b56c` matrix is SUPERSEDED** by review round 6, which changed
executable content in two test files. Fresh matrix owed.

### A matrix pre-flight instrument, for the next lane

`matrix-preflight` asks for the idle check to happen at matrix START rather than
at the exclusive gate sixteen minutes in. This packet built one and used it, so
it is recorded here rather than left in a scratchpad.

Before the round-2 matrix the machine read **80.1 / 76.1 / 79.5** then
**97.1 / 95.2 / 91.8** over six 5-second samples — three of six under the 90%
floor, bimodal, with no test suite running anywhere. The load was agent runtimes
mid-turn, which is exactly the condition the floor cannot distinguish from real
contention. Launching would have been a coin flip on
`COMPILE_BUDGET_INDETERMINATE` at a cost of a full run.

The instrument: poll `/proc/stat` on a 5-second interval and require **four
CONSECUTIVE samples at or above 93%** before launching. A single sample is what
the gate itself takes and is why the gate is a coin flip under this load; a
streak is what distinguishes a quiet machine from a lull between turns. Run it
in the background and let it notify — it costs nothing and it converts a wasted
matrix into a wait.

It also earns its keep by failing honestly: on its first use it returned
`NOT_QUIESCED_AFTER_10_MIN`, because another lane had taken the slot during the
wait. That is the correct answer, and a lane that had launched instead would
have raced a running matrix.

**One trap it exposed, worth more than the instrument.** A targeted test run
under `run-with-test-lock.mjs` while another lane holds the lock exits with
`TEST_GATE_LOCK_BUSY` after 300s and produces NO test output. A grep for
`^not ok` over that output returns nothing, which reads exactly like a pass.
This packet nearly recorded one such empty result as a measurement. Read the
lock diagnostic, not just the assertion lines — or, for a control that touches
no database, port or shared state, run it without the lock wrapper at all.
