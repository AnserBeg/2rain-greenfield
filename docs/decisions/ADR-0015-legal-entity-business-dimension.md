# ADR-0015: Legal entity as a compiled business scoping dimension

Date: 2026-07-26
Status: accepted (orchestrator ruling, user-authorized 2026-07-26; the implementing packet is
the G3 stage cut, which must land the dimension before the first posted movement exists)
Tier: Critical (review per `review-tiers` when implemented)

## Context

The plan has exactly two scoping axes: tenant and environment. The words "legal entity" and
"company" appear nowhere in it. A real customer routinely operates two or more legal
entities under one subscription, needs stock and documents attributed to the right one, and
needs both per-entity and consolidated views.

This is a **one-way door**. Every business row this program writes before the dimension
exists is a row with no entity attribution, and plan §7.4 plus ADR-0010 forbid rewriting
business facts. Retrofitting the dimension after G3 means either an entity-less era that
every report must special-case forever, or a governed re-baseline of the whole record
estate. Deciding it now costs a column; deciding it after G3 costs a migration nobody can
prove.

The prior-art audit did not name this failure mode. It is recorded as **G2** in
[`prior-art-failure-modes.md`](../execution/prior-art-failure-modes.md).

## Decision

**Every entity family declares itself `entityOwned` or `tenantShared`. Every business record
of an `entityOwned` family carries a non-null owning legal-entity identifier from creation;
records of a `tenantShared` family carry no entity column.** The dimension is structural at
launch. Multi-entity *operations* — intercompany movement, cross-entity consolidation — are
not launch scope.

The per-family assignment and the default are the G3 cut's ruling, not this ADR's. What this
ADR fixes is that the declaration exists, is explicit, and is made before the first movement
posts — a shared customer or item master across two entities is an ordinary requirement, and
a design admitting only `entityOwned` would force duplicated masters.

### The dimension is business, not tenancy

This is the load-bearing distinction and it is binding.

`tenantId` and `environmentId` are **trust** boundaries: they come from authenticated
request context (ADR-0004), they lead every key and RLS predicate
(`northstar.postgresql-module-provider-abi/v1`), and no authorized caller may ever see
across them.

`legalEntityId` is a **business** dimension. It is:

- resolved from operation input or a declared default, never from ambient session state;
- carried on every business row as an ordinary compiled column;
- available to queries as a filter, grouping key, and reporting dimension; and
- restricted, where a tenant requires it, by **policy narrowing** — never by row-level
  security.

It is therefore **not** admitted to the provider ABI's leading key columns, the RLS
predicate, or the service-scope template. `northstar.postgresql-module-provider-abi/v1`
is unchanged by this ADR, and Freeze F, the PR-6 relation indexes, and the PR-6b folded
columns are unaffected.

The reason is not cost. Cross-entity consolidated reporting is an ordinary, authorized
business requirement, and **within this ABI's trust model** an entity predicate in RLS
forbids it by construction: ADR-0011 freezes a template of conjunctive *scalar* predicates
over trusted context, so entity-in-RLS means `legal_entity_id = <one value>`. A set-valued
grant would permit consolidation — but a set-valued grant is authorization, not isolation,
and authorization is the policy kernel's concern. Tenant and environment are per-request
scalar constants from authenticated context; a legal entity is resolved from operation
input or a declared default, and one authorized session legitimately spans several. They
are different kinds of thing, and modelling the second as the first would make the correct
answer unreachable only after the schema was frozen.

### Where the column comes from

`legalEntityId` is a **compiler-derived system column**, in the same class as record
identity, optimistic revision, and archive representation under ADR-0011's "Canonical
storage and representability". Package authors declare only their family's `entityOwned` or
`tenantShared` classification; within an `entityOwned` family they cannot rename, retype, or
suppress the column, and `tenantShared` is an explicit declared classification rather than
per-record omission. Emitting it changes
`northstar.storage-target-payload/v1` to **v2** under that ADR's own evolution rule; it
is not a canonical-language event, because nothing in the authored surface changes.

On an `entityOwned` family the column is `uuid`, `NOT NULL`, and references a first-party
`legal_entity` master record. It participates in tenant/environment-qualified uniqueness
wherever a business key is entity-scoped. A `tenantShared` family emits no such column.

### The master record

`legal_entity` is an ordinary declarative module authored exactly like Catalog and
Location — no press changes, no kernel branch. It carries stable id, code, name, status,
and the tenant's declared default-entity flag. Every tenant is provisioned with exactly
one entity at creation, so the single-entity customer never sees the concept.

