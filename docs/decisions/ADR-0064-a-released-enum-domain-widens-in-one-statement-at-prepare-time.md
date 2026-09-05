# ADR-0064: A released enum domain widens, in one statement, at prepare time

Date: 2026-09-01
Status: proposed
Tier: Critical (review per `review-tiers`)

Extends [ADR-0011](ADR-0011-compiled-module-storage-transitions.md), which
established the storage transition element vocabulary and its A2/A4
classification axes, and sits beside [ADR-0061](ADR-0061-relation-requiredness-relaxes-in-one-direction.md),
which added the first one-way widening element. Nothing in either is repealed
or narrowed; this adds one element and one provider rule.

## Context

`lowerColumn` hashes a column's `shapeFingerprint` over `fieldType` wholesale,
and an enum's `fieldType` carries its `options`. The transition planner refuses
any column whose fingerprint moved with `COMPILER_STORAGE_RETYPE_UNSUPPORTED`,
so adding one option to an enum on an already-released field is refused as a
retype. The physical column is `text` before and after. The diagnostic is
misnamed for this case.

`PUR-2c` measured, against live PostgreSQL, why the fence cannot simply be
loosened. The enum-domain CHECK's physical name is
`physicalNameFor('constraint', '<fieldId>/enum-domain')` — derived from the
field id alone — and the planner skipped every check whose NAME the previous
release already carried. With only the retype fence bypassed, a widened release
compiled, prepared and ACTIVATED with zero elements, the tenant's live CHECK
kept its old option list, and the newly compiled option was rejected by the
database the release advertised it to. That is a Band A failure: silent until
an operator's write fails.

This packet tested two stop conditions before designing anything, and neither
fired:

1. **Can an enum-domain CHECK be replaced without a window in which the table
   carries no membership constraint?** Yes. PostgreSQL has no `ALTER
   CONSTRAINT` for a CHECK expression, so replacement is `DROP` plus `ADD`, but
   as sub-commands of ONE `ALTER TABLE` statement inside the prepare transaction
   they commit together or not at all. Measured against a 200k-row table with
   the constraint `NOT VALID` before and after: the statement took 6 ms and
   scanned no rows; the session held `AccessExclusiveLock` on the table for the
   rest of its transaction; concurrent inserts of an OLD value and of the NEW
   value both blocked on `Lock/relation` and both succeeded after `COMMIT`; a
   lock-free catalog read from a third session saw exactly one constraint
   throughout (a `pg_get_constraintdef` from that session blocked instead, which
   is the lock doing its job); a backend terminated mid-transaction left the old
   constraint with its old OID and the new value still refused with `23514`;
   and behind a long-open reader the statement waited and failed with `55P03`
   under `lock_timeout` rather than proceeding. There is no interval in which
   the table is unconstrained, so the answer is a replaced constraint, not an
   added second one.
2. **Why did candidate release verification not catch the widened release?**
   Because `PUR-2c`'s "sorts-first" specimen was not the worst case it was built
   to be. The `enumReject` scenario IS planned and executed for
   `inventory_transaction_type` (the deriver marks it executed, not derived),
   and its positive witness is `enumOptionIds[0]` — but of the OPERATION
   CATALOG's field contract, which lists options in DECLARATION order. The
   storage contract sorts them; the operation catalog does not. `PUR-2c` made
   its new option sort first and appended it last, so the witness stayed an old
   option and verification passed honestly. With the new option declared FIRST,
   verification against the stale CHECK refuses the candidate with
   `MODULE_PROVIDER_FAILURE (sqlstate=23514 constraint=<the enum-domain
   check>)`, observed in this packet's test. Verification was never the gap; the
   missing element was. What remains is a scope limit — the scenario probes one
   witness, the first-declared option — and it is filed, not fixed here.

## Decision

**1. A `widenEnumDomain` element exists, and a widening plans as exactly one.**
When the previous release carries an enum-domain CHECK under the same physical
name, the candidate's option-id set is a STRICT SUPERSET of the previous one,
and NOTHING ELSE about the field moved, the planner emits one
`widenEnumDomain` element instead of refusing. "Nothing else moved" is tested
EXACTLY, not by exclusion (**corrected at round 2** — the round-1 predicate
removed the whole column fingerprint from the comparison, which is the only
place an enum's option labels and orderKeys live, so a widening that also
relabelled or reordered an existing option passed): the candidate's SOURCE
field, with every option record the previous release did not carry removed,
must fingerprint byte-for-byte as the previous release's stored column
fingerprint. That admits exactly one kind of change — new option records — and
refuses a changed label, a changed orderKey, a reordering, and every other
column property. The check-side predicate `widensEnumDomain` requires the same
field, the same physical name, `enumDomain` kind, `NOT VALID` on both sides,
and the strict superset. The check-side rule is exported and the
provider imports it, for the reason ADR-0061 gave: one authority, because two
copies of a rule already drifted once.

