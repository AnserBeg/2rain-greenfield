# ADR-0027: Inventory transfer as a posting command family

Date: 2026-07-30
Status: **ratified** 2026-08-21 — G3-P4a is accepted (ledger; reviewed and integrated
`7711570c8eabc710a8a8eb2f0d4a597610377d0b`), completing the condition this ADR set for
itself. (Status corrected by the orchestrator's 2026-08-21 record sweep, disposing program
review R1, which found the condition met and the text stale.)
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

The G3-P4a implementation adds no canonical definition, contract,
dependency-set, storage-target, or serializer change. It does change one
persisted receipt input: the posting command digest now includes
`postingRole`, where the accepted G3-P3 digest did not. It also adds
`postingRole` to each movement in the persisted `mutation_result`. Transfer
therefore needs both this authorization decision and an explicit receipt
artifact version event. It does not need a capability-version, dependency-set,
canonical-language, or storage-target version event.

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

The receipt boundary is versioned additively by migration 0016:

- existing `semantic_operation_receipts` rows receive
  `input_digest_version = 1` without changing `input_digest`;
- v1 replay hashes `canonicalize(semanticInput)`, matching G3-P3;
- new Inventory posting receipts explicitly write
  `input_digest_version = 2` and hash
  `canonicalize({ postingRole, ...semanticInput })`; and
- replay selects the digest algorithm from the stored
  `input_digest_version`, never from the current writer constant.

The stored version also closes the adjacent result-shape boundary. Every v1
Inventory receipt predates transfer authorization and therefore represents an
adjustment. Its replay reader adds `postingRole: 'adjustment'` to the returned
movement shape. A v2 receipt requires its persisted movement role. The
immutable v1 `mutation_result` is not rewritten.

Migration 0016 is one additive column and one bounded check. It preserves every
existing digest byte-for-byte. It changes no canonical bytes, release golden,
dependency-set root, storage-target root, or content hash; there is therefore
no before/after digest, golden, or root value to record.

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
`test/postgres/inventory-posting.test.ts:1402`. It starts real concurrent
A-to-B and B-to-A postings in opposite caller order. Its query proxy pauses
each backend after its first successful NSST acquisition; the control requires
both callers to converge on the same first physical key, observes the other
backend waiting on that ungranted key, then requires both postings to commit
with no `40P01`. If production ordering is removed, the callers reach the
pause holding different first keys and PostgreSQL constructs the real
deadlock. This is an execution-observing control, not an elapsed-time or
source-text proxy.

At reviewed candidate `41ceb638`, the orchestrator reports that the full matrix
was green. Fable max independently ran the opposite-transfer removal red in a
scratch copy and reproduced the expected failure
`opposite callers acquired different first stock keys`. Those are
orchestrator/reviewer records, not author-run evidence for the uncommitted
round-4 fixes.

## Boundaries

This decision does not authorize:

- stock-count correction, tracked as row `5g3-p4b`; that command family owes
  its own superseding ADR, the absent `stock_count` and `stock_count_line`
  evidence entities, and a dependency-set v4 event with before/after roots;
- reservations, which remain owned by G5-P1;
- valuation, receipt cost, currency, price, monetary amount, or any other
  monetary artifact;
- purchasing, mutable balances, or a second posting implementation;
- an HTTP route, UI binding, top-level agent tool, or import path (amended
  2026-09-30: now "a top-level agent tool or import path" -- see *Amendment
  2026-09-30* below);
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
were inspected at draft `6e47017`; the orchestrator reports the full matrix
green at reviewed candidate `41ceb638`. The new round-4 controls remain for the
orchestrator to run after freezing a replacement candidate.

