# G2-P2 storage-topology debate — converged verdict (2026-07-22)

Pipeline: position-v1 -> two independent naive round-1 reviews (Codex
gpt-5.6-sol xhigh; Fable max) -> orchestrator adjudication -> position-v2 ->
two independent naive confirm reviews (fresh Codex xhigh; fresh Fable max).
All four reviews: SOUND-WITH-AMENDMENTS. No reviewer found the foundation
wrong; the confirm round validated the amended shape and both parent rulings
in substance while correcting their formulation. The debate is CLOSED. This
document is the binding input to ADR-0011 and the G2-P2a contract; the packet
writer follows it and does not relitigate it.

## Ratified foundation (not reopenable in G2-P2)

R1. GENERIC INTERPRETER. Q0/O0 are served by one generic platform interpreter
    reading the pinned release's compiled projections. Registration is data,
    never emitted per-module handler code. Module packages contain zero
    hand-written SQL or Q0/O0 handlers; a dependency-boundary rule forbids
    `pg`/SQL in `packages/domain/**`; only the platform's generic
    compiled-plan executor touches module tables. The fixture is a definition
    compiled at test time, served end-to-end with no emitted per-module code.
R2. EXCLUSIVE-OWNERSHIP AUTHORITY MODEL. Two desired-state authorities with
    exclusive, non-overlapping object ownership: checked-in kernel migrations
    own the platform plane; the canonical release is the SOLE desired-state
    authority for the managed module plane (disjoint PostgreSQL schema). One
    materialization discipline: one ordering/advisory-lock discipline shared
    with the kernel migration lock (with an explicit starvation rule so a
    preparation queue cannot indefinitely block kernel migrations), one
    isolated DDL-capable materializer role structurally unreachable from
    gateways and trust callbacks (runtime role stays DML-only; no role is
    superuser or BYPASSRLS), one execution ledger per producer under one
    ordering discipline. Ledger and catalog are execution evidence, never
    semantic authorities.
R3. DEDICATED TABLES NOW; GENERATED/PROMOTION RESERVED BY REPRESENTABILITY.
    Dedicated typed tables for launch master data; tenant_id AND
    environment_id in every PK, unique key, FK, RLS predicate, and service
    scope; forced RLS; SELECT/INSERT/UPDATE grants only. storageClass non-null
    at compile time. Generated storage and promotion are reserved at
    CAPABILITY-ID level with frozen invariants (canonical identity and
    gateway contracts survive promotion; physical locator may change;
    eventual dedicated name deterministic from canonical identity) and typed
    UNSUPPORTED diagnostics — NOT as concrete executable payloads; promotion
    phase topology (prepare/catch-up/cutover/rollback) is explicitly unproven
    and deferred.
R4. ADDITIVE COEXISTENCE with a frozen old-read/old-write/new-read/new-write
    compatibility matrix; two-phase tightening; retype/rename-as-add
    UNSUPPORTED in v1 with typed diagnostics.
R5. LIVE-SET VALIDITY: preparation validity and drift verification check the
    union of live roots in the environment (active pointers + non-terminal
    preparations); element identity is the convergence key; byte-identical
    elements CREATE-converge idempotently.
R6. DRIFT = ACCOUNTED ADDITIVE CLOSURE over the managed namespace; kernel
    tables keep snapshot equality.
R7. TWO-CLASS PREPARATION (both confirm reviewers upheld): pre-approval
    preparation of genuinely inert schema elements composes with ADR-0006
    (candidate preparation is not activation; ADR-0006 explicitly permits
    non-humans to prepare candidates and evidence); data-mutating elements
    execute only inside the claimed, human-approved activation attempt.
    Preparation and CAS remain separate transactions.
R8. COMPILER-DERIVED CONFORMANCE with per-entity cross-projection coverage
    and a metamorphic definition-only fixture test.
R9. THREE SERIAL SUBPACKETS (P2a contract, P2b materializer, P2c generic
    runtime + fixture); Party starts only after all three integrate.
    Freeze F is RATIFIED only at the end of P2c: P2a produces a versioned
    contract CANDIDATE, P2b proves its storage mechanics, P2c proves the same
    candidate through generic Q0/O0 and trust journeys; a defect found in
    P2b/P2c amends the candidate inside the packet, before any external
    consumer exists.