The planner now compares a same-named check's DEFINITION before skipping it.
Matching by name alone was the hole.

Classification: `catalogOnly` / `boundedCatalogLock` / `preApprovalInert` /
`additive`, and no tightening debt. `preApprovalInert` follows the planner's
own rule rather than a fresh judgement: it can never reject a write, because
every value the old constraint admitted is admitted by the new one. Being inert
before approval is also what makes candidate verification pass — the composed
runtime prepares the transition BEFORE it verifies the candidate, so by the
time the enumReject witness is written the physical constraint already admits
it.

**2. `oldRead` is `requiresReadFallback`.** The same cell as `relaxNotNull`,
for the same reason: a reader compiled against N options observes the (N+1)th
the moment a new writer stores it. Reads do not reject, so it is not
`mayReject`; it is the fallback burden on the OLD side, and
`coexistenceImpact` reports it.

**3. Widening is one-way, and every adjacent change keeps its refusal.**
Narrowing (an option removed), rebinding (one id replaced by another at
constant count), relabelling (equal id sets), a widening combined with a
search-mapping flip, and a widening combined with an unrelated retype all keep
`COMPILER_STORAGE_RETYPE_UNSUPPORTED`. Two additive exceptions exist beside the
retype fence — search mapping and enum domain — and each admits its change
ALONE. Combining them is refused, deliberately: one property per transition is
the rule that keeps each predicate's evidence attributable.

**4. The provider replaces the constraint in ONE statement, decided against the
LIVE definition.** `widenEnumDomainCheck` takes `LOCK TABLE … IN SHARE UPDATE
EXCLUSIVE MODE` (excludes every other `ALTER TABLE`, admits DML), reads the
live CHECK back from `pg_constraint` under that lock, extracts the option ids of
the shape it renders, and checks the extraction by ROUND TRIP — re-rendering
the extracted set must reproduce the live definition exactly, or it refuses
with `ENUM_DOMAIN_DEFINITION_UNRECOGNIZED` rather than guessing. The round trip
proves the expression's SHAPE, not its authorship. Then:

- constraint absent → **REFUSED** with `ENUM_DOMAIN_CHECK_MISSING` (**corrected
  at round 2**: round 1 added the target constraint `NOT VALID` here, which is
  not a widening at all — the table admitted everything while the constraint
  was absent, so the add is a pre-approval TIGHTENING that can newly refuse an
  update to a drifted row, and it repairs the drift before the catalog verifier
  measures it. An absent released constraint is drift, and the verifier finds
  it as `missing managed constraint`);
- target ⊆ live → nothing to do (a replay, or a sibling root already wider);
- live ⊂ target → `ALTER TABLE … DROP CONSTRAINT k, ADD CONSTRAINT k CHECK (…)
  NOT VALID`, one statement;
- anything else → `ENUM_DOMAIN_NARROWING_REJECTED`. **This element never
  narrows**, whatever a target says, because the managed tables are
  tenant-shared and another tenant may already depend on the wider set.

Deciding against the live definition rather than the source root is what makes
the element idempotent and order-independent across tenants: a second tenant
preparing the same widened release after the first finds the constraint
already wide enough and applies the element with no DDL. Every path the
element executes is now inert — no-op, or subset-to-superset replacement —
which is what `preApprovalInert` requires of it.

**5. Two accounted live roots may disagree about one enum-domain CHECK — and
its column's field contract — only by a widening, and the expected shape is the
SUPERSET.** `mergeExpectedTables` merged same-named checks by exact equality
and raised `LIVE_SET_SHAPE_CONFLICT` on any difference; because
`loadAccountedLiveTargets` gathers every tenant's live roots, the moment one
tenant widened, every other tenant's prepare would have been refused. The merge
now takes the wider member when `widensEnumDomain` holds in either direction,
and the column merge tolerates a field contract that differs only by that
widening (with `shapeFingerprint` excluded from the comparison, as it already
is for the additive search-mapping pair). Every other storage-visible
divergence still conflicts. **Stated as a limit rather than hidden:** the
provider cannot re-run the compiler's exact test, because option labels and
orderKeys exist only in the compiler's INPUT and reach the provider solely
inside the fingerprint it must exclude. The provider's tolerance is therefore
bounded by what the compiler admitted for each root; a root that widened AND
relabelled cannot be compiled, and a forged one is a forged release artifact.

