# ADR-0047: The compiler-semantic profile is the projection evolution axis

Date: 2026-08-06
Status: accepted — ruled by the orchestrator on `proj-disc`'s measured design pass,
whose probe is preserved at `packet/proj-disc` `a9146d2` (probe only; never merged).
Tier: Critical (it decides how every compiled projection may ever change)

## Context

**Every compiled projection is frozen against additive change, and this was
discovered the expensive way.** `apps/web/release/app.compiled.json` is a lineage
in which each historical entry must reproduce its recorded content-addressed
release root, and reproduction recompiles the stored bytes with *today's* code.
Anything that changes compiler output for unchanged input therefore invalidates
recorded history.

`U2-num` hit this trying to add one boolean's worth of column type. `U5` hits the
same wall harder — skeleton geometry, disclosure tier, latency class and
optimistic-eligibility are new fields on the `slots` array inside
`surfaceManifestPayload`. `U6` hits it too: `REQUEST_RUNTIME_PROJECTION_FAMILIES`
(`packages/runtime/src/request-runtime-view.ts:24`) is a **frozen five-family
set**, so a compiled message catalog either rides the surface manifest or adds a
sixth family, and a new family adds a reference and an artifact to the manifest,
which moves the root as well. **The freeze is not one row's problem. It sits in
front of the entire compiled-feedback program.**

Four approaches were measured and failed before this ADR:

| Approach | Result |
|---|---|
| Emit the field unconditionally | entry 0 fails `COMPILER_HISTORICAL_REPRODUCTION_MISMATCH` |
| Emit only when non-empty | entries 0–3 reproduce; entry 4 fails |
| Gate on `languageVersion`, as `surfaceRole` does | no gate discriminates — entries 3–6 and the head are all `v4` |
| Bump `payloadSchemaVersion` | `payloadSchemaVersions` is a module-level constant, so a bump moves every root including history |

ADR-0043 §1's truncation escape is also unavailable: `--truncate-invalid-lineage`
refuses with *"no valid application prefix to retain"*, because entries 0–5
survive only under `mustReproduceHistorical`'s leniency and cannot be minted
under ADR-0042's tightened rules.

## Decision

### 1. The compiler-semantic profile is the axis on which projections evolve

`releaseManifest.semanticProfileDigest` is `hash(HASH_DOMAINS.profile,
input.profile)` (`packages/compiler/src/compiler.ts:277`) — **the whole profile
object is hashed into the release root.** That is what makes the profile a real
discriminator rather than a label, and it is why every recorded entry already
carries its profile in its attestation. The durable per-entry discriminator was
already on disk; nothing needed inventing, only reading.

Projection payload shape dispatches on `profile.compilerSemanticProfileVersion`,
exactly as `surfaceRole` already dispatches on `languageVersion`
(`packages/compiler/src/projections.ts:540`).

**`OUTPUT_PROTOCOL_VERSION` does not move.** The design pass expected to bump it
and measured that it does not need to, which removes nine reader sites from
scope. Only two sites compare a profile version against a current constant —
`packages/postgres-provider/src/release-repository.ts:692` and `:751`. Every
other occurrence is a pass-through or a recorded-versus-recorded comparison;
`request-runtime-view-service.ts:788` compares the manifest to the stored row and
needs nothing.

### 2. The axis is append-only, and readable before it is adopted

It mirrors `LANGUAGE_VERSIONS`: a named entry and a supported-list member are
appended; an existing version is never renamed or redefined.

**The adoption discipline is preserved verbatim from
`DEFAULT_COMPILER_PROFILE` (`compiler.ts:111`):** *"Keyed to the ADOPTED version,
not the latest readable one. A newly cut but unadopted version must not silently
become every caller's default profile."* Cutting a profile version and adopting
it are two events, and they may land in two packets.

### 3. Widening the Freeze F literal types is anticipated evolution