## Binding amendments (consolidated from the confirm round)

A1. VERSIONED PHASE-SPLIT ACTIVATION CONTRACT (both reviewers, identical
    finding). The two-class split structurally requires
    TRANSITION_COMPATIBILITY_POLICY v2 and executor-evidence v2: a
    two-dimensional applied state (schema elements: catalog-verified APPLIED,
    permissible pre-approval; data elements: PENDING_IN_ATTEMPT, executed and
    verified inside the claimed attempt), receipts carrying prepared-subset
    digest + remaining-plan digest, and a final READY_TO_SWAP live-catalog
    receipt that gates CAS. Post-swap verification gains module-schema
    conformance via a kernel migration + verification_version bump (the 0005
    receipt CHECK constraint closes the check set; versioned extension is the
    sanctioned path). State plainly in ADR-0011 that this is a versioned
    extension of the G1-P4b contract. Post-swap verification is
    observational; the pre-CAS readiness receipt is the gate.
A2. REFINED ELEMENT CLASSIFICATION. Replace the binary inert/data split with
    three independent axes: semantic effect, data effect, operational risk.
    Concrete rulings: an index is pre-approval-inert ONLY on objects
    introduced by the same plan; index builds on existing populated tables
    belong to the deferred online-index family; ADD CONSTRAINT ... NOT VALID
    constrains new writes and is classified accordingly; data-scanning
    VALIDATE (and duplicate-detection scans) are never pre-approval — they
    run in-attempt or in the tighten family; long backfills are tenant-scoped
    mutations with stable-key checkpoints, idempotent reconciliation, and
    old-writer race handling, executed under trusted tenant/environment
    scope (not the DDL role). The rendered approval diff must disclose
    per-element applied-vs-pending state so the human never approves
    already-executed DDL described as future work.
A3. BACKFILL ADMISSIBILITY INVARIANT (v1). An element with a backfill is
    admissible only if new-release reads are correct with residual
    un-backfilled rows (default/coalesce-at-read semantics). Backfill
    completeness is never load-bearing in v1; the future tighten generation
    revalidates completeness under the union of live roots before any
    storage-level constraint depends on it.
A4. CONSTRAINT PARITY FOR ALL MODULES + NEW-ENTITY CARVE-OUT. Required
    fields on entities NEW in the same plan are storage NOT NULL at creation
    (impact class `none`) — no old writers exist, so launch columns (Party
    number, Catalog SKU) get real constraints immediately. Tightening scope
    is defined by the physical table's actual consumer/writer set — never
    "first-party lineage" (which would make custom modules permanently
    second-class). `old-writes-may-reject` is a BLOCKING class while affected
    writers are live, not an executable additive class. Required-ness
    distinguishes new-write-required from read-non-null.
A5. TIGHTENING-DEBT FORCING FUNCTION. Every deferred-tighten element creates
    a first-class ledger `tighteningDebt` row (blocking roots, owner,
    prerequisites, admission consequence), surfaced in the drift/conformance
    report. Shipping the cleanup/tighten family is an admission requirement
    before tenant-accessible module creation (same bar as catalog-pressure
    quotas).
A6. OBJECT-LEVEL GATE COMPLETENESS + PROVENANCE BY RECOMPUTATION. Coverage is
    object-level, not schema-level: every object of every kind (tables,
    columns, sequences, defaults, constraints, indexes, policies, functions,
    triggers, ownership, grants) in every non-system schema is covered by
    exactly one verifier; unknown object kinds fail closed; the
    `north_star_internal` schema (kernel migration ledger — invisible to
    every verifier today, snapshot covers ["platform"] only) is explicitly
    named into kernel snapshot scope. A surplus element is accounted ONLY
    when its expected shape is recomputed from content-hash-verified
    artifact bytes reachable from a persisted release/receipt chain — ledger
    row shape-columns are never trusted (defeats provenance laundering by a
    buggy materializer). Ledger tables are writable only by the materializer
    role. A versioned cross-plane provider ABI (tenant/environment keys,
    trusted-context functions, roles, RLS templates) that kernel migrations
    may not break while any module generation depends on it.
