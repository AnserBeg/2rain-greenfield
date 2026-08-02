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

## Unfixed finding from the coverage sweep

The generic recovery scenario for an entity with an optional `restrict`
relation does depend on the former invention for a different reason. With that
optional relation correctly left null, `assertRestorableRelations` performs an
inner join, observes no target row, and refuses restore with
`MODULE_RELATION_VIOLATION: relation target cannot accept active dependents`.
`stock_count` declares recovery evidence and is the only current first-party
entity with that shape.

This packet does not alter restore behavior, invent a replacement relation, or
reclassify the recovery scenario. The finding is reported for a separate
ruling before write-scope can integrate; it is not needed for this packet's
matrix on current main because those inventory scenarios remain structural
derivations there.

## Gate evidence

The two focused controls pass together after both repairs. Typecheck passes,
and the complete PostgreSQL gate passes 149/149. The frozen full-matrix verdict
is reported in the writer handoff so the candidate can remain byte-identical
after measurement.
