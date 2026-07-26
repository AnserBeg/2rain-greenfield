# ADR-0016: Stock identity, the versioned dimension set, and unit immutability

Date: 2026-07-26
Status: accepted (orchestrator ruling, user-authorized 2026-07-26; the implementing packet is
the G3 stage cut, which must land the contract before the first posted movement exists)
Tier: Critical (review per `review-tiers` when implemented)

## Context

Plan §6.3 defines inventory truth as `onHand(item, location, atTime)`. Plan §12.6 defers
lot/batch, serial, expiry, quarantine status, and bins to N3, and units-with-conversions
alongside them.

Every one of those is **a new member of the key of an append-only ledger this program has
promised never to rewrite** (ADR-0007, plan §7.4). On the day lot tracking ships, every
movement posted before it has no lot value and never can — the information did not exist.
That is not a defect to be engineered away; it is a fact about the world. The defect is
leaving it *undeclared*, so that every report, recall, count and audit thereafter has to
encode an era boundary nobody wrote down.

The same shape applies to the item's base unit. Plan §2.2 fixes one declared base unit per
item and §6.3 posts quantities in it. Changing that unit after movements exist silently
restates the meaning of every historical quantity.

The prior-art audit did not name this failure mode. It is recorded as **G1** in
[`prior-art-failure-modes.md`](../execution/prior-art-failure-modes.md).

## Decision

### Stock identity is a declared, versioned tuple

Inventory truth is keyed by a named **stock-dimension set**, not by an implicit tuple
hardcoded into read models.

```text
northstar.stock-dimension-set/v1 = (legalEntityId, itemId, locationId)

onHand(stockIdentity, atTime)
  = SUM(posted inventory_movement.quantity_delta up to atTime)
  grouped by the declared dimension set
```

`legalEntityId` enters the set by [ADR-0015](ADR-0015-legal-entity-business-dimension.md).
The set is a compiled artifact with a version, not a convention.

### Every posted movement stamps the version it was posted under

Each `inventory_movement` row carries `stockDimensionSetVersion`. It is immutable, like
every other property of a posted fact.

This single column is the whole mechanism. It converts "stock received before we tracked
lots" from tribal knowledge into a **queryable, joinable, reportable fact**. An operator
asking "which of my stock has no batch attribution" gets an exact answer instead of a
date someone remembers.

### `unspecified` is a member, not a null

When a dimension exists in the current set but not in the version a movement was posted
under, it resolves to the declared `unspecified` member of that dimension's domain.

`unspecified` is a first-class value: it groups, filters, aggregates, renders, and is
addressable by the agent. It is never `NULL`, never the empty string, and never a magic
sentinel that a query has to know about. Balances therefore remain total over the current
dimension set for all of history, and adding a dimension **cannot change any existing
answer** — a pre-extension balance and a post-extension balance for the same stock agree.

### Extending the set is a governed versioned event

Adding a dimension is never an ad-hoc migration. It requires, in order:

1. a new dimension-set version with the added member and its `unspecified` value;
2. compiled read models and queries keyed on the new set, proven to reproduce every prior
   balance;
3. a declared **re-baseline operation** — a named inventory operation that appends
   movements attributing existing `unspecified` stock to real dimension values, with the
   ordinary reason, actor, approval and correction-lineage evidence; and
4. an activation blocker for any capability that requires a dimension the tenant's active
   version does not carry.

Re-baselining appends. It never rewrites, backfills, or reinterprets a posted movement.
A tenant that never re-baselines keeps a permanently correct, permanently `unspecified`
history, and that is an acceptable end state.

Removing a dimension is unsupported and fails closed. Reordering members does not change
identity; the set is a set.

### Base unit is immutable once stock exists

An item's declared base unit is part of its posting identity.

- Once any posted movement references an item, its base unit **cannot change.** The
  operation fails closed with a typed diagnostic naming the first movement that binds it.
- Selling or buying in another unit is a **conversion capability** (N3), which converts at
  the document boundary and still posts in the base unit. It does not restate the ledger.
- An item whose unit was genuinely wrong is corrected by archiving it and introducing a new
  item, with the ordinary correction lineage. There is no in-place retype.

This is one compiler rule and one provider constraint. Written now it costs a sentence;
discovered at N3 it costs the ledger.

### What this ADR does not decide

It does not add lot, serial, bin, expiry, or unit conversion to launch scope. Those remain
N3 (plan §12.6). It decides only that the ledger is shaped so they can arrive without an
era boundary that nobody declared.

## Consequences

- Adding lot/serial/bin/expiry at N3 becomes a versioned capability addition with a named
  re-baseline path, not a schema event and not a history rewrite.
- The `unspecified` member costs one enum value per dimension and buys totality: no query,
  report or agent answer needs to know when tracking started.
- One extra column on the movement table (`stockDimensionSetVersion`) and one compiler rule
  (base-unit immutability) are the entire launch cost.
- G3 inherits a hard sequencing constraint: **the dimension-set contract must exist before
  the first movement is posted.** After that, movements exist with no version stamp and the
  era boundary this ADR prevents is already created.
- Reserving physical lot/serial/bin columns now was offered and rejected. The version stamp
  subsumes it: it makes extension governed without carrying four unused columns through
  every index and every query plan from G3 to N3.

## Evidence

- Plan §6.3 inventory truth model, §6.4 invariants, §12.6 N3 capability list, §14.3
  inventory property suite.
- ADR-0007 append-only posting truth: the no-update, no-delete guarantee that makes an
  undeclared era boundary permanent.
- ADR-0011 storage-target payload versioning and additive transition classification, which
  the dimension-set version reuses rather than duplicating.
- [`prior-art-failure-modes.md`](../execution/prior-art-failure-modes.md) **G1**.

## Enforcement

- Compiler: read models and queries over inventory lower against the declared dimension set;
  a hardcoded `(item, location)` tuple in a compiled projection fails closed. An item
  definition that permits base-unit mutation fails a stable diagnostic.
- Provider: `stockDimensionSetVersion` is `NOT NULL` on every posted movement; a base-unit
  update against an item with any movement fails closed.
- Property suite (plan §14.3): adding a dimension to a fixture set and replaying the same
  event history reproduces byte-identical prior balances — the executable form of "adding a
  dimension cannot change an existing answer."
- G3 gate: balances are reconstructible per dimension-set version, and a recorded negative
  control proves the reconstruction fails when the version stamp is absent.
