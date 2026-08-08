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