A7. SUPERSEDE THE EXISTING TRANSITION PAYLOAD; COMPILER STAYS PAIRWISE. The
    compiler ALREADY emits a v0-provisional `storageTransitionPayload` with
    pairwise from:to scope (compiler.ts ~1001-1027) — P2a versions/supersedes
    that existing lineage; it does not freeze a new envelope beside a live
    one. The compiler remains hermetic and pairwise
    (CompilerInput.expectedActiveRelease); the union-of-live-roots check
    lives ONLY in the materializer; union-shaped CompilerInput is forbidden
    (it would destroy content-addressing).
A8. FROZEN OUTPUT-CONTRACT DELTAS NAMED IN P2a. The new reporting projection
    family (`requiredProjectionFamily('reporting')` is null today and a
    supported capability declaring it fails completeness) is added via the
    sanctioned newFamilyOrPayloadVersion path and named in the freeze list.
    Adding `search` to the queryType enum is a language/normalization-profile
    version bump, not a silent widening. Mandatory projections derive from
    canonical object kind/lifecycle/support status, not the author-declared
    list.
A9. FIXTURE SCOPE. The mandatory fixture includes: a parent-scoped child
    (party_role-shaped) with storage-level cross-tenant composite-FK
    rejection proven at the RLS/provider layer; tenant-qualified uniqueness;
    a relation; archive lifecycle; a v1->v2 optional-field transition applied
    physically with old/new release-pinned requests coexisting; and the
    two-tenant/two-root/one-shared-table scenario. The O0 conformance quartet
    includes parent-scoped child lifecycle.
A10. COMPLETE DESTRUCTION-PATH REJECTION. No-DELETE-grant is insufficient:
    the DDL renderer allowlist and drift verifier must also reject ON DELETE
    CASCADE, delete-capable triggers/rules, TRUNCATE, partition removal, and
    destructive materializer DDL on business data.
A11. PREPARATION INITIATION AUTHORITY + RESOURCE GOVERNANCE. Bind preparation
    initiation to the existing executor/control-authority events (0005) from
    day one — WHAT may run pre-approval is constrained by A2, WHO may cause
    it is constrained here. Live-root closure is materialized incrementally
    (root-to-element membership + generation-bound reference counts) with
    periodic full-catalog reconciliation; define prepared-candidate
    retention/expiry, suspended/decommissioned-tenant semantics, and a
    governed migrate/isolate path for ancient-root tenants (never silently
    dropping an active root from the union).
A12. STORAGE-CONTRACT COMPLETENESS BEFORE RATIFICATION. Before Freeze F is
    ratified (end of P2c), the compiled storage/query contract carries the
    derived infrastructure Party/Catalog/Location need or a typed
    UNSUPPORTED: record identity, optimistic revision, archive
    representation, defaults, normalized/case-insensitive business-key
    uniqueness, collation, FK referential actions (restrict-only in v1), and
    search/index mapping.

## Deferred with typed diagnostics (unchanged)

Generated-storage and promotion execution; dual-write/cutover; destructive/
retire cleanup generations (the tighten family is the FIRST claimant and an
admission requirement per A5); online-index strategies; per-entity
catalog-pressure quotas; multi-node coordination; DR restore drill (ledger +
every referenced compiled artifact, including prepared-but-never-active
transitions, are retained so a restored catalog is explainable — the drill
itself is later).

## What ADR-0011 must contain

The exclusive-ownership authority model (R2) with the object-ownership map
and provider ABI; the transition envelope v1 superseding the v0-provisional
payload (A7); the physical-mapping/naming contract (R3/F4 of position-v2);
the compatibility matrix with the A2 classification axes and A4 carve-outs;
the two-class preparation protocol as a versioned extension of G1-P4b (A1);
the backfill admissibility invariant (A3); the accounted-closure drift
definition with recomputation-based provenance (A6); the live-set validity
rule and its materializer-side home (R5/A7); the tightening-debt mechanism
(A5); the destruction-path rejection list (A10); and the ratification
protocol (candidate at P2a, ratified after P2c — R9).