`packages/compiler/src/protocol.ts` is a ratified **Freeze F** artifact.
`CompilerSemanticProfile` pins `compilerSemanticProfileVersion` and its siblings
to `typeof <constant>` **literal types**, so the type system itself forbids a
second value. Widening those to unions (`protocol.ts:158`, `:416`, `:468`) is
authorized here as anticipated evolution, on the precedent ADR-0015 already set:

> Emitting it changes `northstar.storage-target-payload/v1` to **v2** under that
> ADR's own evolution rule; it is **not a canonical-language event, because
> nothing in the authored surface changes.**

That sentence decides this ADR's central question as well as its own.

### 4. A profile move mints a new lineage entry, and consecutive entries may share a normalized definition

**This is the non-obvious consequence and the reason this ADR exists rather than
a one-line grant.** The lineage implicitly assumed it advances only when the
authored source changes. Under this decision it also advances when the *output
contract* changes, so two consecutive entries may have byte-identical normalized
definitions and different release roots.

The probe surfaced this rather than predicting it:
`test/postgres/composed-application.test.ts:3479` reads `applications.at(-2)` and
asserts `168` scenarios; with a new same-source entry appended, `at(-2)` now
points at a definition-equal sibling and reads `163`. This is the second member
of the class, after `composed-application.test.ts:99`'s `>= 6` — which is a floor
and remains satisfied.

**Rewriting the predecessor entry in place is forbidden.** That entry's root is
recorded and may be activated; overwriting it is precisely the history rewrite
the freeze exists to prevent. Assertions that assumed consecutive entries differ
in source are corrected to say what they actually mean.

### 4a. A source-changing entry may carry no semantic delta — added 2026-08-06

§4 named *position*-dependence. `U5b` found a second, distinct fragility in the
same family, and it is not fixed by `previousSourceRelease`.

`assertAttributedSearchCapabilityScenarioDelta`
(`test/postgres/composed-application.test.ts`) already uses that helper, so it is
correctly position-independent. It nonetheless broke, because it is
**delta**-dependent: it compares the head against the last entry whose *source*
differs and asserts a 168→163 search-capability scenario delta. A source change
that carries **no semantic delta** — declaring a field gated on an unadopted
profile version — makes `previous` the immediately preceding entry, and the delta
the assertion attributes to named entities collapses to nothing.

**So there are two questions, not one.** *Which entry precedes this one?* is
answered by `previousSourceRelease`. *Which entry carries the delta I am
attributing?* is not, and an assertion that attributes a change must locate the
entry that made it rather than the entry that came before.

**The practical rule this yields:** an authored change whose feature reaches no
artifact still mints a lineage entry, and that entry is invisible to every
assertion reasoning about compiled consequences while being fully visible to every
assertion reasoning about position or source identity. Declaring a field gated on
an **unadopted** profile version is exactly that shape — `U5b` measured
`disclosureTier` in zero artifacts of either entry while eight artifacts differed
by digest churn. **Do not mint one.** Land the declaration in the packet that
adopts the version, where it carries a real difference and the affected
assertions are corrected once against a delta that means something.

### 5. Every entry reproduces under the profile its own attestation records

Never under today's constant. `reproduceHistoricalApplication`
(`apps/web/scripts/compile-app-release.ts:403`) already derives `languageVersion`
and `normalizationProfileVersion` from the stored definition while inheriting the
rest from current constants; the profile version joins what is derived.

**This invariant is gated, not merely stated.** The design pass recorded a red
for its inverse: reproduction inheriting today's constant instead of the recorded
one fails at the bootstrap root.

### 6. A profile-only lineage edge is not rollback-eligible, and must refuse by its own name

Ruled 2026-08-06 on `proj-disc-impl`'s stop-and-report, verified independently
against the code before ruling.

**The mechanism.** `ensurePersistedRelease`
(`packages/postgres-provider/src/composed-application-runtime.ts:1065`) looks up a
package revision by `content_hash` and reuses it. Two profile siblings have the
same normalized definition, so they share one revision. The reverse-transition
policy then computes `exact_forward_lineage` as `target_revision.parent_revision_id
= source_revision.revision_id` — which, for one shared revision, asks whether a
revision is its own parent. It never is. Neither lineage direction holds,
`authorizeReverseTransitionIfApplicable` returns `null`, and rollback refuses.

