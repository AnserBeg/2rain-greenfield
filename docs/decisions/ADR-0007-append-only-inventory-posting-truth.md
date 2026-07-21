# ADR-0007: Append-only inventory posting truth

Date: 2026-07-21
Status: accepted
Tier: Critical (review per `review-tiers`)

## Context

Inventory cannot tolerate a writable balance column, a source-document total,
or a cache becoming a peer source of truth. Receiving, adjustments, transfers,
counts, reservations, and shipping must converge on one posting model that
survives retries, concurrency, correction, and reconstruction.

## Decision

Inventory quantity authority is exclusive:

- append-only posted `InventoryMovement` facts are the sole on-hand authority;
- active `Reservation` facts are the sole reserved-quantity authority; and
- the registered `inventory.availability` read model is the sole supported
  calculation of available quantity from those two authorities.

Materialized balances, cached totals, UI fields, reports, source-document
progress, and search indexes are rebuildable read-model projections. They are
never independently writable and never become reconciliation authority.

Only a registered inventory posting handler invoked through the Semantic
Operation Gateway may append movements. The inventory domain owns posting
invariants; purchasing, sales, UI, API, agent, workflow, import, and reporting
code submit semantic operations and do not write inventory tables directly.

A posting validates the complete command before mutation and commits source
state, exact base-unit movement facts, action/change evidence, domain events,
and outbox records atomically. Each effect has stable source-document,
source-line, tenant, actor, release, and idempotency identities. One source
effect cannot post twice. Transfers append balanced source/destination facts
in the same transaction. Reservations recheck current availability and record
versions at execution.

A posted movement has no update, archive, or delete path. Corrections and
reversals use named inventory operations that reference the original fact and
append explicit compensating movements; they never rewrite history or directly
set a balance. Effective time and recorded time remain distinct.

## Consequences

- On-hand can always be recomputed as the sum of posted movements.
- Reserved and available remain separate concepts under concurrency.
- Reconciliation compares projections to canonical facts and reports drift;
  it never silently repairs facts.
- Source documents retain their own lifecycle but do not own inventory truth
  after effects post.

## Evidence

- Plan sections 1, 3, 6.3-6.9, 7.3-7.4, and 11.3 define the posting formula,
  invariants, correction rules, and gateway boundary.
- G3's salvage map will separately govern any RE-EXPRESS work from the frozen
  inventory candidate; this ADR admits no prior code or tests.

## Enforcement

G0-P3 must reject direct cross-domain inventory writes and writable balance
fields. G3 must prove append-only provider constraints, idempotency,
concurrency, transfer balance, correction lineage, exact arithmetic,
recomputation, projection drift detection, and no update/delete path.
