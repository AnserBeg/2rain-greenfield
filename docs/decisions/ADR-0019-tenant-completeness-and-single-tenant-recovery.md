# ADR-0019: Tenant data completeness and single-tenant recovery

Date: 2026-07-26
Status: accepted (orchestrator ruling, user-authorized 2026-07-26; the completeness manifest is
implemented by the G3 stage cut, the recovery tiers by the G7 recovery packet)
Tier: Critical (review per `review-tiers` when implemented)

## Context

Plan §7.5 requires encrypted backups, point-in-time recovery, restore into an isolated
environment, tenant export, read-model and search-index reconstruction, outbox replay,
release-pointer restoration, and measured RTO/RPO. Every one of those is **whole-cluster**.

Nothing restores **one tenant** to a point in time while the other tenants keep serving. The
topology makes that harder rather than easier: the RLS debate settled on pooled shared tables
(schema-per-tenant was measured to die at 1,000-2,000 tenants), ADR-0010 forbids hard delete,
and the trust substrate is append-only. A restore therefore cannot be expressed as
delete-and-replay, which is the mechanism every naive answer assumes.

This is the most reliably under-designed part of shared-schema SaaS. Salesforce retired its
Data Recovery Service on 31 July 2020 — $10,000, six-plus weeks, and results that were not
reliably complete — before rebuilding it as a product. Vendors discover this during a customer
incident, not in design, which is the worst possible moment to be inventing the mechanism.

Recorded as **G4** in [`prior-art-failure-modes.md`](../execution/prior-art-failure-modes.md).

## Decision

### 1. The tenant completeness manifest

Every table in every plane is classified **exactly once** as either:

- **tenant-scoped**, naming the column that carries the trusted tenant identifier; or
- **tenant-independent**, with a recorded reason (kernel catalog, migration history, shared
  immutable policy-free blob, and so on).

A verifier walks every table in every non-system schema — kernel and managed-module alike —
and fails closed on a table with no classification, an unknown object kind, or more than one
classification. This is deliberately the same shape as ADR-0011's **accounted additive
closure**, applied to tenancy instead of to physical shape, and it should reuse that
verifier's object enumeration rather than growing a second one.

**This is the cheap-now half of the whole ADR.** With roughly ten tables it is an afternoon;
after a hundred tables and a live fleet it is an archaeology project, and until it exists
"export this tenant's data" is a claim rather than a provable operation. It is also the shared
prerequisite for three separate obligations that are currently tracked apart:

- tenant export and documented retention (plan §7.5, already promised);
- single-tenant recovery (tiers R2 and R3 below); and
- data-subject erasure (pending plan-level decision 1), whose crypto-shredding answer needs
  exactly this map to know what a subject's data *is*.

### 2. Three named recovery tiers

**R1 — in-band logical recovery. Preferred, and the answer to most incidents.**

Archive/restore (ADR-0010), named correction and reversal (ADR-0007), and release pointer
rollback (ADR-0006) already cover accidental archive, mis-posted movements, a bad import that
can be reversed, and a bad activation. R1 runs through the ordinary operation algebra, so it
preserves audit truth completely and needs no privileged path. A recovery request that R1 can
serve is served by R1.

**R2 — governed tenant point-in-time reconciliation.**

For damage R1 cannot express: cluster PITR into an **isolated** environment, tenant-scoped
extract at time `T` using the manifest, then a governed reconciliation that brings the live
tenant into agreement with the extract.

The reconciliation appends compensating operations **through the Semantic Operation Gateway**.
It is human-approved, release-pinned, idempotent, resumable, and fully audited, and it runs
against a tenant-scoped write freeze — R2 does not promise recovery while that tenant's own
users keep writing.

**R3 — tenant reconstruction into a fresh environment.**

PITR plus isolated restore plus full tenant import into a new tenant/environment. This is the
"give me my data as it was" case. It never touches the live tenant, and it is the tier most
customers actually want when they ask for a restore.