**The revision is not the defect.** A package revision is the *source*; a tenant
release is the *compilation*. Two profile siblings genuinely are the same source
and correctly share a revision — the compiler-semantic profile is a property of
how the source was compiled, not of what it is, and pushing it into the revision
key would put a compilation fact in the source table. `§1`'s
`normalizedDefinitionDigest` coupling at `release-repository.ts:704` depends on
that separation.

**The defect is that a release-level operation is authorized by revision-level
parentage.** For source-changing edges the two coincide, which is why this was
never visible. §4's same-source entries separate them for the first time.

**This ADR does not fix it, and the implementing packet must not either.** The
fix touches release-activation authorization — the safety valve itself — and
belongs in its own packet with its own review. What is owed here is smaller and
non-negotiable:

> **A profile-only edge must refuse with a distinct, accurate code.** Today the
> second refusal reuses `ROLLBACK_TARGET_NOT_IMMEDIATE_PREDECESSOR` with the
> message *"rollback target does not reverse an exact compiled lineage edge"* —
> and the target **is** the immediate predecessor; the index check passed. A
> refusal that misnames its own cause is exactly what
> [ADR-0046](ADR-0046-rollback-activates-history-and-defects-refuse-by-name.md)
> forbids, and it would send an operator hunting the wrong fault at the worst
> possible moment.

The named refusal is a declared limit in the [ADR-0044](ADR-0044-search-capability-is-derived-and-never-silently-empty.md)
sense: structural absence, declared and observable. Silent inability is what that
ADR forbids, and an accurate name is what converts one into the other.

### 7. An optional authored key rides the adopted language version — ruled 2026-08-07 on `U5b`'s review

`U5b`'s review arm found that `disclosureTier` is refused only inside the
`LEGACY_LANGUAGE_VERSION` block of `normalize.ts`, so `v1`, `v2`, `v3` and the
adopted `v4` all now admit an authored key every one of them previously rejected,
and read that as retroactive widening of an adopted language.

**The observation is correct as stated, and two further facts bound it.**
`renderer` and `surfaceRole` sit in that same `v0`-only list one line above, so
this is the standing pattern rather than a `U5b` regression. The opposite pattern
also exists: `resolveMatchKeys` refuses *"prior language versions"* for a key
introduced at language `v2`. The repository has been running both without a rule.

**The rule: an OPTIONAL authored key, additive and never materialized by
normalization, rides the adopted language version in place.** Reproduction
recompiles a recorded entry's **stored normalized bytes**, and no recorded
definition carries the key, so no release root moves. Nor is the change silent —
the language conformance ledger derives its obligations from
`VersionedAuthoredApplicationPackage` and minted four for `disclosureTier`, which
is this repository's own authority for an authored-surface change. A key that
arrives, is counted, and is exempted on a recorded rationale is versioned by the
ledger even when it is not versioned by an identifier.

A `v5` cut is refused on the cost this ADR already prices below: an
application-wide adoption event plus conformance obligations, spent on one
optional key, and it does not generalise to the next one.

**The asymmetry with §1 is real, and it is bounded rather than dismissed.** The
profile axis is versioned per change because a compiled byte reaches a recorded
root. The authored axis is not, because an unused optional key reaches nothing.
That reasoning fails the moment an authored key becomes **required**, or is
**materialized** into normalized output — either one changes stored bytes, and
either one owes a language cut. Both are the conditions `DEFAULT_DISCLOSURE_TIER`
already documents as measured (`COMPILER_INPUT_NOT_CANONICAL` at
`decodeSchemaCheck`), so the boundary is observed, not asserted.

**What the finding got right and this ruling does not excuse:** `U5b`'s positive
fixture is authored at `v3`. A test that proves the rule must be authored at the
adopted version — a `v3` fixture proves the widening instead of the behaviour, and
is the only evidence in the packet that anyone widened anything.

