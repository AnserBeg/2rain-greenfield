# ADR-0027: Inventory transfer as a posting command family

Date: 2026-07-30
Status: proposed by packet G3-P4a; ratified when that packet is accepted
Tier: Critical (review per `review-tiers`)
Supersedes: ADR-0026 only where it withholds transfer authorization

## Context

ADR-0026 admits `northstar.inventory:capability.posting` version 1 as the sole
Inventory movement writer, but authorizes only the adjustment command family.
Its boundary explicitly withholds transfer and requires a superseding decision
for a new command family. Reusing the capability is not enough: ADR-0026's rule
remains that similarity to an admitted capability is not authorization.

The frozen Inventory contract already contains the transfer vocabulary and
configuration needed by the command. This decision verified all of the
following at packet draft `6e47017`:

- `packages/domain/src/inventory/definition.ts:223` includes `transfer` in the
  frozen `inventory_transaction_type` options;
- `packages/domain/src/inventory/definition.ts:456` includes `transfer` in the
  frozen `inventory_posting_role` options;
- `packages/domain/src/inventory/contracts.ts:435` sets the transfer reason
  requirement to `codeOnly`;
- `packages/domain/src/inventory/contracts.ts:443` sets the default transfer
  approval threshold to `null`; and
- `packages/domain/src/inventory/contracts.ts:465-469` binds the capability to
  dependency-set v3 with root
  `35fc38eaca7fbe47d8da5030ceefce8211a2194a25d233c45282ef0450d553ad`.

The v3 dependency plan already covers trusted context, stock identity, exact
quantity delta, source identity, posting role, reason and approval, Item base
unit and lifecycle, Location and legal-entity lifecycle, the period lock,
posting configuration, serialized movement reads, the complete transaction
line set, the transaction transition, movement append, and the shared trust,
outbox, and receipt reads and appends. A transfer derives its source and
destination quantity deltas and stock identities from those existing inputs.
It introduces no authoritative access outside that plan.

The G3-P4a draft adds no canonical definition, contract, dependency-set,
storage-target, migration, or serializer change. Transfer therefore needs an
authorization decision, but it does not need a capability-version,
dependency-set, canonical-language, storage-target, or migration version event.

## Decision

This ADR supersedes ADR-0026 only by admitting the transfer command family as a
second closed command family of
`northstar.inventory:capability.posting` version 1.

Transfer is implemented by the existing G3-P3 provider adapter and its one
shared top-level transaction protocol. `postTransfer` validates the
transfer-specific closed input and delegates to the same private posting
transaction as `postAdjustment`; it does not create a second transaction
coordinator, movement writer, trust writer, or posting implementation.

Registration remains pinned to dependency-set v3 and its root above, the exact
active release content hash, and
`northstar.storage-target-payload/v3`. ADR-0026's recorded limit also remains:
the current active release has no persisted posting-capability declaration.
This decision does not manufacture a second admission authority and does not
claim release-persisted capability admission.

Each transfer line carries one strictly positive exact-base-unit quantity and
two distinct locations. The adapter derives exactly two append-only movements
inside the shared transaction:

- a negative source movement at `fromLocationId`, with natural source line
  `<sourceLine>:out` and posting role `transfer`; and
- an equal positive destination movement at `toLocationId`, with natural
  source line `<sourceLine>:in` and posting role `transfer`.

Both movements retain the existing natural-effect key
`(source_type, source_id, source_line, revision, posting_role)`, reference the
same transaction and persisted transaction line, use one trusted
`recordedAt`, and commit only with the draft transition and linked trust
evidence. Request-key and natural-effect retries return the original pair;
different business input under an existing idempotency identity fails typed.

Transfer consumes the same release-recorded negative-stock, maximum-backdate,
period-lock, reason, and approval decisions as adjustment, selecting the
already-frozen transfer entries in the posting-role maps. No transfer rule is
ambient or evaluated as a preflight.

## The new correctness surface

A one-line adjustment can affect one stock identity. A one-line transfer
affects two: its source and destination. G3-P4a is therefore the first
production posting path to consume G3-P2b-2's multi-identity deterministic
total order.

The consumed order is:

1. ascending signed PostgreSQL physical identity key; then
2. ascending canonical lowercase UUID tuple
   `(tenantId, environmentId, legalEntityId, itemId, locationId)` as the
   collision tie-breaker.

Exact duplicate identities are removed. Physical-key-first ordering ensures
that every transaction sharing an advisory key acquires its keys in the same
order, including the collision case.

G3-P4a does not modify
`packages/postgres-provider/src/stock-serializer.ts`. The shared posting
transaction calls the existing `acquireStockIdentityLocks` immediately after
`BEGIN` and supplies identities derived from both transfer movements.

The transfer-specific production control is
`assertConcurrentOppositeTransfers` in
`test/postgres/inventory-posting.test.ts:1265`. It starts real concurrent
A-to-B and B-to-A postings in opposite caller order. Its query proxy pauses
each backend after its first successful NSST acquisition; the control requires
both callers to converge on the same first physical key, observes the other
backend waiting on that ungranted key, then requires both postings to commit
with no `40P01`. If production ordering is removed, the callers reach the
pause holding different first keys and PostgreSQL constructs the real
deadlock. This is an execution-observing control, not an elapsed-time or
source-text proxy.

