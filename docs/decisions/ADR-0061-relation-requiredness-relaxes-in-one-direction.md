# ADR-0061: Relation requiredness relaxes, in one direction, at prepare time

Date: 2026-08-26
Status: proposed
Tier: Critical (review per `review-tiers`)

**Numbered 0061, not 0060, on purpose.** `packet/pur-2a` — the unmerged packet
this decision exists to unblock — already carries an
`ADR-0060-a-posting-family-declares-whether-the-kernel-writes-its-companion.md`.
Neither is on `main`, so the collision was invisible until the two branches were
merged; it was found by this packet's merge measurement. The lower number goes
to the packet that reached it first.

Extends [ADR-0011](ADR-0011-compiled-module-storage-transitions.md), which
established the storage transition element vocabulary and its A2/A4
classification axes. Nothing in ADR-0011 is repealed or narrowed here; this
adds one element to the vocabulary it defined.

## Context

`sameRelationShape` compares `relationColumn` — and therefore `nullable` — as
part of a relation's physical shape. Any difference refuses the candidate
release with `COMPILER_STORAGE_RELATION_MUTATION_UNSUPPORTED` once the previous
release already carries that relation.

That refusal treats both directions of `NOT NULL` alike. They are not alike.
`NULL` → `NOT NULL` is a tightening: it needs a scan, it can fail on data that
already exists, and it can reject a write that used to succeed — which is why
the vocabulary already carried `tightenNotNull` with a `dataScan`,
`deferredTightening`, `blockingWhileAffectedWritersLive` cell. `NOT NULL` →
`NULL` is a widening: it rewrites no rows, reads no rows, fails on no data, and
rejects no write that used to succeed.

The refusal was therefore a MISSING TRANSITION ELEMENT rather than a guard
against an unsafe change, and the alternative its diagnostic offered — "add a
distinct optional relation through the v1 additive path" — means a second
physical column for the same fact, permanently, for every module that ever
needs a required relation to become optional.

Before deciding, the packet swept every construct in this system that could
make a relation column's `NOT NULL` load-bearing beyond the constraint itself.
None depends on it: primary keys are fixed literal column sets
(`packages/compiler/src/storage.ts`, `primaryKeyColumns`); the fact partition
key is the literal type `readonly ['tenant_id', 'business_period']`; RLS
policy predicates are the tenant/environment conjunction only; folded generated
columns derive from unicode-foldable text fields, and a declared relation
column is `uuid` with no `canonicalFieldId`; the only index predicates in the
tree are `archived_at IS NULL` and `is_default IS TRUE AND archived_at IS NULL`;
unique keys are built over entity columns; and the relation's own index is a
plain btree with `predicate: null`, which indexes nulls. The one place a CHECK
constraint does depend on a relation column being a real value —
`stockIdentityV1MemberChecks` — sits on `origin: 'field'` columns, which this
decision excludes for an independent reason.

## Decision

**1. A `relaxNotNull` element exists, and it is what a widening plans as.**
When the previous release carries a relation as required, the candidate carries
it as optional, and NOTHING ELSE about its physical shape moved, the planner
emits exactly one `relaxNotNull` element rather than refusing. Its classification
is `catalogOnly` / `boundedCatalogLock` / `preApprovalInert` / `additive`, and
it raises no tightening debt.

`preApprovalInert` follows the property that separates inert from in-attempt
everywhere else in this planner rather than a fresh judgement: every
`inAttemptOnly` kind either rejects old writes (`oldWrite: 'mayReject'`) or
mutates rows (`backfill`). Relaxation does neither.

**2. `oldRead` is `requiresReadFallback`, not `compatible`.** This is the ruling
most able to be wrong, so it is stated with its reasoning. Relaxation is safe
for the DATABASE and it is NOT transparent to a live READER. During coexistence
both releases are live by definition, so the new release's writers may store a
null; a reader compiled under the previous release modelled that relation as
always present and now observes one. Reads do not reject, so this is not
`mayReject` — it is exactly the burden `addColumn` records as
`newRead: 'requiresReadFallback'`, read from the other side of the release
boundary.