## Why not a `v5` language adoption

`v4` already carries the declared field types. A `v5` cut would mint a language
version with **no authored-surface change**, and then owe the language
conformance ledger obligations for it — obligations with nothing to bind to. It
also does not generalise: the next projection field would need `v6`.

The conformance ledger is the sharpest asymmetry. It derives obligations from
`VersionedAuthoredApplicationPackage` and tracks no profile version, so this
decision leaves it untouched where a language bump would not.

The routes are not close, and the design pass was explicitly invited to report a
tie.

## What this ADR does not decide

- **Which consumer rides the mechanism first.** Numeric alignment, `U5`'s slot
  fields and `U6`'s catalog are separate packets. The discriminator lands alone;
  bundling a consumer would mix a mechanism whose evidence is *"history still
  reproduces"* with a feature whose evidence is a rendered page.
- **Whether `U6`'s catalog rides `surfaceManifestPayload` or becomes a sixth
  projection family.** Both are unblocked by this; the choice is `U6`'s.
- **Any change to `OUTPUT_PROTOCOL_VERSION`**, which stays where it is.

## Consequences

- The implementing packet owes a negative control analogous to the one that
  already guards a language cut — *cutting semantic profile v1 leaves v0 output
  byte-identical* — because `legal-entity-query-scope.test.ts:421` exists for
  exactly this reason on the language axis and fired correctly during the probe.
- It also owes a red for §4: an assertion that consecutive entries may share a
  normalized definition, so the rule is observed rather than declared.
- Roughly seven pinned expectations need re-deriving — four golden files,
  `v1-v2.release.structural.golden.json`, and inline digests in `freeze-b.test.ts`
  and `legal-entity-query-scope.test.ts`. `inventory-contract.release.golden.json`
  did not fail in the probe and may be stable; **measure it rather than assuming**.
**A profile version freezes at ADOPTION, not at the cut — measured 2026-08-06,
correcting this paragraph's original text.** `U5-design` ran five variants of
`check:app-release` and the result is better than either branch anticipated:

| Variant | Result |
|---|---|
| baseline | exit 0 |
| field gated on `v1` (v1 adopted) | **exit 1** |
| `v2` cut but **not adopted**, field gated on `v2` | **exit 0** |
| `v2` cut and adopted | rebuild, exit 0, entry 8 minted |
| `v1`-gated field after `v2` demoted `v1` to history | exit 1 |

So the axis is consumed **one version per adoption**, not one per projection
change — and **adoption is schedulable**. Fields accumulate on an unadopted
version and land together. An adopted version can never gain a field; that half of
the original claim was right.

**The mechanism originally stated here was also wrong.** Entry 7 is the *serving
head*, not history, so a `v1`-gated field never reaches
`reproduceHistoricalApplication`. It fails whole-lineage serialization equality at
`compile-app-release.ts:334` — a hard throw with no rebuild route, since `:55` is
the entry point both `--check` and the build take. The original phrasing becomes
literally true only *after* `v2` adoption, where the failure is
`COMPILER_HISTORICAL_REPRODUCTION_MISMATCH` on entry 7's root.

**The adoption price is now known rather than estimated:** 7 `test:compiler`
failures across 5 files, `test:postgres` 188/188 green — a second profile-only
sibling does not re-break the `at(-2)` class — and
`inventory-contract.release.golden.json` again did not move.

- `check:demo-release` has no parallel reproduction path — `compile-demo-release.ts`
  compiles one fixture and string-compares — so it needs regeneration, not
  mechanism.
- The probe measured that only release roots and the surface-manifest projection
  move; `storage-target.manifest.*` and `storage-target.chunk.*` are stable.

## §8 — A language adoption re-identifies verification scenarios; a profile adoption does not

Added 2026-08-10 by `LANG-ADOPT-v5`, from a measurement it was not looking for.

### The measurement

Across the canonical-language v4 → v5 adoption, on the recorded application
lineage:

| | |
|---|---|
| scenario count | **163 → 163** |
| `kind \| entityId \| subjectId` multiset | **identical** |
| recorded ids absent from the other plan | **69 of 163** |
| ids changed by the ADR-0047 §4 profile-only edge (entry 6 → 7) | **0 of 163** |

**CORRECTED THREE TIMES. The decision below stands; the reasoning that first
supported it was wrong, and the third correction reverses it.**

The first two corrections narrowed *"69 scenarios re-identified"* and then fixed
an arithmetic slip, both on the premise that **no key distinguishes all 163
scenarios except the id itself.** That premise was FALSE, and it was false for a
self-inflicted reason: the key used to establish it was a hand-picked tuple of
six fields — `kind`, `entityId`, `subjectId`, `probePolarity`, `targetEntityId`,
`provider` — described as "every recorded non-id field". It is not.

Recorded scenarios carry **fifteen** distinct fields across seven kinds.
`declaredEvidence` alone adds `assertionId`, `evidenceKind`, `expectedOutcome`,
`expectedDiagnosticCode` and a full `invocation`; `uniquenessFold` adds
`nfkcPolicy`. The tuple therefore collapsed exactly the 69 `declaredEvidence`
scenarios into 11 groups, and that collapse — an artifact of the projection —
was read as a property of the data.

**Measured from the production scenario object, excluding only the two generated
identity fields and normalizing `schemaVersion` recursively:**

| | |
|---|---|
| semantic-key uniqueness, v4 plan | **163 of 163** |
| semantic-key uniqueness, v5 plan | **163 of 163** |
| semantic key sets across the adoption | **identical — a total bijection** |
| scenarios re-identified | **69, every one `declaredEvidence`** |
| `assertionId` + `evidenceKind` alone distinguishes those 69 | **69 of 69** |

**So evidence CAN be re-keyed by meaning.** Every scenario in the v4 plan has
exactly one counterpart in the v5 plan under a version-normalized reading of its
whole payload. The earlier claim that re-keying is impossible, and that
recording the language version is therefore "the only handle there is", is
withdrawn.

**The mechanism, now measured rather than inferred:** `declaredEvidence` is the
only kind carrying an `invocation`, and an invocation nests canonical references
that carry their own version stamps. Those stamps are fingerprint inputs, so
precisely that population re-fingerprints. Every other kind carries no
version-bearing payload and keeps its identity. The 69 is not a coincidence and
not an ambiguity — it is the count of scenarios that reference a versioned node.

### Why this is consequential rather than curious

`PUR-2` and `SAL-2` both key posting evidence by scenario id. Durable
verification evidence recorded before an adoption therefore matches only
partially afterwards — and the failure is silent in every direction a gate
currently looks: the plan is the same size, verifies the same subjects, and
produces the same outcomes. The orphaned fraction surfaces as evidence that
"was never recorded" for scenarios that were, in fact, recorded and executed.

This is the shape `LANG-ADOPT-v5` spent three review rounds on, one layer out: a
fact that holds under every count while its identity moves underneath.

### Decision

**Evidence carries the language version it was recorded under, and a
re-identification is detected rather than prevented.** Scenario identity is NOT
made adoption-stable.

**RE-JUSTIFIED after the third correction, because the original argument was
withdrawn.** The decision no longer rests on re-keying being impossible — it is
demonstrably possible, by total bijection. It rests on three things that survive
the correction:

1. **Stable ids across the boundary would assert a false equivalence.** A v4 and
   a v5 storage target verify different bytes; v5 materializes a state field v4
   does not. An identity deliberately omitting the version cannot distinguish
   *the same scenario* from *a scenario that now verifies something else* —
   ADR-0047 §1's reasoning about `semanticProfileDigest`, one level down. That
   divergence lands exactly where `PUR-1`'s first state machine does.

2. **Re-keying is possible but nothing does it.** The bijection requires a
   recursive version-normalizing comparison over the entire scenario payload,
   including nested invocation references. No evidence reader performs one. A
   capability that exists only in a test is not a property of the system.

