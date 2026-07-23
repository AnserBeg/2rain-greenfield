# ADR-0011: Compiled module storage and transitions

Date: 2026-07-22
Status: candidate — Freeze F is not ratified before G2-P2c
Tier: Critical (review per `review-tiers`)

## Context

The canonical package is the sole application desired-state authority, while
PostgreSQL kernel migrations already own the platform plane. Ordinary modules
need typed relational storage without creating a second manifest, a private
gateway, per-module SQL, or an ambiguous second schema owner. Additive changes
also have to coexist with release-pinned old and new requests, human-controlled
activation, forced RLS, crash recovery, and future generated-storage promotion.

The storage-topology debate converged on 2026-07-22. Its verdict is binding for
this ADR: generic interpretation, exclusive non-overlapping desired-state
ownership, dedicated typed tables at launch, pairwise hermetic compilation,
materializer-side live-root validity, accounted additive closure, versioned
two-class preparation, compiler-derived conformance, and three serial proof
packets. This ADR records that decision; it does not reopen the debate.

G2-P2a checks in a contract candidate and compile-only definitions. G2-P2b
must prove materialization against PostgreSQL. G2-P2c must prove the identical
candidate through generic Q0/O0 runtime and trust journeys. Only then may
Freeze F be ratified.

## Decision

### Exclusive desired-state ownership

The database has two disjoint planes and exactly one desired-state authority
for each object.

| Plane | PostgreSQL schemas and objects | Exclusive desired-state owner | Evidence owner |
|---|---|---|---|
| Kernel | `platform`, `north_star_internal`, and every checked-in kernel function, role, grant, policy, table, index, constraint, trigger, sequence, and default | the one ordered checked-in kernel migration stream | kernel migration ledger plus kernel snapshot verifier |
| Managed module | `north_star_module` and every compiler-mapped module table, column, index, constraint, policy, grant, ownership fact, function, trigger, sequence, and default | the content-hash-verified canonical release artifact reachable from a persisted release/receipt chain | materializer ledger and catalog, which are evidence only |

The schema sets are disjoint. A checked-in kernel migration cannot create or
alter managed-module business objects, and a compiled module transition cannot
create or alter kernel objects. Ledger or catalog rows never become semantic
desired-state authority.

One ordering discipline covers both producers. Kernel migrations and module
materialization take the same database-scoped advisory-lock namespace and
monotonic ordering key. A running operation finishes; queued kernel migration
work then has priority over new module preparations. A materialization queue
cannot continually reacquire the lock ahead of a waiting kernel migration.
Within module work, generation and transition element order are deterministic.
P2b must freeze the concrete lock key, timeout, retry, and starvation evidence.

Only `north_star_module_materializer` may execute managed-plane DDL or write its
execution ledger. It is structurally unreachable from Query/Operation
gateways, runtime pools, agent tools, policy evaluators, and trust callbacks.
Long backfills execute through a separately authorized tenant/environment
mutation path, not through the DDL role. `north_star_module_runtime` is
DML-only. Neither role, nor any application role, is superuser or has
`BYPASSRLS`.

### Versioned cross-plane provider ABI

`northstar.postgresql-module-provider-abi/v1` is the launch ABI between kernel
migrations and managed-module generations. While any module generation depends
on it, a kernel migration may not incompatibly change:

- `tenant_id` and `environment_id` as the leading columns of every primary
  key, unique key, foreign key, RLS predicate, and service scope;
- trusted-context functions
  `north_star_internal.trusted_tenant_id()` and
  `north_star_internal.trusted_environment_id()`;
- the materializer and runtime role identities and their separation;
- forced-RLS policy semantics; or
- the RLS/grant template: forced RLS, conjunctive trusted tenant and
  environment predicates, and only `SELECT`, `INSERT`, and `UPDATE` grants.

An ABI change requires a versioned kernel migration, new compiler/provider
support, coexistence proof for every depending live generation, and an
activation blocker for unsupported combinations.

### Canonical storage and representability