That control is authored but was not run in this ADR-authoring sandbox. Its
green runtime verdict is therefore a condition of packet acceptance, not a
result claimed by this document.

## Boundaries

This decision does not authorize:

- stock-count correction, tracked as row `5g3-p4b`; that command family owes
  its own superseding ADR, the absent `stock_count` and `stock_count_line`
  evidence entities, and a dependency-set v4 event with before/after roots;
- reservations, which remain owned by G5-P1;
- valuation, receipt cost, currency, price, monetary amount, or any other
  monetary artifact;
- purchasing, mutable balances, or a second posting implementation;
- an HTTP route, UI binding, top-level agent tool, or import path;
- a change to the stock identity, its lock derivation, or
  `stock-serializer.ts`; or
- release-persisted capability admission or the still-deferred policy kernel.

The already-frozen `count` and `correction` posting-role spellings are no more
authorization for stock-count correction than the pre-existing `transfer`
spelling was authorization for this command. Similarity to this capability is
not authorization.

## Consequences

Inventory can move exact base-unit quantity between two stock identities
without forking the accepted append-only movement truth, natural idempotency
key, trust aggregate, stock serializer, or top-level transaction protocol.

The source debit and destination credit are one atomic business outcome.
Neither side may commit alone, and serialized negative-stock evaluation sees
the source effect in the frozen global movement order before any movement is
appended.

The new command family broadens only the accepted provider adapter. Generic Q0
remains the movement read path, generic O0 remains the ordinary draft-lifecycle
executor, and no generic compiler, runtime, materializer, gateway, or fallback
dispatch gains an Inventory branch.

The transfer command inherits ADR-0026's known limits. It is not externally
wired, is not admitted from an active release declaration, and depends on the
current upstream ALLOW decision while the real policy kernel remains deferred.

## Verification

The controls below are the evidence obligations for ratification. Source facts
were inspected at `6e47017`; Docker-backed controls and the full matrix remain
for the orchestrator.

| Claim | Control or observation | What it proves, and current status |
|---|---|---|
| Transfer fits the frozen contract with no version event | Exact inspection of `definition.ts:223,456`, `contracts.ts:435,443,465-469`, the v3 dependency plan at `contracts.ts:359-428`, and the packet diff | The required type, role, defaults, dependency version, root, and accesses already exist, and the draft changes no contract or migration file. Verified in this authoring round. |
| Transfer uses one posting implementation and the G3-P3 transaction order | `postAdjustment` and `postTransfer` both enter the private `#post`; `#post` calls the unchanged serializer at `inventory-posting-service.ts:394` before business reads and before its caller savepoint | Structural source evidence verifies there is one coordinator. It does not by itself prove PostgreSQL atomicity. |
| A transfer persists one balanced pair and exact retries do not duplicate it | `assertTransferPosting` at `inventory-posting.test.ts:982` | Requires observed `-2`/`+2` transfer movements, source/destination balances `3`/`2`, one posted draft transition, request and natural replay of the original pair, and typed rejection of same-key/different-input. Authored; not run in this sandbox. |
| A source movement cannot commit without its destination or trust aggregate | `assertTransferRollbackIsAtomic` at `inventory-posting.test.ts:1218` | A non-transactional sequence proves the first INSERT executed; rejection of the second side must leave no transfer movement, effect companion, new trust row, or draft transition. Authored; not run in this sandbox. |
| Transfer consumes its frozen reason, approval, and period-lock decisions | Transfer branches within `assertTransferPosting` at `inventory-posting.test.ts:1099-1183` | Requires typed blank-code, approval-threshold, and closed-period rejections, plus code-only and approving-human success. Authored; not run in this sandbox. |
| Opposite real transfers consume the deterministic multi-identity order without deadlocking | `assertConcurrentOppositeTransfers` at `inventory-posting.test.ts:1265` | Requires a common granted first key, an observed ungranted waiter, two fulfilled postings, and no `40P01`; ordering removal constructs the real deadlock. Authored; not run in this sandbox. |
| Serialized negative-stock evaluation consumes the frozen global movement order | `assertPersistedPlannedOrderIsDecisive` at `inventory-posting.test.ts:1426` | A same-instant planned debit must sort before a persisted credit and reject; deleting the production persisted-plus-planned sort changes the verdict to commit. Authored; not run in this sandbox. |
| The final `movementId` branch of the global order is load-bearing | Top-level pure control `the global same-instant order reaches its movementId tie-break` at `inventory-posting.test.ts:156` | The production comparator sorts a pair differing only in `movementId`; the author previously executed the passing control and its branch-deletion red. This is not PostgreSQL or full-matrix evidence. |

This ADR deliberately does not claim that the G3-P4a PostgreSQL controls, the
opposite-transfer no-deadlock outcome, the full CI matrix, or the Critical
review chain have passed. None was run in this authoring round.

It also does not claim a transfer-specific proof that monetary members are
absent from movement and trust evidence. The existing
`assertQuantityOnlyEvidence` control is invoked on an adjustment result, not a
transfer result. Monetary artifacts remain unauthorized, but a transfer result
and its linked evidence have not yet been independently scanned by an executed
control.