Because it is the first cell whose fallback burden falls on the OLD side,
`coexistenceImpact` now observes `oldRead` as well as `newRead`. Without that,
the element would publish `coexistenceImpact: 'none'` beside a matrix row
saying a live reader needs a fallback — the element's own summary contradicting
its own cell. The widened derivation is INERT for all thirteen pre-existing
kinds, none of which carries `oldRead: 'requiresReadFallback'`, and a test
asserts that emptiness rather than assuming it.

**3. Relaxation is one-way. The round trip is refused.** A later release that
re-tightens a relaxed relation is refused with the existing
`COMPILER_STORAGE_RELATION_MUTATION_UNSUPPORTED`. It does not route through
`tightenNotNull`.

The reason is a property of how `tightenNotNull` is actually emitted, not a
preference: this planner emits it only for a column CREATED INSIDE THE SAME
TRANSITION, with an optional backfill ahead of it, guarded by `if (oldField)
continue;`. It carries no admissibility story for rows a live release already
wrote as NULL — and after a relaxation, those rows are precisely what exists.
Routing a re-tightening through it would plan a `SET NOT NULL` scan against the
rows the relaxation made legal. Re-tightening a released relation needs
admissibility machinery that does not exist yet; until it does, the refusal is
the honest answer and the diagnostic is the correct one.

**4. `origin: 'field'` relations are excluded, and the exclusion is a
correctness boundary.** Their physical column is an ORDINARY ENTITY COLUMN:
`createManagedTable` filters them out of the relation columns it renders and
emits them from `entity.columns`, whose own `nullable` governs the `NOT NULL`.
Planning a relaxation from the relation side would drop the constraint for a
migrating tenant while a fresh install of the very same release still creates it
`NOT NULL` — one release, two physical shapes, and no gate between them.
Requiredness for those columns must move through the column path, which refuses
it today with `COMPILER_STORAGE_RETYPE_UNSUPPORTED`.

**5. Two accounted live roots may disagree about one relation's requiredness,
and only about that.** `mergeExpectedRelations` previously raised
`LIVE_SET_SHAPE_CONFLICT` on any difference between the source and target roots.
It now merges a requiredness widening to the relaxed member. That is reading the
physical truth rather than forgiving a conflict: one physical column exists, the
widening DDL has already run against it, and the old root's `NOT NULL` is no
longer a claim it can enforce. The tolerance is expressed by widening the
required member and requiring exact equality of everything else, so any other
divergence still conflicts.

**The managed tables are TENANT-SHARED, and that makes this tolerance necessary
rather than merely convenient.** `north_star_module` holds one physical table per
entity, scoped by `tenant_id`/`environment_id` columns under forced RLS, and
`loadAccountedLiveTargets` gathers live roots across **every** tenant scope, not
just the one preparing. So the moment any tenant prepares a relaxation the column
is nullable for all of them, and a tenant still on the previous release holds a
root asserting a `NOT NULL` that no longer physically exists. Without the
tolerance, `LIVE_SET_SHAPE_CONFLICT` would fire for **every** tenant until the
last one migrated — the compiler emitting a correct plan that the provider
refuses fleet-wide.

It also sharpens point 2 and the rollback note below: what keeps that column
populated for a not-yet-migrated tenant is its own release's writers, not the
constraint. The constraint is gone for everyone.

## Consequences

**Easier.** A module may make a required relation optional without carrying a
second column for the same fact forever. `packet/pur-2a`'s two optional
companion relations on an already-released lineage are the case this element
exists for.

**Harder.** A module may not make an optional relation required again. That is a
real and deliberate one-way door, and a module author who needs the round trip
is blocked until the admissibility machinery in point 3 exists.

**Forbidden.** Widening a `origin: 'field'` relation column from the relation
side, at all.

**Rollback.** There is no reversal path for a prepared element in this system —
`preApprovalInert` elements are applied at PREPARE and an abandoned preparation
leaves them in place. For `relaxNotNull` the residue is a column that lost a
`NOT NULL` while a release that models the relation as required stays live.

**"Its writers supply the value by construction" is not an assumption; it is a
guard, and here it is.** `insertRecord` in
`packages/postgres-provider/src/module-runtime-interpreter.ts` refuses with
`MODULE_REQUIRED_RELATION_MISSING` before issuing the `INSERT`, and it reads
`relation.relationColumn.nullable` from **that release's own pinned storage
target** rather than from the catalog. So an old-release writer keeps refusing a
missing relation no matter what the physical column now permits. The residue is
a loss of defence in depth, not of data integrity. It is not new behaviour introduced by this ADR —
`addColumn` and `createTable` have the same non-reversal — but it is the first
prepared element whose residue removes an enforcement instead of adding an
unused object.