Every applicable active v1 entity declares a non-null `storageClass`.
`dedicatedTable` is the only supported launch class. A missing or null class
fails `COMPILER_STORAGE_CLASS_REQUIRED`. `generatedTyped` parses, normalizes,
and round-trips, then fails `COMPILER_GENERATED_STORAGE_UNSUPPORTED`.

Promotion is reserved only by capability ID
`northstar.storage:capability.promote-storage-class` and invariant
`northstar.storage-class-promotion-invariant/v1`: canonical identity and
gateway contracts survive promotion, the physical locator may change, and an
eventual dedicated name is deterministic from canonical identity. The reserve
round-trips and fails `COMPILER_STORAGE_PROMOTION_UNSUPPORTED`. V1 defines no
prepare, catch-up, dual-write, cutover, rollback, or other executable promotion
phase.

The compiled storage target derives record identity (`uuid`), optimistic
revision (`bigint`, initial value one), archive representation (nullable
`archived_at`, excluded by default), field defaults/read semantics,
tenant/environment-qualified uniqueness, case-insensitive normalization and
collation, restrict-only foreign-key actions, and search/index mappings.
Unsupported gaps fail compilation; runtime or provider code cannot invent
them.

### Physical mapping and naming

`northstar.physical-mapping/v1` owns PostgreSQL names. The compiler computes a
domain-separated SHA-256 digest over object kind and canonical identity,
encodes it as lowercase unpadded base32, and prefixes it with `nsm_t_`,
`nsm_c_`, `nsm_i_`, or `nsm_k_`. Every emitted identifier is explicit and at
most 63 UTF-8 bytes. Lowering is independent of authored collection order and
projection schedule.

The storage artifact persists reverse-mapping records containing canonical ID,
object kind, physical name, shape fingerprint, storage domain, and mapping
version. One physical name maps to one canonical object and compatible shape.
Collisions, identifiers over 63 bytes, and incompatible reuse fail stable
compiler diagnostics. Neither labels nor mutable slugs participate in naming.

`northstar.storage-target-payload/v1` freezes an exhaustive canonical field
type to PostgreSQL table:

| Canonical field type | PostgreSQL type |
|---|---|
| Boolean | `boolean` |
| Date | `date` |
| UTC instant, second/millisecond | `timestamp(0/3) with time zone` |
| Offset-preserving datetime, second/millisecond | `text` with compiled validation |
| Enum | `text` with compiled option validation |
| Exact decimal, money, quantity | `numeric(precision,scale)` |
| Canonical integer string | `numeric` |
| Text | `varchar(maximumLength)` |
| Local wall time, second/millisecond | `time(0/3) without time zone` |

Changing any row is a storage payload/version evolution, not provider choice.

### Transition envelope v1

`northstar.storage-transition-envelope/v1` supersedes the provisional
pairwise transition payload for the Freeze F profile. It is the only current
transition authority. Accepted G1 v0 artifacts remain byte-reproducible for
historical golden evidence, but their provisional transition payload is not
admitted as a Freeze F materialization or activation input.

The compiler remains hermetic and pairwise. `CompilerInput` contains at most
one verified `expectedActiveRelease`; it never contains a live-root union,
database handle, tenant record, activation pointer, or catalog observation.
The envelope binds exact from/to definition, release, storage artifact, and
semantic digests.

Each element has a closed kind, stable content-derived identity, declared
dependency element IDs, preparation validity, coexistence impact, semantic
effect, data effect, operational risk, physical object name, managed storage
domain/generation, and tenant/environment scope. Elements have one total
order: dependencies first, then element-ID code-unit order. Unknown kinds fail
closed.

The three classification axes are independent:

- semantic effect: `none`, `additive`, or `tightening`;
- data effect: `none`, `catalogOnly`, `rowMutation`, or `dataScan`; and
- operational risk: `none`, `boundedCatalogLock`,
  `onlineStrategyRequired`, or `longRunning`.