3. **The version stamp is the cheap signal that a re-key is needed at all.**
   Without it a partial id match is indistinguishable from missing evidence;
   with it, the boundary is legible and the expensive comparison can be run
   deliberately.

The rejected alternative — excluding version stamps from the fingerprint so ids
survive adoption — is refused on (1).

### Owed, and not built here

`LANG-ADOPT-v5` measured this and ruled it; it did not implement it, because
durable evidence is `PUR-2`'s subject area and this packet ships no purchasing
entity. What is owed:

- verification evidence records the `languageVersion` of the release it was
  recorded against;
- a reader comparing evidence across releases that differ in language version
  reports the boundary explicitly rather than reporting unmatched scenarios;
- a control that reds when evidence from one language version is silently
  credited to another.

Until that lands, **a language adoption partially orphans durable verification
evidence, and nothing observes it.** That sentence is the row's content, not a
prediction.

## §9 — v2 adoption, measured. Three claims above are corrected by it

Added 2026-08-14 by `profile-v2-adoption`, the packet §4a addressed its closing
instruction to. The decision is unchanged; three recorded measurements are not.

### The accumulation window closed carrying THREE shapes, not two

`disclosureTier` (`U5b`), `targetEntityId` (`relation-contract-integrity`) and
**`fields`** — per-field kinds, landed by `e29935d`. Every document describing
the adoption named the first two. The third is the largest by artifact delta and
the only one that moves a compatibility floor, so the blast radius was
under-priced everywhere it was written down. **When an accumulation window is
scheduled to close, enumerate its members from the gate rather than from the
queue** — `grep` the version constant in `projections.ts`, do not trust the row.

### §4a's instruction is discharged, and it was load-bearing for a reason §6 did not state

The obligation was to land the declaration in the adopting packet "where it
carries a real difference". It does, and the difference is bigger than §4a
claimed: it decides **what kind of lineage edge adoption is**.

Measured in both arms:

| | normalized bytes vs predecessor | edge |
|---|---|---|
| adoption alone | **identical** | profile-only — §6 applies, rollback refuses |
| adoption + §4a's declaration | **differs** | ordinary source edge — rollback behaves normally |

So the §4a obligation is *what keeps this edge ordinary*. Had adoption shipped
alone it would have produced exactly the profile-only sibling §6 describes, and
`rollback-release-edge`'s open defect would have been reachable on the serving
head. **A future profile adoption carrying no authored change will land on it.**
§6 should be read as still live, not as discharged by this packet having missed it.

### `proj-disc-impl`'s "exactly three keys move" does not generalise

That measurement — that a profile adoption moves only
`compilerSemanticProfileVersion`, `semanticProfileDigest` and `cacheInputDigest`
— was true of v1 adoption and is **false of v2**. Five top-level release-manifest
keys move, adding `projections` and `artifactClosure`, because v1 adoption
carried no projection payload while v2 carries three real emissions. The
Consequences section's other predictions held exactly: `storage-target.manifest.*`
and `storage-target.chunk.*` goldens are byte-identical, no projection family was
added, and `check:demo-release` needed regeneration rather than mechanism.

The adoption price, measured: **12 `test:compiler` failures across 6 files**, one
`test:integration`, three `test:architecture` sites, and four goldens re-derived
against four held. The estimate above says seven across five.

### What adoption COST, which nothing anticipated

The compiler-semantic axis was the last place in the tree where *take the adopted
version* and *take the newest readable one* could disagree — readable
`[v0, v1, v2]` with adoption on v1. Adoption made adopted == last-readable on
**both** axes, so `adoption-selector-seam`'s owed `.at(-1)!` red can no longer be
made to fire against production at all. §2's "readable before it is adopted"
discipline is what created that discriminator, and consuming a version consumes
it. **Cutting the next version restores it; until then the selector rule has no
live negative control.** Recorded so the next adopting packet knows the cost is
recurring rather than one-off.
