# Canonical application language v0-experimental

Status: v0-EXPERIMENTAL downstream contract
Owner: `@north-star/canonical-model`
Language version: `v0-experimental`

## Freeze meaning

This is Freeze A for G1, not production-v1 ratification. Downstream G1 packets
consume it unchanged. A material correction uses the bridge/reopen rule in
G1-P0: stop parallel consumers, amend the versioned contract, rerun its gates,
and explicitly re-freeze. Production v1 is a later gate after representative
inventory, purchasing, and sales definitions compile through every promised
projection. Closed means closed within this version, not permanently complete.

The canonical language is one versioned declarative semantic envelope. Zero
platform-code module generation applies only to behavior expressible in its
typed algebra or through a versioned, typed, effect-declared registered
capability. A new invariant engine or protocol is platform work; a hidden hook
is never a language extension.

## One desired-state representation

There are two in-memory/API layers and one persisted authority:

1. **Authored** is sparse transport and provenance. Immutable defaults may be
   omitted. It is never active application truth and its original bytes are
   not retained as a peer representation.
2. **Normalized** is complete, deterministically ordered, and immutable. The
   exact canonical UTF-8 bytes of this value are
   `AppPackageRevision.desiredState` in G1-P3. The revision envelope records
   the language, normalizer, canonicalization profile, hash algorithm, and
   content hash used to verify those historical bytes.
3. Patches address the canonical-authored projection and produce a new full
   normalized snapshot. They do not become an overlay, event-sourced
   application authority, or independently active lineage.

The executable laws are:

- `normalize(normalize(x))` has identical canonical bytes;
- equivalent sparse, explicit-default, and reordered authored forms converge
  to identical normalized bytes; and
- `normalized -> canonicalAuthored -> normalized` has identical canonical
  bytes.

Defaults in `IMMUTABLE_DEFAULTS_V0` are part of the language version. Changing
one requires a new language/normalizer version and migration of any stored
sparse authoring artifact. Normalized desired state is never migrated in
place; a new immutable revision is produced.

## T1-T11 contract

1. One canonical encoding per construct; accepted variants normalize before
   hashing and aliases are absent.
2. Sparse authored and complete normalized layers obey the laws above; only
   normalized canonical bytes are desired-state authority.
3. Ordered siblings carry explicit integer `orderKey` values. Array position
   has no meaning. Set-like collections sort by canonical ID or canonical
   member bytes.
4. Schema keys are camelCase, one term names one concept, and every language
   node has a closed `kind` plus `schemaVersion` discriminator.
5. Rejections expose stable codes and structured `{objectId, path, rule,
   acceptedAlternative, phase, occurrenceIndex}`. Frozen ordering uses only
   the structural tuple `(objectId, path, phase, code, occurrenceIndex)` with
   code-unit comparison, never locale or the `rule`/`acceptedAlternative`
   prose; tests assert structural fields and codes, not prose.
6. `js-tiktoken@1.0.21/cl100k_base` reports representative authored and
   normalized counts as regression telemetry only. Token count never changes
   language correctness or naming.
7. The normalizer is explicit, pure, total, and versioned. Contract schemas
   validate only. Canonicalization and hashing follow the profile below.
8. Every behavior is typed algebra or a versioned effect-declared capability;
   strict schemas reject handler, SQL, route, provider, code, or extension-bag
   escape hatches.
9. Every canonical ID starts with its owning package namespace. Composition
   seams are visible but `unsupported`; a foreign namespaced reference parses
   and then fails with `CANON_REFERENCE_CROSS_PACKAGE_UNSUPPORTED`.
10. The version fixes maximum family counts, collection sizes, expression
    depth, string scalar counts, authored bytes, and normalized bytes. Breach
    is a deterministic diagnostic. The package-byte maximums are
    **4,194,304 authored and 4,194,304 normalized bytes (4 MiB each)**,
    raised from 2,097,152 by owner ruling — **PENDING**, see the correction
    note below and [ADR-0070](../decisions/ADR-0070-the-v0-package-byte-maximums-are-4-mib.md).
11. Every v0 property is consumed by G1/G2, is traceable to plan §5.1/§5.8 or
    inherited reviewed design, or is the explicit unsupported composition
    seam. No speculative family breadth is admitted.

### Experimental correction note — structural diagnostic order

On 2026-07-21, before Freeze B fixtures were introduced, v0-experimental was
corrected so diagnostic order cannot drift when explanatory prose changes.
`objectId` is the canonical diagnostic subject, `phase` identifies the stable
pipeline phase (precompiler canonical-model diagnostics use
`canonicalModel`), and `occurrenceIndex` disambiguates repeated structural
coordinates. This is a bridge/reopen correction inside the explicitly
experimental Freeze A contract, not production-v1 ratification.