Preparation validity is independently `preApprovalInert`, `inAttemptOnly`,
`deferredOnlineFamily`, or `deferredTightening`. An index is pre-approval inert
only on an object introduced by that same plan. An index on an existing
populated table requires the deferred online-index family. `NOT VALID`
constraints already constrain new writes and therefore run in-attempt while
affected writers are live. Constraint validation and duplicate-detection scans
are data scans, never pre-approval inert. Retype and rename-as-add are
unsupported with distinct diagnostics.

### Compatibility and tightening

Every closed element kind carries explicit old-read, old-write, new-read, and
new-write compatibility. The v1 matrix is:

| Kind | Old read | Old write | New read | New write | Admission |
|---|---|---|---|---|---|
| Create table | not applicable | not applicable | compatible | compatible | additive |
| Add nullable/read-fallback column | compatible | compatible | requires fallback | compatible | additive |
| Index on a same-plan object | not applicable | not applicable | compatible | compatible | additive |
| Index on an existing object | compatible | compatible | compatible | compatible | deferred online family |
| Backfill | compatible | compatible | requires fallback | compatible | additive but in-attempt mutation |
| Add FK or `NOT VALID` constraint to an existing table | compatible | may reject | compatible | compatible | blocking while affected writers are live |
| Validate constraint or scan for duplicates | compatible | compatible | compatible | compatible | deferred tightening/data scan |
| Tighten `NOT NULL` | compatible | may reject | compatible | compatible | blocking while affected writers are live |

Required fields on an entity created by the same plan are storage `NOT NULL`
immediately and have coexistence impact `none`: no old writer exists. Required
semantics distinguish new-write-required from read-non-null. An
`old-writes-may-reject` cell is a blocker while any affected writer root is
live; it is not executable additive work.

Tightening scope comes from the physical table's actual reader/writer roots in
compiled releases, never package provenance or first-party lineage. Every
deferred tighten creates `northstar.tightening-debt/v1` with element ID,
blocking roots, owner, prerequisites, and admission consequence. Outstanding
debt blocks tenant-accessible module creation until the cleanup/tighten family
ships and the union of live roots is revalidated.

### Backfill admissibility

`northstar.backfill-admissibility/v1` permits a backfill element only when
every residual unbackfilled row is correct for new-release reads through a
declared default or coalesce-at-read rule. Completeness is never load-bearing
in v1. Backfills are tenant/environment-scoped, stable-key checkpointed,
idempotently reconcilable mutations with explicit old-writer race handling.
Any future storage constraint depending on completion belongs to the tighten
generation and revalidates completeness under the union of live roots.

### Versioned preparation extension of G1-P4b

The two-class protocol is a versioned extension, not a reinterpretation, of
the accepted G1-P4b activation contract. P2b/P2c must introduce
`northstar.transition-compatibility-policy/v2` and executor applied-state
evidence v2. V1 activation policy/evidence cannot accept this split.

Applied state is two-dimensional:

- schema elements may become catalog-verified `APPLIED` before approval only
  when classified `preApprovalInert`; and
- data elements remain `PENDING_IN_ATTEMPT` and execute and verify inside the
  uniquely claimed, human-approved activation attempt.

Preparation and pointer CAS remain separate transactions. Receipts bind the
exact pair, generation, prepared-subset digest, and remaining-plan digest. The
approval diff discloses per-element applied versus pending state. Immediately
before CAS, the materializer recomputes live-catalog state and emits one
`READY_TO_SWAP` receipt over both digests. That pre-CAS receipt gates CAS.

Post-swap module-schema verification is observational and cannot move the
pointer. Adding it to the accepted 0005 verification receipt requires a future
checked-in kernel migration, receipt/check-constraint version bump, and
`verification_version` bump; P2a does not alter 0005. Existing post-swap
verification remains pointer read-back, artifact availability, and kernel
invariants until that migration lands.

Preparation initiation is bound from day one to the existing 0005 persisted
executor-authority and release-activation-control event streams. Classification
answers what may run; those authority events answer who may cause it. A
compiler, author, gateway, or AI cannot initiate materialization by possession
of artifact bytes.

### Live-root validity and resource governance

