# 5g3-arrangecycle — verification must not invent optional parents

Status: candidate

Tier: Critical

Base: `6ecc8518074e764f0fc3c559cf6b34fff0cf016a`

## Outcome

Semantic verification recursively arranges only relation inputs whose compiled
operation contract declares `required: true`. Optional inputs remain unset;
the decision is keyed only on the generic contract bit and names no module,
entity, or relation.

The same recursive path carries its active entity ancestry. Re-entering an
entity through required relation inputs refuses with
`VERIFICATION_REQUIRED_RELATION_CYCLE` and the closed cycle path rather than
recursing until the JavaScript stack or PostgreSQL storage is exhausted.
Relation overrides remain authoritative for controls that deliberately arrange
a relationship.

No compiler, input contract, scenario, derivation rule, tmpfs, timeout, budget,
baseline, migration, or product module definition changed.

## Controls and negative directions

- **Optional self-reference.** A first-party-shaped fixture has an optional
  `retainReference` self-relation. The complete real PostgreSQL verification
  plan returns one executed result for every scenario. The retained records are
  then read directly: the optional relation column is null for every arranged
  row. On the unfixed path the control exhausted the JavaScript call stack
  before returning a result. With cycle detection retained but the
  `required` check removed, it independently failed with
  `VERIFICATION_REQUIRED_RELATION_CYCLE` on the optional entity cycle.
- **Required cycle.** The same fixture with only `required` changed to true is
  refused with `VERIFICATION_REQUIRED_RELATION_CYCLE` and the exact self-cycle.
  Removing cycle detection while retaining optional skipping independently
  exhausted the JavaScript call stack; the control rejected that `RangeError`
  because it requires the named verification failure.

Both controls execute through candidate staging, exact storage preparation, the
real semantic gateways, the PostgreSQL interpreter, and release verification.
They live in the existing `test/postgres/module-runtime.test.ts`, so no new test
file inventory was added.

## First-party coverage delta

The normalized composed first-party application has eight relations and one
optional relation input:

```text
northstar.app:relation.stock_count_supersedes
stock_count -> stock_count
required=false, archiveBehavior=restrict
```

Across the 168-scenario serving plan, 38 scenarios reach that optional input
under the former recursive arrangement: 21 scenarios directly on
`stock_count`, and 17 on `stock_count_line` through its required stock-count
parent. No other first-party operation has an optional relation input.

On current main all 38 are among the 112 structural derivations because their
entity-owned creates lack the legal-entity system input. On the parked
write-scope artifact all 38 are executable. This packet changes neither
constructibility nor scenario disposition: current main remains 56 executed / 112
derived, and write-scope remains 129 executed / 39 derived. No scenario is
reclassified or removed.

The archive-restriction scenario does **not** depend on an invented optional
parent. It creates its parent explicitly and passes the selected relation in
the child's `relationOverrides`, so the relationship under test remains
present after optional auto-arrangement is removed.

## Follow-on finding resolved on the combined branch

The generic recovery scenario for an entity with an optional `restrict`
relation does depend on the former invention for a different reason. With that
optional relation correctly left null, `assertRestorableRelations` performs an
inner join, observes no target row, and refuses restore with
`MODULE_RELATION_VIOLATION: relation target cannot accept active dependents`.
`stock_count` declares recovery evidence and is the only current first-party
entity with that shape.

The original arrangecycle candidate did not alter restore behavior, invent a
replacement relation, or reclassify the recovery scenario. The follow-on
`5g3-restorenull` packet now resolves it on the combined branch by observing the
nullable foreign key before validating any target. Its independent controls
and evidence are recorded in `docs/execution/packets/5g3-restorenull.md`.

## Critical review round 1 — equal-depth arrangement paths

The review found that recursive arrangements derived every parent token as
`${token}-parent`. Two distinct required paths reaching the same entity at the
same depth therefore generated the same stable UUID in the same table. This is
not a cycle: the entity ancestry remains path-scoped and correctly permits a
diamond.

Recursive tokens now use a domain-separated SHA-256 digest of the parent token
and the compiled relation ID. For a given parent token, this child-path
transform is pure and process-independent, and each recursion therefore carries
the entire relation path. The complete token mechanism is still rooted in
`#token`, whose incremented ordinal makes root probe tokens order-dependent. The
path transform introduces no counter, time, random data, or execution-order
input of its own. It is generic, contains no module, entity, or relation
literal, and creates separate prerequisite records rather than pooling or
deduplicating them.

Cycle detection carries an immutable entity-ancestry array per recursive
branch. Each child receives a copied array extended with its parent entity, so
sibling branches share no mutable path state and no cleanup is required. The
executor's separate `finally` archives created records; it is not cycle-path
cleanup. The existing cycle guard itself is unchanged.

A synthetic four-entity fixture forms `root -> left/right -> shared` with all
four relation inputs required. It executes the real PostgreSQL verification
path and then joins the persisted relationship columns, requiring each root's
left and right legs to name distinct shared-record UUIDs. Against the reviewed
depth-only token scheme, the control failed with `MODULE_UNIQUE_VIOLATION`
during the second branch. With the path token, every scenario executes and the
persisted pairs are distinct. A future implementation that silently pools the
shared prerequisite would therefore fail the control even though verification
itself did not throw.

## Known limitation owed with output-protocol stabilization

Operation idempotency keys derive from the ordinal-based `#token`. That token is
stable across retries of the same release when verification follows the same
scenario order. Arranged record identity is now path-derived and changed in
this repair. A database retaining receipts from a partially failed pre-fix
verification and then retried after this change would therefore present the
same idempotency key with a different canonical input digest. The trust service
would refuse it with `SEMANTIC_OPERATION_IDEMPOTENCY_CONFLICT`; it would not
silently admit the changed input.

This retry limitation is immaterial at the current stage on the same premise as
ADR-0039 §1: there is no production deployment and test databases are
ephemeral, so the required persisted pre-fix state cannot exist. That premise
ends when the compiler output protocol leaves experimental. The stabilization
work already owed by ADR-0039 §4 must therefore include a coordinated
arranged-record identity/idempotency epoch for any future identity change, and
must avoid collision with arranged rows persisted under earlier epochs.

## Gate evidence

The focused optional-cycle, required-cycle, required-diamond, and restore
controls pass together after the combined repairs. Typecheck passes. The
complete PostgreSQL gate passes 152/152. The frozen full-matrix verdict is
reported in the writer handoff so the candidate can remain byte-identical
after measurement.
