# ADR-0024: Exact compatible release reversal

Date: 2026-07-29
Status: proposed by packet 1g2; pending packet acceptance
Tier: Critical (review per `review-tiers`)

## Context

ADR-0001 says rollback selects a prior immutable release. ADR-0006 requires that selection
to use the same human-approved, compare-and-swap activation path as forward promotion and
allows it only while data and runtime contracts remain compatible. Packet 1g made forward
advancement executable, but also proved that its compiled lineage edge cannot be run
backwards: release B contains the immutable `A -> B` storage transition, while A contains
`bootstrap -> A`. Recompiling A against B would mint another release rather than select A.

Pointer reversal also cannot imply physical reversal. A forward edge may already have
created an additive table, column, index, constraint, or backfill state. ADR-0011 forbids
destructive managed-storage cleanup, requires old/new coexistence, and records each
activated transition as `NO_STORAGE_TRANSITION`, `REVERSIBLE`, or `IRREVERSIBLE`, with a
corresponding recovery mode. The release kernel already persists the exact approval,
transition receipt, pointer fence, swap receipt, and successful activation verification.
Those facts are sufficient to decide one exact reversal without a new database authority or
migration.

## Decision

A rollback is an **exact compatible pointer reversal**, not a reverse compile and not a
reverse storage plan.

The only admissible request is `B -> A` where all of the following hold:

1. B is the current active release and A is B's immediate immutable revision predecessor in
   the supplied, content-verified compiled application lineage. Bootstrap is not a runnable
   rollback target for the composed application, and an edge cannot be skipped.
2. The activation that established the current pointer generation is exactly the verified
   `A -> B` activation. An older receipt for the same release IDs cannot authorize a later
   pointer generation.
3. That activation's exact-pair transition receipt, approval, roots, and verification remain
   present and internally bound.
4. Its recorded class is either:
   - `NO_STORAGE_TRANSITION` with `NO_STORAGE_RECOVERY_REQUIRED`; or
   - `REVERSIBLE` with `REVERSIBLE` recovery.

`IRREVERSIBLE` / `FORWARD_RECOVERY_ONLY`, missing or unverified forward evidence, a
non-adjacent target, and a target outside the lineage each fail closed with a typed rollback
refusal before a reverse approval is created. The remedy for an irreversible edge is a
governed forward recovery release, never an inferred pointer reversal.

An admitted reversal then uses the real release path: canonical preparation over B and the
already admitted immutable A, a fresh human approval bound to the current pointer and
fence, the ordinary activation service, exact compare-and-swap, pointer read-back, active
verification, history, and outbox evidence. The
`active_release_pointer_exact_swap` trigger remains enabled and asserted throughout.

The reverse execution receipt is correctly `NO_STORAGE_TRANSITION`: the reverse operation
performs no DDL or DML compensation. Its fact digests bind the policy version and the exact
forward activation/receipt that made reversal admissible. Approval and activation
independently re-evaluate that forward provenance; the composition root is not trusted as
the sole guard.

Storage materialized by A -> B remains materialized. Reversal guarantees that A's compiled
read/write contract remains compatible with that additive physical superset; it does not
promise schema equality with the pre-B database. Business rows are neither recreated nor
rewritten. A later restart without a rollback request replays the unchanged compiled
`A -> B` edge through a fresh preparation, approval, materialization-convergence check, and
activation. It does not recompile A or mint a replacement for it.

## Rejected alternatives

- **Recompile the old definition against B.** This is forward motion to a new immutable
  identity, not rollback to A, and loses the meaning of the approved historical release.
- **Unconditionally point at any prior release.** A prior artifact does not prove that the
  transition which established the current storage state preserved its runtime contract.
- **Run the forward storage plan backwards.** Current managed transitions are additive and
  coexistence-oriented; destructive DDL conflicts with ADR-0011 and the no-hard-delete
  doctrine. No inverse plan exists in compiler output.
- **Invent compensating DDL/DML in the provider.** That would be a second desired-state
  authority and would make recovery semantics provider-specific. A future compensating
  family would require its own canonical/compiler contract and migration budget.
- **Add a rollback table or mutable flag now.** The exact forward activation and recovery
  classification already exist in immutable kernel records. Duplicating them would create a
  new statement that could drift from its source evidence.
- **Permit multi-edge rollback in one request.** Compatibility is proven pairwise. Skipping
  an edge would turn a chain of local proofs into an unproved aggregate and obscure which
  physical changes remain. Further reversal requires another separately proven policy in a
  future packet.

## Consequences

- G2-P9 can exercise compile -> verify -> activate -> rollback for current no-storage and
  additive reversible transitions, including a storage-changing A -> B edge.
- Rollback keeps the prior immutable release identity and reuses its durable content-bound
  verification evidence; the fresh approval reviews the reverse selection and its bound
  forward compatibility evidence.
- Physical storage is monotonic across rollback. Operators must not interpret rollback as a
  schema restore or business-transaction reversal.
- A current release established by an irreversible, unverified, non-adjacent, or already
  reversed edge is not rollback-capable under v1. It remains serviceable and requires
  forward recovery.
- No migration or canonical-language change is introduced. A future inverse/compensating
  storage mechanism would be a different policy and cannot silently widen this one.

## Evidence

- Packet 1g records the directional immutable lineage and its rollback boundary.
- `platform.release_activation_swap_receipts`, activation verification receipts, approvals,
  and transition-preparation receipts persist the exact current-generation forward facts.
- ADR-0011's module compatibility policy records current storage transitions as reversible
  only after exact-pair, applied-state, and coexistence checks succeed.
- Packet 1g2's PostgreSQL control materializes a real nullable column, preserves the Party
  row's `ctid` and `xmin` through forward activation, reversal, and fresh v2 replay, and
  observes that the column remains present after A is active again.

## Enforcement

`release-reverse-transition-policy.ts` selects only the verified activation at the current
pointer fence and returns a typed refusal for every inadmissible reverse edge. The composed
application checks it before preparation; release approval and activation invoke the same
policy again so bypassing the composition root does not bypass the rule.

`test/postgres/composed-application.test.ts` executes the complete A -> B -> A -> B journey,
asserts physical tuple identity and the retained storage column, asserts fresh approval and
exact-swap trigger evidence, and forces the persisted forward classification to
`IRREVERSIBLE` / `FORWARD_RECOVERY_ONLY` to observe
`ROLLBACK_FORWARD_TRANSITION_NOT_REVERSIBLE` before approval.