The materializer, never the compiler, validates every prepared or executable
element against the union of live roots in an environment: active pointers plus
all non-terminal preparations. Element identity is the convergence key;
byte-identical elements CREATE-converge idempotently. A conflicting shape
fails closed.

The live closure is maintained incrementally with root-to-element membership
and generation-bound reference counts, plus periodic full-catalog
reconciliation. Prepared candidates have governed retention and expiry.
Suspending a tenant does not discard its live roots. Decommissioning requires
the separately governed lifecycle to prove no live request or recovery root
remains. Ancient-root tenants use an explicit migrate-or-isolate decision;
the materializer never silently removes an active root from the union.

Preparation has quotas for queued candidates, object count, catalog growth,
lock time, scan work, and tenant-scoped mutation work. Exceeding a quota pauses
or rejects preparation with evidence; it never weakens classification or lets
preparation starve kernel migrations.

### Accounted additive closure and provenance

Managed-module drift means accounted additive closure, not snapshot equality.
Every table, column, sequence, default, constraint, index, policy, function,
trigger, ownership fact, and grant in every non-system schema is covered by
exactly one object-level verifier. Unknown object kinds and zero or multiple
verifier ownership fail closed. Kernel snapshot equality explicitly covers
both `platform` and `north_star_internal`.

A managed surplus object is accounted only when expected shape is recomputed
from content-hash-verified artifact bytes reachable through a persisted
release or receipt chain. Materializer ledger shape columns are never trusted
as semantic proof. The materializer alone writes its ledger. Drift evidence
also reports outstanding tightening debt and the live roots that keep each
object admissible.

### Complete destruction rejection

The ordinary operation algebra exposes create, update, archive, and restore,
including the same lifecycle quartet for parent-scoped children. Delete,
purge, destroy, destructive renderer forms, and module-specific execution code
fail compilation. The storage renderer allowlist additionally rejects
`ON DELETE CASCADE`, delete-capable triggers or rules, `TRUNCATE`, partition
removal, and destructive DDL over business data. The grant template contains
no `DELETE`. A future retention purge requires its own ADR and capability.

### Compiler-derived module conformance

Applicability derives from canonical object kind, lifecycle, relation
ownership, field declarations, and compiler support status, not a package
author's projection list. Every applicable active entity, including a
parent-scoped child, must have:

- supported storage;
- Q0 get, list, search, and resolve;
- O0 create, update, archive, and restore;
- list, record, and form `SurfaceDefinition` roles;
- agent discovery/lazy contract coverage;
- a reporting projection with canonical lineage; and
- verification coverage.

The reporting family is a new projection family under projection
compatibility's `newFamilyOrPayloadVersion` rule.
`requiredProjectionFamily('reporting')` resolves to it. Search is introduced
only by canonical language `v1` with normalization profile
`northstar.normalization/v1`; `v0-experimental` is not silently widened.
Missing entity/family coverage fails a stable diagnostic naming both.

The runtime design remains one generic interpreter of compiled projections.
No module-specific Q0/O0 handler, SQL, route, tool, kernel branch, or registry
is emitted or admitted.

## Consequences

- P2a proves deterministic representability and compiler rejection only; it
  does not prove DDL, backfill, forced RLS, old/new serving, crash recovery, or
  activation.
- P2b owns materializer roles, ledgers, provider execution, locking, live-set
  reconciliation, drift verifiers, and PostgreSQL evidence.
- P2c owns the generic runtime interpreter, release-pinned Q0/O0 coexistence,
  same-DTO/trust journeys, and final Freeze F ratification evidence.
- A P2b/P2c defect may amend this candidate before any external module consumer
  exists. Any amendment produces new versioned bytes and fresh review.
- Online indexing, executable generated storage/promotion, destructive cleanup,
  multi-node coordination, and disaster-recovery drill remain deferred with
  typed unsupported status.

## Ratification protocol

ADR-0011 and Freeze F are candidates at G2-P2a. They become ratified only when
P2b proves the exact compiled candidate's storage mechanics and P2c proves the
same candidate through generic Query/Operation, trust, and two-tenant/two-root
coexistence journeys. P2a must not be cited as provider or runtime evidence.