### Experimental correction note — package-byte maximums raised to 4 MiB

**PENDING OWNER RULING. Date: `PENDING (YYYY-MM-DD)`. Owner's words:
"`PENDING`".** Until both are filled in and ADR-0070 is accepted, this note and
the T10 values above describe the prepared serial bridge packet
`STRUCTURAL-LIMITS-RAISE`, not the language in force on `main`.

`STRUCTURAL_LIMITS_V0.maximumAuthoredBytes` and `maximumNormalizedBytes` move
from 2,097,152 to 4,194,304. Nothing else in T10 moves: the family,
collection, expression-depth and string-scalar bounds are unchanged, and so is
the compiler's 16 MiB output cap, which is the only size limit inside
`limitsDigest`. The two byte maximums are one table shared by every readable
version, so this is a bridge correction inside Freeze A, not a language
version event. It only admits more: every package that decoded under 2 MiB
decodes identically, and no recorded release root, golden vector or digest
moves. Breach keeps its deterministic diagnostics
(`CANON_LIMIT_PACKAGE_BYTES`, `CANON_LIMIT_NORMALIZED_BYTES`), with the new
value in the rule text. The compile budget was re-measured at the new ceiling
as [`compiler-slos.md`](../operations/compiler-slos.md) requires.

## Determinism profile

- Profile IDs:
  `northstar.normalization/v0-experimental` and
  `northstar.canonical-json/v0-experimental`. Currency/minor-unit semantics are
  frozen by `northstar.currency-minor-units/v0-experimental`; the evidenced v0
  launch set is exactly CAD/2 and USD/2. Adding a currency is language
  evolution, never an ambient `Intl` lookup.
- Input JSON is strict UTF-8, no BOM, no duplicate object keys, no lone
  surrogates, and no unknown schema keys.