**Migration.** Element kinds are enumerated by a `CHECK` constraint,
`north_star_internal.module_storage_elements_shape`, that no TypeScript build
observes. A new kind therefore needs a migration; this one is `0022`.

## Evidence

`test/compiler/g2-module-storage.test.ts` — 'a released required relation
widens through one relaxNotNull element' (the whole plan is one element, with
its cell and impact pinned literally, and no tightening debt); 'relaxation is
one-way: re-tightening a released relation is refused'; 'a field-origin
relation column is never widened from the relation side'; 'relation mapping
fingerprints include nullability and existing physical mutations fail closed'
(three combinations that carry the widening AND a second change, each still
refused); 'A2/A4 classification axes and compatibility carve-outs are exact'
(the cell, the impact, and the emptiness of `oldRead: 'requiresReadFallback'`
across every other kind).

`test/evidence/relation-requiredness-relaxation.expected-red.json` — seven
recorded reds, each varying one property, reproduced by
`pnpm evidence:expected-red`.

The load-bearing sweep in Context above was run against the compiler's own
lowering rather than inferred from the schema.

## Enforcement

**One authority, not two.** `relaxesRelationRequiredness` is exported from
`packages/compiler/src/storage.ts` and imported by
`mergeExpectedRelations` in the provider. The first version of this ADR had the
rule encoded twice, and the two drifted within a single packet: the provider's
copy was corrected to reject a differing `archiveBehavior` and the compiler's
was not, so the compiler emitted a release its own materializer refuses at
PREPARE with `LIVE_SET_SHAPE_CONFLICT`. A second corrected copy is the same
defect waiting; one import is the enforcement.

**The comparison is over the WHOLE relation.** `relaxesRelationRequiredness`
admits a widening only when the previous relation, with exactly
`relationColumn.nullable` changed, hashes identically to the candidate — the
complete object, not a projection of it. The first version delegated to
`sameRelationShape`, whose comparison object is a hand-maintained subset that
omits `archiveBehavior`, and it inherited the omission. **A property added to
`StorageRelationTarget` in future is now refused by default; against the subset
that claim was false**, because a new property would be omitted from the subset
too. The legacy `archiveBehavior` tolerance is stated explicitly and
symmetrically rather than inherited: when both roots declare it they must agree,
and only when one omits it entirely is it dropped from both.

The provider carries the mirror guard: `applyDdlElement` refuses a `relaxNotNull`
whose own target does not say the column is optional (`NON_WIDENING_RELAX_NOT_NULL`),
and refuses one that resolves to a field-origin or ambiguous relation
(`ELEMENT_TARGET_MISSING`).

**The renderer policy check is an allowlist, and it is derived.**
`validateStorageRendererStatements` used to name six destructive kinds and admit
everything else, which fails OPEN — and it was already failing open before this
ADR, because `rendererStatement` casts `{ kind: element.kind }` into
`StorageRendererStatement`, a union carrying only seven of the element kinds.
`backfill`, `duplicateScan` and `tightenNotNull` reached it as values outside its
own declared type and fell through. Admitting `relaxNotNull` — an operation whose
purpose is to REMOVE an enforcement constraint — to that set is what made the
standing defect worth closing. The admitted set is now
`Object.keys(STORAGE_COMPATIBILITY_MATRIX)`, which TypeScript forces, so the
allowlist follows a new kind for free and an unrecognised kind is refused.

`STORAGE_COMPATIBILITY_MATRIX` is a `Record<StorageTransitionElementKind, ...>`
and `classifyStorageTransitionElement` returns a typed classification, so both
are forced when a kind is added. **`applyDdlElement`'s switch is NOT forced** —
it has no exhaustiveness check, so a kind added without a case there builds
green and silently applies nothing. That gap is closed for THIS kind by an
executing PostgreSQL test that reads
`information_schema.columns.is_nullable` rather than the plan; it is not closed
for the next kind, and that is filed as
`materializer-element-switch-is-not-exhaustive`.
