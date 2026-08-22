# ADR-0028: Issued legal-entity read scope

Date: 2026-07-30
Status: **ratified** 2026-08-21 — Q1-P4 is accepted (ledger; reviewed `29ba2aef`,
integrated `bf098a90`), completing the condition this ADR set for itself. (Status
corrected by the orchestrator's 2026-08-21 record sweep, disposing program review R1,
which found the condition met and the text stale.)
Tier: Critical security-scope decision (review per `review-tiers`)

## Context

ADR-0015 makes legal entity a compiled business dimension, not a tenant or
environment trust boundary. An authorized request may read one entity or a set
for consolidated reporting. The compiler already exposes that distinction on
each `StorageEntityTarget`: `legalEntity` exists exactly for `entityOwned`
storage and is absent for `tenantShared` storage.

The generic query provider did not consume that marker. Its row-set contract
was the six-part enumeration in ADR-0022: tenant, environment, archive, policy,
compiled query filter, and effective time. An entity-owned aggregate could
therefore combine two legal entities inside one tenant. Supplying no entity as
SQL `NULL` is not a safe repair: `legal_entity_id = NULL` returns no rows, after
which `COALESCE(SUM(...), 0)` returns a plausible but false zero.

No canonical query spelling is required to prevent that wrong answer. The
family-map precedent transfers to reads: the missing authority is trusted scope
issuance, while compiler representability already exists.

## Decision

### The read scope is a versioned issued capability

`northstar.legal-entity-read-scope/v1` is an immutable capability containing:

- a nonempty, de-duplicated and canonically ordered set of legal-entity UUIDs;
- the policy version that authorized the set;
- the request identifier; and
- the scope schema version.

The issuer evaluates
`northstar.runtime:permission.legal-entity-read-scope` independently for every
set member using
`northstar.legal-entity-read-scope-policy-input/v1`. One denial refuses the
whole requested set. A policy-version change during issuance also refuses the
set. Empty sets and malformed identifiers never issue.

Visible fields are evidence, not the seal. Runtime retains the issued object in
a private `WeakMap` bound to the exact issued `RequestRuntimeView`. Copying the
object, replacing an identifier, constructing the same fields, or presenting a
capability on another request/view fails integrity validation. A later version
may add fields or change issuance semantics only under a new scope schema and
policy-input version; v1 is closed by its validator.

The capability is passed explicitly through `SemanticQueryGateway` execution
context. It is not derived from query arguments. Tenant and environment remain
the only ambient data-scope axes in the PostgreSQL transaction. No PostgreSQL
GUC, `trusted_legal_entity_id()` function, RLS policy, or third session identity
axis is added.

### Compiler storage metadata is the only dispatch key

After loading and verifying the pinned storage target, the generic PostgreSQL
interpreter examines only `StorageEntityTarget.legalEntity`. It does not inspect
module IDs, entity IDs, names, or the Inventory family map.

If the primary source or any joined alias carries that descriptor, execution
requires a valid issued capability for the same request/view. Before constructing
the business SQL, the provider reads the single compiled legal-entity master
under forced tenant/environment RLS and verifies that every selected UUID is
tenant-visible. Missing, forged, policy-denied, and nonexistent scope therefore
produce typed refusal rather than zero rows.

Only after verification does the provider lower
`legal_entity_id = ANY($n::uuid[])`. The primary source receives that mandatory
predicate, and each entity-owned joined alias receives the same restriction in
its join condition. A tenant-shared source or alias has no descriptor and is
unchanged. Archive state does not invalidate historical entity selection: an
archived but tenant-visible legal entity may still scope historical reads.

Saved-filter-owned reads use only `platform.saved_master_filters`, outside the
compiled module-storage plane, and therefore cannot directly reach an
entity-owned source. For every other registered query,
`PostgresSavedFilterExecutor` forwards the exact execution request to the
generic interpreter; it neither drops nor reconstructs the capability.

### This narrows ADR-0022's provider row set

This security-scope decision narrows ADR-0022 without editing it. For every
entity-owned source, its provider-row-set enumeration now includes a mandatory
seventh conjunction: the verified legal-entity set. The earlier tenant,
environment, archive, policy, compiled filter, and effective-time restrictions
remain independent and cannot replace it. Entity selection occurs before
aggregation, list counting, paging, matching, resolution, or record loading.

An authorized nonempty set is deliberate. A scalar-only capability would make
ADR-0015's ordinary cross-entity consolidated reporting unreachable. Consumers
may impose a stricter cardinality contract: the future `onHand` query requires
exactly one authorized entity. Omitted scope never means all entities.

### Current authorization posture is allow-all

The production `AllowAllLocalPolicy` and verification
`VerificationAllowPolicy` implementations currently return `ALLOW`. This v1
mechanism therefore guarantees correct explicit entity selection, capability
integrity, and tenant membership; it does **not** yet guarantee a tenant's
restrictive per-entity entitlement. That limitation is intentional and visible.
Real entity restriction remains blocked on the identity/policy kernel in plan
row 7, as ADR-0015 already records. This ADR does not imply that the allow-all
implementations enforce permissions they do not have.

## Deliberately unauthorized canonical spellings

This decision authorizes no canonical language change. In particular, it does
not ship:

- per-query opt-in or opt-out of legal-entity scope;
- a returned legal-entity system field;
- grouping by legal entity; or
- any authored predicate reference to the compiler-owned legal-entity column.

Those are canonical spellings deferred to a future whole-language version
event. They may not be added privately to a provider, catalog, or request
argument. The execution-context capability narrows compiled storage; it is not
a second query language.

## Behavior change and consequences

Inventory is the first declared consumer but is not named by the mechanism.
Its Q0 get/list/search/resolve reads for `inventory_transaction`,
`inventory_transaction_line`, `inventory_period_lock`, and
`inventory_movement` change from tenant-wide reads to scope-required reads.
Inventory is not mounted in the accepted composed application, so this is not a
current user-visible regression, but it is a real semantic change owned by
Q1-P4. G3-P5 authors `onHand` against this mechanism and must require exactly
one entity.

Tenant-shared entities remain callable without a scope. Cross-entity reporting
remains representable by an authorized set. A caller cannot turn omission into
all, a false zero, or a caller-chosen identifier. Joined labels cannot disclose
another entity even if inconsistent historical data defeats a same-entity
write constraint.

No checked-in release artifact, storage payload, canonical digest, golden, or
root changes: the compiler-owned `legalEntity` descriptor was already present
and sufficient. The PostgreSQL control compiles a test-only aggregate probe and
therefore creates its own ephemeral test release; it replaces no recorded root.

## Enforcement and evidence

- Runtime controls prove nonempty-set issuance, per-member policy evaluation,
  object/view binding, copied-capability refusal, and policy denial.
- Provider controls use two entities with the same item/location. Scoped totals
  are `5` and `7`; a consolidated set returns `12`, which is also the explicit
  unscoped defect value.
- Omitting scope from that aggregate must return
  `MODULE_LEGAL_ENTITY_READ_SCOPE_REQUIRED`; returning zero is a failed control.
- An issued nonexistent UUID returns
  `MODULE_LEGAL_ENTITY_READ_SCOPE_NOT_FOUND` before business SQL.
- A corrupted cross-entity relation proves the joined alias condition is
  independently load-bearing.
- A synthetic non-Inventory entity carrying the compiler descriptor receives
  the same requirement, while a synthetic tenant-shared entity receives none.
- Architecture controls bind saved-filter forwarding, prohibit a legal-entity
  GUC, and mutation-check the load-bearing dispatch lines.