- Absence is admitted only for the authored properties named by
  `IMMUTABLE_DEFAULTS_V0`; normalization materializes them. Semantic null is
  admitted only where the normalized schema explicitly requires a nullable
  value (for example a successful assertion's `expectedDiagnosticCode:null`).
  Null never means “use a default.”
- Stored Unicode scalar sequences are byte-preserved. NFC/NFD, case, and
  whitespace are not normalized.
- Object keys sort by ascending UTF-16 code units. Output has no insignificant
  whitespace. Booleans/null use JSON literals; numbers are safe integers only
  with no negative zero. Exact decimal, money, quantity, and large-integer
  values are constrained canonical strings.
- Unordered families sort by canonical ID. Ordered sibling scopes are package
  modules, module entities, entity fields, source-entity relations, field enum
  options, machine states/transitions, surface slots, and query selections;
  each sorts by `(orderKey, canonicalId)` and rejects duplicate keys only
  within that owner. Commutative predicate terms sort by canonical member
  bytes.
- Field-comparison scalars are checked against their referenced field. UTC
  instants normalize to one `Z` spelling at the field's declared precision;
  offset datetimes use one numeric-offset spelling. Money must match the
  frozen currency/minor-unit pair, quantities the declared base unit, and
  exact numeric values the field precision/scale.
- SHA-256 uses domain
  `northstar.app-package.normalized/v0-experimental`, a zero delimiter, and
  normalized canonical bytes. `.golden.bytes` and `.golden.sha256` vectors are
  Git binary fixtures so checkout conversion cannot alter evidence.
- Architecture tests forbid `.default()`, `.transform()`, `.coerce`, wall
  time, randomness, locale sorting, and network inputs in the contracts
  package. The repository pins Node `22.22.2`, pnpm `11.9.0`, Zod `4.1.12`, and
  the lockfile.

## Stable schema surface and traceability

Common properties are not repeated in every row:

| Property | Reason and consumer |
|---|---|
| `kind`, `schemaVersion` | T4 closed-version dispatch; G1-P2 compiler |
| namespaced `*Id` | plan §5.1 stable identity, inherited IR §3/§4.1; all downstream projections |
| `lifecycle` | plan §5.1/§5.8 and ADR-0010; G2 archive/restore and later tombstone checks |
| `orderKey` | T3 and plan §8.5; compiler/surface/state consumers |
| typed `*Reference` | plan §5.1 fail-closed references; G1-P2 resolution |

| Schema | v0 properties beyond the common set | Trace/consumer |
|---|---|---|
| Application package revision | language/normalizer/canonicalization/hash versions; one package; family collections | T2/T7; G1-P2 hash/compiler and G1-P3 revision envelope |
| Package | `namespace`, semantic `version`, `provenance` | plan §5.1 package identity/provenance; G1-P2 graph and G1-P3 revision evidence |
| Module | owner package, label, unsupported composition seam | plan §5.1 module/ownership; G1-P2 graph; T9 falsifiable deferral |
| Entity | module, label, storage reference | plan §5.1 entity/storage ownership; G1-P2 projection and G2 master entities |
| Field | entity, label, classification, presence, search/report flags, typed value contract | plan §5.1/§5.8 and v1 corpus §7.2; G1-P2 projections and G2 forms/query/report/policy |
| Relation | source/target, cardinality, reference versus parent-scoped ownership, requiredness, archive behavior, join eligibility | plan §5.1 relation/child contract; G2 relations and G3 parent-scoped lines |
| State machine | entity, compiler-derived `stateId` field, initial state, ordered states and named transitions with permission | plan §5.1/§5.8 and inherited IR §4.9; G2 lifecycle and G3 named transitions; authored ordinary fields cannot hold machine state |
| Surface | module, data-source reference, archetype, opaque content slots, status roles | plan §8.5-8.6; G1-P2 compiler, G1-P7 runtime, G1-P8 pin |
| Query | module, Q0/Q1 tier, get/list/resolve type, source, permission, ordered selection, typed predicate, result bound | plan §5.8-5.9; G1-P6 gateway and G2 query slice |
| Operation | module, O0/O1 tier, permission, typed predicate, one typed effect, confirmation, read-back query | plan §5.8-5.9; G1-P6 gateway and G2 lifecycle operations |
| Permission | entity resource, action, presentation label | plan §5.1/§5.8; G1-P2 policy projection and G2 policy |
| Assertion | typed query/operation invocation, expected outcome/diagnostic code, evidence kinds | plan §5.1/§5.8; G1-P2 assertions and G2 conformance |
| Storage mapping | entity and logical `dedicatedTable`/`generatedTyped` class only | plan §5.1/§5.9; G1-P2 storage plan and G2 typed schema; no physical name |
| Capability requirement | version, declared effects, support status, mandatory projections | plan §5.2/§5.5; T8 semantic closure, G1-P2 support report and fail-closed completeness |

### Field type traceability

| Type | Frozen semantic fields | Source/consumer |
|---|---|---|
| text, boolean | bounded length or exact boolean | plan §5.1 and v1 corpus §7.2; G2 masters |
| integer | constrained canonical string | T7 exact large-integer rule; G2 identifiers/count metadata |
| exact decimal | canonical string, precision, scale | plan §5.1 exact types and v1 corpus §7.2 precision/scale; G3 inventory facts |
| money | canonical string, precision, scale, and a code/minor-unit pair from the versioned launch table (CAD/2, USD/2) | plan §5.1 currency semantics, v1 corpus §7.2, and evidenced Canadian/USD purchasing; G4/G5 commercial descriptors |
| date | ISO-8601 calendar date with `calendarDate` semantics | plan §5.1 and v1 corpus §7.2 timezone behavior; G2/G4/G5 documents |
| time | second/millisecond precision and `localWallTime` semantics | same inherited field contract; later scheduled/workflow consumers |
| datetime | second/millisecond precision and explicit `utcInstant` or `offsetDateTime` | plan timestamps and v1 corpus §7.2; G2+ audit/document consumers |
| quantity | canonical string, precision, scale, declared base-unit reference | plan §6.3 exact base quantity; G3 inventory |
| enum | stable option IDs, labels, explicit order | plan §5.1 state/field values; G2 statuses |

The surface schema is intentionally opaque below `SurfaceDefinition`: other
lanes depend only on stable surface IDs, data/query references, closed
archetype/slot/status tokens, and opaque content references. The component and
layout vocabulary is the least-evidenced region and remains isolated for G2
usability-driven reopening.

## Closed surface vocabulary

- Archetypes: `home`, `list`, `record`, `task`, `builder`.
- Status roles: `success`, `attention`, `blocked`, `inProgress`.
- Slots are exact per `SURFACE_SLOTS`; each slot appears at most once and has
  one opaque content authority. Unknown slots fail for the selected archetype.
- Component properties, layout grids, route strings, status colors, and raw
  UI implementation are absent from v0.

## Explicit deferrals

The doctrine-coverage map tracks, and this packet does not implement:

- compiler-version-bump identity and approval carry-forward policy;
- full package composition/merge and tenant three-way rebase;
- long-term compiler/runtime compatibility for historical releases;
- storage backfill and data-validity semantics in compiler completeness;
- per-subgraph incremental compilation/memoization against the salvaged SLO
  budgets; and
- production-v1 ratification after inventory, purchasing, and sales compile
  through every promised projection.
