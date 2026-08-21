# ADR-0057: Posted stock is a rebuildable ledger sum

Date: 2026-08-20
Status: proposed — packet `stock-balance-read-model`
Tier: Critical — the packet changes what module conformance admits

## Context

The canonical five-parameter `inventory_movement_on_hand` lookup answers a
bitemporal question: the sum visible at an effective-time and recorded-time
horizon. Its grouped-aggregate route cannot supply a browsable stock list; the
language admits only `maximumResultCount: 1` and declares grouping unsupported.
Three one-property probes established that constraint and this decision does
not reopen it.

ADR-0007 already admits a different mechanism. Materialized balances are
rebuildable projections, and `inventory_movement` is already a platform-written,
operationless entity. The provider also already serializes posting-linked
aggregate generation and reconciles the append-only movement ledger. A
browsable current projection therefore needs no aggregate-language extension.

The semantic limit is load-bearing. A transactionally maintained total answers
“what is the sum of every movement posted so far?” It does not answer “what was
on hand at an instant?” Naming the former as the latter would invent temporal
evidence the row does not carry.

## Decision

### The row is posted stock for one complete launch stock identity

`posted_stock_balance` is an operationless, provider-written entity labelled
**Posted stock balance**. Its list and detail surfaces are labelled **Posted
stock list** and **Posted stock detail**. No entity, surface, field, query, or
documentation may call it “on hand”.

One row is keyed by:

```text
(selected legalEntityId, itemId, locationId)
```

This adopts ADR-0015 and ADR-0016's complete launch stock-dimension tuple.
Summing locations would answer a consolidated-location question and erase a
member of stock identity. The base `unitId` is stored and checked on the row,
but is not a fourth key member: ADR-0016 makes the item's base unit immutable
once stock exists.

`postedQuantity` is exactly the sum of all non-archived posted
`inventory_movement.quantityDelta` values for that tuple. Zero is retained when
movements net to zero because the row witnesses posted history, not merely a
non-zero result.

### Maintenance shares the posting-linked generation guard

The pinned Inventory contract classifies this family as `providerWritten` and
names its maintainer as
`northstar.postgresql-module-provider:posted-stock-balance/v1`. Authors cannot
set that classification: compiler conformance resolves a candidate canonical
family against the pinned Inventory contract, as it already does for append-only
fact storage, including after composition under the application package
identity. The candidate earns generic CRUD and Form omission only after its
active item, location, posted-quantity and unit fields match the named
maintainer's exact IDs, lifecycle, required presence, storage types, business-key
absence, collation, default semantics and value, search mapping, and storage
evolution. Exactly one active movement companion must also pass its complete
pinned ABI: exact fields and logical shapes, lifecycle and presence,
business-key absence, binary collation, required/optional default semantics,
null default value, the source-id-only search mapping, and no storage evolution.
Its refusing twin examines every authored operation tier and lifecycle and
resolves transition effects through their state machine, rather than reusing the
narrower active-`o0` CRUD set. An unpinned or ABI-incompatible family earns
nothing.

The PostgreSQL provider installs an `AFTER INSERT` movement trigger after the
existing reservation/generation trigger. In the same posting transaction it
upserts the one deterministic posted-stock row and increments only its
optimistic revision. The deterministic digest is encoded with pinned UUIDv4
version and variant nibbles, so provider maintenance and rebuild produce the
same stable identity and the generic record runtime accepts it. Ordinary
module-runtime writes cannot reach the projection; its mutation policies are
usable only at trigger depth. The entity authors zero operations.

This is not a second cache path. The trigger requires the existing
`semantic_aggregate_generations` row advanced by movement posting, and posting,
rebuild, aggregate reads, and reconciliation all use the one existing
`aggregateGenerationLockKey(tenantId, environmentId)` advisory-lock domain.
No per-row generation is copied into the projection: unaffected stock identities
do not advance on another identity's posting, so stamping the global generation
onto every row would itself be a false freshness claim.

### Rebuild replaces only derived rows without hard deletion