| Claim | Control or observation | What it proves, and current status |
|---|---|---|
| Transfer fits the frozen domain contract without a domain-artifact version event | Exact inspection of `definition.ts:223,456`, `contracts.ts:435,443,465-469`, the v3 dependency plan at `contracts.ts:359-428`, and the packet diff | The required type, role, defaults, dependency version, root, and accesses already exist. The receipt change is separately versioned by migration 0016; the domain artifacts remain unchanged. |
| A pre-G3-P4 adjustment receipt remains replayable | `cloneLegacyAdjustmentReceipt` plus the request replay in `inventory-posting.test.ts` | Clones a real receipt into the persisted v1 digest and result shape, then requires the stored version to select the v1 digest and restore `postingRole: 'adjustment'` in the returned movement. Authored in round 4; not PostgreSQL-run by the author. |
| Transfer uses one posting implementation and the G3-P3 transaction order | `postAdjustment` and `postTransfer` both enter the private `#post`; `#post` calls the unchanged serializer at `inventory-posting-service.ts:414` before business reads and before its caller savepoint | Structural source evidence verifies there is one coordinator. It does not by itself prove PostgreSQL atomicity. |
| A transfer persists one balanced pair and exact retries do not duplicate it | `assertTransferPosting` in `inventory-posting.test.ts` | Requires observed `-2`/`+2` transfer movements, source/destination balances `3`/`2`, one posted draft transition, request and natural replay of the original pair, and typed rejection of same-key/different-input. The orchestrator reports it green at `41ceb638`. |
| Transfer movements, read-back, effect companions, and trust/outbox evidence remain quantity-only | Transfer invocation of `assertQuantityOnlyEvidence` in `inventory-posting.test.ts` | Requires the two returned movements, both persisted movement rows, both effect-companion rows, one business-change document, one domain-event payload, and one outbox row to exist before rejecting monetary keys and semantic `fieldId` values across all eight documents. The new actual-shape `fieldId: 'unitCost'` red is authored in round 4 and not PostgreSQL-run by the author. |
| A source movement cannot commit without its destination or trust aggregate | `assertTransferRollbackIsAtomic` at `inventory-posting.test.ts:1355` | A non-transactional sequence proves the first INSERT executed; rejection of the second side must leave no transfer movement, effect companion, new trust row, or draft transition. The orchestrator reports it green at `41ceb638`. |
| Transfer consumes its frozen reason, approval, and period-lock decisions | Transfer branches within `assertTransferPosting` in `inventory-posting.test.ts` | Uses adjustment threshold `1` and transfer threshold `3`: an unapproved quantity-2 transfer must post, while quantity 4 must reject without and post with an approving human. This catches a regression to `approvalThresholds.adjustment`. Authored in round 4; not PostgreSQL-run by the author. |
| Opposite real transfers consume the deterministic multi-identity order without deadlocking | `assertConcurrentOppositeTransfers` at `inventory-posting.test.ts:1402` | Requires a common granted first key, an observed ungranted waiter, two fulfilled postings, and no `40P01`; Fable max reproduced the ordering-removal red at `41ceb638`. |
| Serialized negative-stock evaluation consumes the frozen global movement order | `assertPersistedPlannedOrderIsDecisive` at `inventory-posting.test.ts:1563` | A same-instant planned debit must sort before a persisted credit and reject; Fable max reproduced the persisted-plus-planned sort-removal red at `41ceb638`. |
| The final `movementId` branch of the global order is load-bearing | Top-level pure control `the global same-instant order reaches its movementId tie-break` in `inventory-posting.test.ts` | The production comparator sorts a pair differing only in `movementId`; Fable max reproduced the comparator-branch deletion red at `41ceb638`. |

Review evidence at `41ceb638` is recorded with its actual provenance: the
orchestrator reports a green full matrix; Fable max returned CONFIRM and
executed the three ordering reds above; Codex xhigh returned REVISE with the
unversioned receipt and monetary-scan findings. The orchestrator adjudicated
both findings as correct. The uncommitted round-4 changes address those two
findings and the approval observation gap, but have not yet been frozen,
PostgreSQL-gated, matrix-gated, or re-reviewed.

## Amendment 2026-09-30 — INVENTORY-PARITY: transfers reach the posting route (owner ruling R4, 2026-09-30)

The Boundaries bullet "an HTTP route, UI binding, top-level agent tool, or
import path" now reads "a top-level agent tool or import path". Transfer is
admitted through exactly one route: the registered capability operation
`inventory_transaction_post` (tier o1, `confirmation: humanRequired`,
precondition state = draft), run by the sole Inventory adapter
`INVENTORY_POSTING_CAPABILITY_EXECUTOR_FACTORY`.

That adapter reads the stored draft and dispatches on its stored type:
`adjustment` to `postAdjustment`, `transfer` to `postTransfer`. It refuses every
other type with its declared verification refusal, "only adjustment and
transfer drafts are admitted by this route". The UI binding is the inventory
transaction draft editor (draft state only) and that operation's command on the
saved record.

The route decides no transfer rule of its own. Validation, the two legs, the
stock-identity lock order, the negative-stock and reservation refusals, the
reason/approval/backdate/period decisions and the v2 receipt digest all remain
the kernel's, unchanged. Stock-count posting stays unauthorized.

The Consequences sentence "It is not externally wired" is withdrawn for this
route only. Admission still rests on the current upstream ALLOW decision.