### 3. The binding prohibition

**No recovery path writes business rows into a live tenant by direct DML.**

Not the recovery service, not an operator script, not a support tool, not a migration. A
restore that bypasses the Semantic Operation Gateway is a second write authority, and plan §17
already makes that a stop condition; this ADR removes the "except during recovery" reading
that would otherwise be discovered under incident pressure.

The isolated-environment restore in R2 and R3 is unconstrained — it is a separate database
with no live tenant in it. The constraint binds only where the target is serving.

### 4. Restore is forward motion, not rollback

Because posted facts cannot be edited and business data cannot be hard-deleted, R2 cannot
"put the tenant back". It brings current state into agreement with target state by appending
corrections, and **the divergence itself becomes a permanent auditable fact**.

This is stated plainly because it is a real product consequence, not a limitation to be
papered over: a customer who recovers from a bad Tuesday will see both the bad Tuesday and its
correction in their history forever. That is the honest trade for an audit trail that never
lies, and it must be explained in the recovery runbook rather than discovered by the first
customer.

### 5. What is not promised at launch

- A per-tenant RPO independent of the cluster's PITR window.
- Sub-cluster point-in-time granularity.
- Recovery of a tenant while that tenant's users continue writing.
- Self-service restore. R2 and R3 are operator-run under approval.

Whether single-tenant recovery is a **product promise** with a published RTO/RPO is a
commercial decision owned by G7/G8, not by this ADR. The recommendation is to promise R1 and
R3 at launch and treat R2 as an operator capability with a best-effort target, because R2's
freeze requirement makes a hard RTO dishonest. What this ADR fixes is that the mechanism
exists and the manifest that all three tiers depend on is built while it is still cheap.

## Consequences

- Tenant export stops being a claim and becomes a provable operation with a completeness
  verifier behind it.
- Pending decision 1 (erasure) gets its hardest prerequisite for free; whichever answer that
  debate reaches, it needs the manifest first.
- The manifest is a standing obligation, not a one-off: every new table in either plane must
  classify itself, and the verifier fails closed rather than defaulting.
- R2's write-freeze requirement is a real product limitation and belongs in the runbook and in
  any customer-facing recovery commitment.
- The no-live-DML rule constrains the recovery service's implementation and removes the
  fastest-looking option. That is intentional; the fast option is how audit trails get
  quietly broken during incidents.

## Evidence

- Plan §7.5 backup and recovery, §7.2 tenant isolation, §15.1 recovery point/time objectives,
  §11.10 G7 reliability item 6, §17 stop rules.
- ADR-0010 recovery orchestration and the no-hard-delete doctrine; ADR-0007 append-only
  posting; ADR-0006 approval-gated activation, which R1 rollback runs through.
- ADR-0011 accounted additive closure — the enumeration pattern the manifest verifier reuses.
- ADR-0018 recorded time, which is what makes a tenant-scoped extract at time `T` meaningful.
- The already-routed finding "PITR restore must replay materialization to the union of live
  roots" (`current-plan.md`), which R2 and R3 both inherit.
- [`prior-art-failure-modes.md`](../execution/prior-art-failure-modes.md) **G4**.

## Enforcement

- Structural test: every table in every non-system schema resolves to exactly one tenancy
  classification; an unclassified table fails closed, with a recorded negative control adding
  an unclassified table and observing the red.
- Structural test: no code path outside the isolated-restore boundary issues business-row DML
  against a live tenant, and the recovery service holds no such capability.
- Provider test: a tenant-scoped extract at a stated recorded-time horizon returns every
  tenant-scoped table's rows and nothing from another tenant, proven with the two-tenant
  fixture required by plan §7.2.
- G7 recovery drill: R1, R2 and R3 each rehearsed with measured times, and R2's reconciliation
  proven idempotent under interruption and resumption.