The materializer exposes a trusted-scope rebuild and also runs it when the
projection is first materialized. Rebuild:

1. takes the existing posting-generation advisory lock exclusively;
2. refuses a tuple whose ledger movements carry more than one base unit;
3. soft-retires only active `posted_stock_balance` rows for the selected tenant
   and environment; and
4. inserts or reactivates one deterministic row per legal-entity/item/location
   group from the append-only movement ledger, overwriting its derived fields
   with exact `numeric(38,18)` arithmetic.

It holds no DELETE privilege and never updates, deletes, or reinterprets a
movement. Destroying the projection and rebuilding it must reproduce the ledger
sums; rebuilding an extant projection leaves only the ledger-derived rows active.

### Reconciliation is the honesty instrument

Inventory reconciliation independently groups the movement table and compares
the union of ledger and projection identities while holding the shared
posting-generation lock. It reports missing, unexpected, duplicate,
unit-divergent, malformed, and quantity-divergent rows. The reconciliation
transaction remains read-only and never calls the trigger or rebuild code it
verifies.

The five-parameter `inventory_movement_on_hand` lookup remains the precise
bitemporal tool. This packet neither removes nor weakens it.

### The existing renderer is sufficient

The entity uses the registered List and Record renderers and the ordinary
legal-entity query family. No component registry or `apps/web/src` change is
required. With no inventory seed rows, a person must first create the relevant
legal entity, item, and location and post an inventory adjustment or reviewed
stock count before the Posted stock list has a row to show.

## Consequences

- Browsing answers current posted-ledger stock with an explicit temporal limit;
  historical/as-of questions continue through the bitemporal aggregate lookup.
- Projection loss is recoverable from business truth, and drift is named rather
  than silently healed by reconciliation.
- Direct projection writes remain unsupported even though the provider must
  hold narrow trigger and rebuild privileges.
- The new authored entity changes compiled output and therefore mints one new
  application-lineage entry. Every predecessor remains immutable and must
  reproduce under the semantic profile recorded by its own attestation, per
  ADR-0047 §5.
- The bounded additions to the domain and compiler legal-entity family maps and
  provider-written read-model contract are registration and conformance only.
  Compiler lowering, projection shape, aggregate contracts, and the language
  schema are unchanged.

## Evidence and enforcement

- Compiler controls pin the operationless entity, all three honest surface and
  entity labels, exactly-one legal-entity query scope, the resolved
  `providerWritten` classification and its named maintainer. Deleting the
  resolved exemption makes CRUD/Form requirements red; direct `o0`, direct
  `o1`, and transition-authored operations hit the refusing twin. Renaming one
  provider field while updating its references loses the exemption and reports
  the missing and unexpected ABI members; one-property type mutations cover all
  four fields. One-property label and family-registration mutations also record
  the expected red.
- PostgreSQL controls post real quantities and assert the stored arithmetic,
  post a correction and assert the same row moves, destroy and rebuild the
  projection with the same canonical UUIDv4 identity, and corrupt one stored
  quantity so reconciliation records the divergence.
- The composed browser control invokes the ordinary query gateway immediately
  after posting, then selects `DEFAULT` and reads the row through the existing
  responsive List renderer. Its recorded pre-fix red was `recordId must be a
  UUID`: raw MD5 bits were accepted by PostgreSQL's `uuid` type but refused by
  the platform's canonical record-identity contract.
- Catalog controls account for the trigger, its owner-only execution grant,
  trigger-depth runtime policies, and tenant/environment-bounded materializer
  mutation policies.
- `check:app-release` and `test:postgres` gate the new lineage entry and the
  compiler/provider integration. Historical reproduction remains entry-local
  to each recorded compiler semantic profile.

## References

- [ADR-0007](ADR-0007-append-only-inventory-posting-truth.md)
- [ADR-0015](ADR-0015-legal-entity-business-dimension.md)
- [ADR-0016](ADR-0016-stock-identity-dimension-set.md)
- [ADR-0047 §5](ADR-0047-the-compiler-semantic-profile-is-the-projection-evolution-axis.md)