### Operation and query contract

- O0 create resolves the owning entity from explicit input or the tenant's declared
  default, records it, and returns it in read-back. It is immutable after create;
  moving a record between entities is a named correcting operation, never an update.
- Q0 exposes entity as a filter and a returned field. Cross-entity reads are permitted
  by default and narrowed by policy where a tenant requires it.
- Archived entities cannot be selected for new work and remain visible on historical
  records, per plan §6.4 invariant 10.

### Relationship to stock identity

`legalEntityId` is the first member of the launch stock-dimension set defined by
[ADR-0016](ADR-0016-stock-identity-dimension-set.md). Inventory balances are keyed by
entity from the first posted movement. The two ADRs are one decision expressed at two
altitudes and must be read together.

## Consequences

- Multi-entity support becomes a capability addition over an existing dimension rather
  than a schema event. That is the whole point.
- Intercompany movement is expressible later as a balanced pair of movements across two
  entity values, using the transfer mechanics G3 already builds.
- Cost is real and is not hidden: a storage-target payload version bump, a system column
  on every business table, an entity argument through O0 and read-back, a first-party
  master module, and tenant provisioning of a default entity. This is bigger than the
  seam-reservation alternative that was offered and rejected.
- The G3 stage cut inherits a hard sequencing constraint: **the dimension must exist
  before the first movement is posted.** After that, this ADR is unimplementable as
  written and only a governed re-baseline remains.
- Policy narrowing by entity is a dependency on the identity/policy kernel, which is
  presently an allow-all stub returning only `ALLOW`/`DENY` with no row-scope predicate or
  allowed-entity set. Until it gains one, entity is recorded and queryable but **not
  enforceable**, and the boundary this ADR draws is therefore incomplete rather than
  merely unimplemented. Multi-entity narrowing must not be offered to a tenant before that
  contract exists.
- **ABI v1 provides no database-enforced legal-entity boundary inside one tenant.**
  Separate tenants give database-enforced row isolation but cannot use current Q0/Q1 for
  consolidation. Neither option provides *physical* storage separation — the settled
  topology is pooled shared tables — and neither foreclosure is logical rather than
  contingent: a set-valued entity predicate could enforce row authorization while
  permitting a privileged consolidator, and a governed cross-tenant reporting plane could
  exist later. Both are future topology and capability decisions, deliberately not taken
  here. What this ADR fixes is that entity restriction is authorization, evaluated by the
  policy kernel, rather than isolation baked into the ABI.
- **Entity ownership per family is declared, and the per-family assignment is G3's.** An
  earlier draft of this ADR required a non-null entity on *every* business record and then
  recorded a consequence contradicting it; the Decision text above now carries the
  `entityOwned`/`tenantShared` classification directly, so no reader has to reconcile two
  operative rules. G3 rules the assignment and the default, not the sentence.
- **Relations need declared cross-entity semantics.** Generated foreign keys constrain
  tenant, environment, and record identity only; carrying `legal_entity_id` on both rows
  does not prevent an entity-A document referencing an entity-B record. Each relation
  declares `sameEntity` or `crossEntityAllowed`, enforced at write.

## Evidence

- Plan §1 authority table, §5.2 reserved seams, §6.1-6.4, §7.1-7.2, §11.6.
- ADR-0011 `northstar.postgresql-module-provider-abi/v1` leading-column freeze and
  `northstar.storage-target-payload/v1` evolution rule.
- ADR-0004 trusted request context: the reason entity cannot be sourced from session
  state.
- [`prior-art-failure-modes.md`](../execution/prior-art-failure-modes.md) **G2**.
- G2-P6 and G2-P7 established that a master-data module is authorable with zero press
  changes, which is why `legal_entity` is scoped as a module rather than a kernel object.

## Enforcement

- Compiler: every active entity in an `entityOwned` family emits `legalEntityId`; a package
  that omits its family classification, or that renames or retypes the column, fails a
  stable diagnostic. Storage-target payload version is asserted in the golden artifacts.
- Provider: `NOT NULL` and foreign-key constraints on `entityOwned` families; a row of such
  a family without a resolvable entity fails closed at posting, never defaulting silently to
  a sentinel. `tenantShared` rows have no entity column and the check does not apply.
- Structural test: no RLS policy and no ABI-frozen key includes `legalEntityId`, so the
  business-versus-tenancy distinction is executable rather than prose.
- G3 gate: balances, availability, and movement history are entity-keyed, and a two-entity
  fixture exists alongside the two-tenant fixture required by plan §7.2.
