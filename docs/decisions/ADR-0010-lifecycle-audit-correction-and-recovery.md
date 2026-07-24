# ADR-0010: Lifecycle, audit, correction, and recovery doctrine

Date: 2026-07-21
Status: accepted
Tier: Critical (review per `review-tiers`)

## Context

Every channel needs shared attribution and reconstructable change history, but
that substrate must not replace domain events, inventory ledgers, release
history, or specialist operation evidence. Ordinary deletion must be
recoverable, externally meaningful facts must retain correction lineage, and
system recovery must be explicit and verifiable.

## Decision

The shared trust substrate has these exclusive contracts:

- `ActionInvocation` is the sole cross-channel invocation-evidence authority
  for allowed, denied, failed, timed-out, and successful attempts. It records
  stable request/action/channel/outcome/correlation identity and redacted
  metadata without copying unrestricted payloads.
- `BusinessChangeDocument` is the sole cross-cutting audit authority for an
  accepted meaningful business mutation. It records the affected canonical
  record, operation/event identity, explicit old/new/absent/cleared semantics,
  revision, release, and actor/delegation envelope.
- The compiled O0 archive/restore path through `SemanticOperationGateway` is
  the sole generic lifecycle executor for eligible master and draft records.
  The earlier unused `LifecycleService` contract is superseded because its ID
  convention and input shape did not match the compiled O0 contract. The
  gateway and generic provider interpreter recheck current policy, relations,
  conflicts, versions, confirmation, and idempotency.
- An immutable domain `CorrectionLink` between original and correcting facts
  is the sole cross-cutting correction-lineage authority. The registered domain
  correction/reversal operation owns compensating business semantics.
- The shared `RecoveryService` is the sole orchestration authority for declared
  backup restore, point-in-time recovery, derived-model rebuild, outbox
  reconciliation, and release-pointer restoration. It follows an approved
  runbook and emits immutable `RecoveryAttempt` evidence and discrepancies.

An approved recovery runbook authorizes recovery mechanics, not release
selection. Any active-pointer restoration is a release activation transition
governed by ADR-0006: it requires an exact `ReleaseApproval`, a current-policy
recheck, an atomic single-attempt claim, pointer compare-and-swap, and read-back.
`RecoveryService` cannot infer or bypass that approval.

Trusted actor identity comes from ADR-0004 and is never accepted from operation
input. Evidence distinguishes execution principal, subject human, approving
human, initiating human, and AI/automation/service/system actor kinds where
applicable. An AI or automation action never collapses into a human-only row.

The business mutation, `BusinessChangeDocument`, accepted invocation outcome,
domain events, and transactional outbox commit or roll back together. Domain
events, inventory movements, operation verification, agent traces, release
history, and document histories retain their specialist semantic authority and
link through stable invocation/change/correlation IDs; they are not copied into
a second universal ledger.

Draft facts may be edited within their declared lifecycle. Master data uses
archive/restore and is hidden from ordinary operational queries by default.
Posted inventory and externally meaningful commercial facts use named
cancel/correct/reverse/supersede operations, never edit, archive, or ordinary
delete. Every correction preserves the original fact and its immutable link to
the correcting fact.

No ordinary hard-delete path exists for business data. Physical purge is an
unsupported, separately governed retention capability at launch, never a
normal UI, API, workflow, import, or agent tool. Any later purge design requires
a new ADR, human-only authorization, retention/hold/relationship checks, impact
preview, approval, idempotency, verification, and a non-sensitive tombstone.

Recovery never silently edits canonical facts to make projections agree.
Backups, isolated restore, read-model/index rebuild, outbox reconciliation,
immutable revision restoration, and active-pointer restoration require
measured evidence. Pointer restoration additionally retains its ADR-0006
approval and activation-attempt evidence. Same-database audit records and
hashes are not described as tamper-proof.

## Consequences

- Human, agent, automation, service, and system effects share attribution
  without losing specialist business evidence.
- Archive/restore is distinct from correction/reversal and from deferred purge.
- Restoration and reconciliation surface discrepancies instead of silently
  rewriting business truth.
- Sensitive values, secrets, credentials, and large payloads stay out of the
  universal journal.

## Evidence

- Plan sections 1, 3, 5.7-5.10, 7.3-7.5, 8.5, 11.3, 14, and 15.3 define
  transactional evidence, lifecycle, correction, and recovery obligations.
- REFERENCE only: prior repository
  `docs/erp-trust-data-lifecycle-plan.md` at `chess@668a60b`, sections 3-5, 7,
  and 10, for the evidence envelope, actor/delegation distinctions,
  archive/restore contract, verification gates, and production recovery gate.
  No prior implementation or runtime dependency is admitted.

## Enforcement

G0-P3 must reject ordinary physical-delete paths and duplicate universal audit
or actor-context authorities. G1-G3 must test transactional change evidence,
actor/delegation attribution, archive/restore defaults and conflicts,
correction lineage, append-only specialist facts, redaction, and absence of
agent purge. Launch requires isolated restore, read-model rebuild, outbox
reconciliation, release restoration, and measured recovery evidence.
