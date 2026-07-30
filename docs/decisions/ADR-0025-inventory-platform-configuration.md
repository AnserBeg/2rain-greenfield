# ADR-0025: Inventory temporal and posting configuration in the platform plane

Date: 2026-07-29
Status: **ratified** — accepted with packet G3-P2b-1 on 2026-07-29 (see `docs/execution/ledger.md`)
Tier: Critical (review per `review-tiers`)

## Context

ADR-0011 gives canonical releases exclusive desired-state authority over
ordinary module persistence. ADR-0023 admits platform persistence only through
an explicit capability decision and forbids it from becoming an alternate path
for business entities that the generic press can represent.

The inventory storage-plane verdict consequently places legal entities,
transaction headers and lines, movements and their effect-identity companion,
and period locks in `north_star_module`. Two records do not fit that plane:

- a tenant's IANA time zone and business-day boundary are provisioning inputs
  keyed by tenant alone, while every managed-module key is tenant/environment;
- posting configuration pins a contract release root and typed governance dials
  consumed by the posting protocol, rather than describing a Q0/O0 business
  record or a tenant-customizable entity.

Leaving either classification implicit would weaken ADR-0023 into a general
platform-table escape. Moving either into a managed module would instead invent
decorative environment/entity ownership for the tenant calendar or expose
posting-kernel configuration as ordinary record CRUD.

## Decision

`platform.inventory_tenant_calendars` and
`platform.inventory_posting_configurations` are accepted platform-plane
capabilities owned exclusively by ordered migration 0015.

The calendar stores one required IANA zone and business-day boundary per tenant.
It has no UTC fallback. The ABI function
`north_star_internal.inventory_business_period(tenant_id, effective_at)` is the
only storage-check entry point and rejects absent calendars and forged runtime
tenant scope.

Posting configuration stores the complete typed G3-P1a dial set per tenant,
environment and legal entity together with the contract release root and a
monotonic revision. Missing configuration is a typed failure; neither the SQL
loader nor provider supplies ambient defaults. Its legal-entity identifier is a
reference value validated by the posting/provisioning protocol, not a second
legal-entity master. The ordinary compiled `legal_entity` entity remains the
only master and the only target of entity-owned managed-table foreign keys.

Both platform tables use real UUID tenant scope, forced RLS, least-privilege
grants and trusted-context predicates. They expose no direct HTTP route, agent
tool, generic module interpreter path, or alternative movement writer.

## Boundaries

This ADR does not admit any inventory business record into `platform`, choose a
per-stock serializer, add a posting path, or authorize reservations. New
inventory platform persistence requires another accepted ADR; similarity to
these two tables is not authorization.

Checked-in migrations may create and evolve only the two platform tables and
their ABI functions. They may not inspect release payloads and may never issue
DDL against `north_star_module`. Conversely, the module materializer may read
the scoped posting configuration while provisioning the compiled default legal
entity, but it does not own or mutate either platform table.

## Consequences

- Fourteen inventory relations remain compiler/materializer desired state and
  are reachable through the sanctioned generic module read path.
- The tenant calendar can remain tenant-only without weakening the managed
  module ABI.
- Posting configuration stays release-recorded and fail-closed without becoming
  an ordinary CRUD entity.
- The platform exception is closed, reviewable and independently removable; it
  cannot silently grow with later inventory features.

## Verification

G3-P2b-1 proves that a fresh migration creates exactly these two inventory
platform relations, that every compiled inventory business relation is absent
from `platform`, and that no migration statement mutates `north_star_module`.
Provider evidence proves the compiled legal-entity master and entity-owned
foreign keys live in the managed plane, while configuration and calendar reads
remain tenant-isolated and typed.