**6. Activation reports conformance from the catalog receipt that observed the
widened definition.** Nothing new is added here, and that is the point: the
existing catalog verification compares each CHECK's DEFINITION, not its name,
against the merged expected shape, at prepare and again at the end of the
approved attempt; the activation service derives `module_schema_conformance`
from that receipt. A transition whose target advertises the option but whose
envelope installs nothing is refused at prepare with `CATALOG_DRIFT: altered
managed constraint …` — `PUR-2c`'s activation, reconstructed as a tampered
artifact, no longer activates.

## Consequences

**Easier.** A module may add an option to a released enumeration without a
successor field, a lookup relation, or a truncated lineage, and the database
keeps exact membership enforcement. Resumed `PUR-2c` can add its
goods-receipt options to `inventory_transaction_type` and
`inventory_posting_role` through this element; the conformance pins on those
fields are a separate fence and remain that packet's to move.

**Residue.** A widening is applied at PREPARE. If the preparation is abandoned
the wider constraint remains — the same residue ADR-0061 declares. It admits
nothing an old release's runtime will write, because that runtime validates
enum values against its own compiled option list before any row reaches the
database; the only writers a wider CHECK newly admits are the new release's.

**Lock.** The replacement holds `AccessExclusiveLock` on the business table
from the statement until the prepare transaction commits — the same class as
`addColumn`, which the prepare path already takes — and this is observed
through the COMPOSED prepare path, not only on a raw statement: the committed
test holds a business writer's transaction open, watches the materializer wait
on the relation lock in `pg_stat_activity`, and sees the prepare resolve only
after the writer commits. A long-open reader ahead of
it queues the statement AND every writer behind it. The materializer sets no
`lock_timeout` today; that is a pre-existing property of every bounded-catalog
lock in the prepare path and is filed rather than changed here.

**Element identity.** An element's identity is `{kind, subjectId, fieldId,
physicalObjectName}`, so two successive widenings of one field produce the same
`elementId` and byte-identical registry rows. That is consistent — the registry
records "this operation family on this object" and `ON CONFLICT DO NOTHING`
then re-checks the shape — but it means the registry alone cannot say which
option set a given application installed; the generation's target release
does. Stated so it is not mistaken for a defect later.

**Forbidden.** The element never narrows, never validates (the CHECK stays
`NOT VALID`; validation remains `validateConstraint`'s deferred tightening),
and never runs outside a materializer transaction.

## Evidence

- `PUR-2c` §2.3–§2.4b: the refusal's real cause, the observed zero-element
  activation, and the nine-assertion specification this packet closes.
- The stop-condition 1 probe, reproduced in the packet record: 200k rows,
  6 ms, `AccessExclusiveLock`, blocked-then-succeeded concurrent writers of
  both values, one constraint visible throughout, rollback on termination,
  `55P03` behind a long reader.
- The stop-condition 2 measurement: the deriver marks the
  `inventory_transaction_type` enumReject scenario EXECUTED on the head
  release; `projections.ts`'s operation catalog builds `enumOptionIds` in
  declaration order; the committed test observes `MODULE_PROVIDER_FAILURE
  (sqlstate=23514 constraint=…)` when verification runs before the widening
  and clean admission when it runs after.
- `test/postgres/module-storage-transition.test.ts`: one Postgres-free test
  for the predicate and its five preserved refusals; one Band A test from
  existing rows through pre-state rejection (`23514` from the exact constraint
  on the real business table), verification-before-widening, the tampered
  transition, a failed-then-retried prepare with the original OID restored,
  the widening (element APPLIED at PREPARE, `widenEnumDomain` persisted under
  migration `0024`'s CHECK, receipt PREPARED and catalog-verified for that
  candidate, new OID, three options, still `NOT VALID`), both values accepted
  and an undeclared value still refused, approval, attempt, admission,
  activation `SWAPPED_VERIFIED` with `module_schema_conformance_passed` under
  the v2 receipt, the second tenant's no-DDL replay against the mixed root
  set, and the forged divergent target refused before DDL.
- `test/evidence/enum-widen.expected-red.json`: thirteen one-property
  mutations, including the required repair-before-measure control.

## Enforcement

- Compiler: `isAdditiveEnumDomainTransition` and `widensEnumDomain` in
  `packages/compiler/src/storage.ts`; the planner's definition comparison; the
  `STORAGE_COMPATIBILITY_MATRIX` cell, which the renderer allowlist derives.
- Provider: `widenEnumDomainCheck` and the check/column merge tolerance in
  `packages/postgres-provider/src/module-storage-materializer.ts`.
- Migration `0024` admits the kind to
  `north_star_internal.module_storage_elements_shape`; the schema snapshot
  records it.
- Gates: `test:compiler` (the closed-matrix pin), `test:postgres` (both tests
  above), `evidence:expected-red` (thirteen reds).
